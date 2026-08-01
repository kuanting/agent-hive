import type { CapabilitySelector, Difficulty, Passthrough, TaskResult, TaskSpec } from "@hive/shared";

/**
 * Where the Queen's job state lives.
 *
 * Everything the Queen knows about a task used to sit in two `Map`s on
 * `QueenCore`, unbounded, with no way to hand them to anything else. This
 * interface is that state named: the operations the core actually performs, and
 * nothing more. `InMemoryJobStore` below is today's behavior moved verbatim,
 * plus the eviction the maps never had.
 *
 * The point of the boundary is not to swap in Redis tomorrow — see the note in
 * `core.ts` on what deliberately stays in the process. It is that the shape of
 * the state is now written down, so the decision about where it lives is a
 * decision instead of a rewrite.
 */

export interface TaskState {
  taskId: string;
  spec: TaskSpec;
  difficulty: Difficulty;
  /**
   * The capability the caller named, when they named one.
   *
   * Kept on the state rather than passed along, because `dispatch` is re-entered
   * from three places the original call has no reach into — the defer timer, the
   * reaper's redispatch, and an escalation retry. A requirement that survived
   * only the first dispatch would quietly evaporate on the retry, which is the
   * attempt most likely to land somewhere the caller did not ask for.
   */
  requirement?: CapabilitySelector;
  /** the caller's own conversation, when this task is a turn in their agent loop */
  passthrough?: Passthrough;
  status: "dispatched" | "deferred" | "done" | "failed";
  /** executions actually attempted; what MAX_ATTEMPTS bounds */
  attempts: number;
  /** times this task waited for a seat window instead of being dispatched */
  deferrals: number;
  reason: string;
  result?: TaskResult;
  /**
   * Every execution's result, oldest first — including the failed ones `result`
   * overwrites.
   *
   * `result` holds only the last attempt, which is the one the caller wants and
   * the wrong one to learn from: "failed at tier 3, then succeeded at tier 1" is
   * a labelled example that `scoreDifficulty` under-rated the task, and keeping
   * only the success erases exactly the transition worth recording. Bounded by
   * MAX_ATTEMPTS, so this cannot grow.
   */
  history?: TaskResult[];
  /** when the task entered the hive, so "how long has this been going" needs no second endpoint */
  startedAt: number;
  /** when the current attempt was published; the clock the accept deadline runs against */
  dispatchedAt?: number;
  /**
   * When the task reached `done`/`failed`. Stamped by the store rather than the
   * caller: retention is the store's business, and one place that sets it cannot
   * disagree with itself.
   */
  finishedAt?: number;
  /** last liveness tick from the bee executing it; absent means it has not started running */
  lastProgressAt?: number;
  /** the bee currently working on it, as reported by its own ticks */
  runningOn?: { agentId: string; tier: number; agent?: string; runtime: string; model?: string };
}

export interface JobStore {
  get(taskId: string): TaskState | undefined;
  /** Insert or update. Callers must call this after mutating a state they read. */
  put(state: TaskState): void;
  delete(taskId: string): void;
  /** every task, for GET /status */
  list(): TaskState[];
  /** the tasks the reaper might act on, as a snapshot it can safely redispatch during */
  dispatched(): TaskState[];
  /** result-cache key for a task, so a successful result can be filed under it */
  cacheKey(taskId: string): string | undefined;
  setCacheKey(taskId: string, key: string): void;
}

/**
 * How long a finished task stays queryable.
 *
 * Not a hygiene number. `getTask` is read by `GET /tasks/:id`, by the planner's
 * reflection pass after a plan completes, and by the session-affinity lookup,
 * which resolves a *finished* predecessor to the bee that holds its CLI session.
 * Evict too eagerly and a warm follow-up silently goes cold — the cost of a
 * wrong value here is a bill, not an error.
 */
const TASK_RETENTION_MS = Number(process.env.HIVE_TASK_RETENTION_MS ?? 30 * 60_000);

export class InMemoryJobStore implements JobStore {
  private readonly tasks = new Map<string, TaskState>();
  private readonly cacheKeys = new Map<string, string>();

  constructor(
    private readonly retentionMs = TASK_RETENTION_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId);
  }

  put(state: TaskState): void {
    const terminal = state.status === "done" || state.status === "failed";
    if (terminal && state.finishedAt === undefined) state.finishedAt = this.now();
    // A task that goes back to work — the reaper redispatching a stalled one —
    // is not finished any more, so its retention clock has to be cleared too or
    // it would be evicted mid-flight.
    if (!terminal && state.finishedAt !== undefined) state.finishedAt = undefined;
    this.tasks.set(state.taskId, state);
  }

  delete(taskId: string): void {
    this.tasks.delete(taskId);
    this.cacheKeys.delete(taskId);
  }

  list(): TaskState[] {
    return [...this.tasks.values()];
  }

  dispatched(): TaskState[] {
    return [...this.tasks.values()].filter((t) => t.status === "dispatched");
  }

  cacheKey(taskId: string): string | undefined {
    return this.cacheKeys.get(taskId);
  }

  setCacheKey(taskId: string, key: string): void {
    this.cacheKeys.set(taskId, key);
  }

  /**
   * Drop finished work past its retention window.
   *
   * Only `done` and `failed`: `dispatched` and `deferred` belong to the reaper,
   * and evicting one would look to the rest of the Queen exactly like a task
   * that never existed — the same silence a lost dispatch produces, which is
   * the one signal the reaper reads.
   *
   * Driven by its own interval rather than from `reapOnce`, which is gated on
   * the lightweight broker and which tests call with fabricated future clocks.
   * Exposed so its own test drives it directly.
   *
   * @returns how many records were dropped, for the caller's log line.
   */
  evictOnce(now = this.now()): number {
    let dropped = 0;
    for (const [taskId, state] of this.tasks) {
      if (state.status !== "done" && state.status !== "failed") continue;
      if (now - (state.finishedAt ?? state.startedAt) < this.retentionMs) continue;
      this.delete(taskId);
      dropped += 1;
    }
    return dropped;
  }

  /** for tests and diagnostics */
  get size(): number {
    return this.tasks.size;
  }
}
