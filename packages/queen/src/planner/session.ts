import { randomUUID } from "node:crypto";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationState {
  sessionId: string;
  customerId: string;
  /**
   * Who this conversation belongs to, when the intake knew.
   *
   * On the session rather than passed per turn, because it is the only thing that
   * can decide whether a `GET /sessions/:id` is the owner asking. Session ids are
   * eight hex characters, which is a fine handle and a poor secret.
   */
  userId?: string;
  messages: ChatMessage[];
  /** local planner task key -> hive taskId, for reconnect and display */
  taskKeys: Record<string, string>;
  /**
   * The hive taskId of the last task this conversation completed, so the next
   * turn can ask to continue it. Written by the planner, read by nothing else;
   * the Queen decides whether the continuation is actually honored.
   */
  lastTaskId?: string;
  /** when this conversation was last read or written, for eviction */
  lastTouched: number;
}

/**
 * How long an idle conversation is kept, and how many are kept at once.
 *
 * A conversation holds the full transcript, so this is the map that grows with
 * how much people talk to the Queen rather than with how big the hive is. An
 * hour is chosen against what it is for: long enough that stepping away from a
 * chat and coming back still resumes, short enough that a day of traffic does
 * not accumulate.
 */
const SESSION_TTL_MS = Number(process.env.HIVE_SESSION_TTL_MS ?? 60 * 60_000);
const SESSION_MAX = Number(process.env.HIVE_SESSION_MAX ?? 200);

/**
 * In-memory conversation store, bounded by age and by count.
 *
 * Still in-memory, and still the wrong place for this in production — but no
 * longer a map that only grows. Eviction is least-recently-touched, and reading
 * a conversation counts as touching it, so an open chat is never evicted out
 * from under the person having it.
 */
export class SessionStore {
  private sessions = new Map<string, ConversationState>();

  constructor(
    private readonly ttlMs = SESSION_TTL_MS,
    private readonly max = SESSION_MAX,
    private readonly now: () => number = () => Date.now(),
  ) {}

  getOrCreate(sessionId: string | undefined, customerId: string, userId?: string): ConversationState {
    if (sessionId) {
      const existing = this.get(sessionId);
      // Whoever created it owns it. Reusing an id must not let a second caller
      // adopt the first's conversation, and must not rewrite whose it is.
      if (existing) return existing;
    }
    const id = sessionId ?? randomUUID().slice(0, 8);
    const state: ConversationState = {
      sessionId: id,
      customerId,
      userId,
      messages: [],
      taskKeys: {},
      lastTouched: this.now(),
    };
    this.sessions.set(id, state);
    this.evict();
    return state;
  }

  get(sessionId: string): ConversationState | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    if (this.now() - state.lastTouched > this.ttlMs) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    state.lastTouched = this.now();
    // Re-insert so Map iteration order is least-recently-touched first, which is
    // what makes the count cap below evict the right one.
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, state);
    return state;
  }

  /** Bound by age, then by count. Exposed so its test drives it directly. */
  evict(now = this.now()): number {
    let dropped = 0;
    for (const [id, state] of this.sessions) {
      if (now - state.lastTouched <= this.ttlMs) continue;
      this.sessions.delete(id);
      dropped += 1;
    }
    while (this.sessions.size > this.max) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
      dropped += 1;
    }
    return dropped;
  }

  /** for tests and diagnostics */
  get size(): number {
    return this.sessions.size;
  }
}

/**
 * How much conversation the planner model is shown per turn.
 *
 * A character budget rather than a turn count, matching how
 * HIVE_MEMORY_BUDGET_CHARS bounds recalled memory: what costs money is
 * characters, and one long paste is worth more than ten short turns.
 */
const SESSION_WINDOW_CHARS = Number(process.env.HIVE_SESSION_WINDOW_CHARS ?? 6000);

/**
 * The slice of a conversation that goes to the model.
 *
 * The whole transcript used to be replayed on every turn, so turn N sent 2N−1
 * messages. On the escalation path — the only planner call that spends real
 * money — that is the largest live cost in the hive, and it grows with how
 * chatty the session has been rather than with how hard the request is.
 *
 * Two things are always kept: the FIRST user message, because it carries the
 * original intent and dropping it makes a long session forget what it was for,
 * and as many of the most recent turns as fit. The middle is what goes. The full
 * transcript stays in ConversationState — GET /sessions/:id and the console both
 * want it; only the model call is windowed.
 */
export function windowMessages(messages: ChatMessage[], budgetChars = SESSION_WINDOW_CHARS): ChatMessage[] {
  const cost = (m: ChatMessage) => m.content.length;
  const total = messages.reduce((n, m) => n + cost(m), 0);
  if (total <= budgetChars) return messages;

  const first = messages[0];
  // The first message alone can exceed the budget (a long opening paste). Send
  // it anyway: a turn with no user message at all is worse than an over-budget
  // one, and truncating the intent silently changes what was asked.
  let spent = cost(first);
  const tail: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    const next = cost(messages[i]);
    if (spent + next > budgetChars) break;
    spent += next;
    tail.unshift(messages[i]);
  }
  // Always carry the latest turn, even if it alone blows the budget — it is the
  // request being answered, and a plan made without it would be nonsense.
  const latest = messages[messages.length - 1];
  if (tail.length === 0 && latest !== first) tail.push(latest);
  return [first, ...tail];
}
