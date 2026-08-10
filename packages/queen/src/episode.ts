import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskResult } from "@hive/shared";

/**
 * The hive's memory of what it actually cost to get a job done.
 *
 * Everything needed to answer "was that the right call?" already flows through a
 * turn — the planner meters its own tokens, every TaskResult carries usage and
 * tier, and the turn emits a full event stream — and then all of it is thrown
 * away. `HiveLog` is a 500-line in-process ring that resets on restart, and
 * `recordPlannerCost` keeps one running USD total with no turn attached. So the
 * hive can tell you what it is spending and never what it learned.
 *
 * This is the append-only record that closes that gap: one JSON line per turn,
 * carrying the decision, the work, the cost, and — the part that makes it a
 * training set rather than a receipt — the outcome, including the full attempt
 * chain. A task that failed at tier 3 and succeeded at tier 1 is a labelled
 * example of `scoreDifficulty` (a regex, today) getting it wrong. Collect
 * enough of those and the planner can be refined from evidence instead of
 * intuition, which is the whole point of deploying small first.
 *
 * Deliberately a file, not a database. The hive already persists this way
 * (`data/ledger.json`, the memory store's markdown), `data/` is gitignored, and
 * a JSONL file is what a training pipeline wants to read anyway. §9's durable
 * store can absorb it later; nothing here assumes it won't.
 */

/**
 * How much of a turn may be written down.
 *
 * `tasks` is the rung between "no content at all" and "the whole conversation".
 * It records what each task *was* — its input, its output, its structured
 * payload — and not what the conversation *said*: no user message, no plan
 * rationale, no assistant answer. The distinction is the point. A task's input
 * is the work, and it is what anything reasoning about recurring work has to
 * read; the other three are a person talking, and nothing downstream needs them.
 *
 * Existing to make the tool-recommendation engine possible at all without
 * asking a customer for their transcripts: at `metadata` it can say "this
 * recurred 61 times and would cost $12.40 at frontier rates" and literally
 * nothing else — it cannot name a single parameter.
 */
export type EpisodeMode = "off" | "metadata" | "tasks" | "full";

/** Rank, so a mode can be compared rather than enumerated at every call site. */
const MODE_RANK: Record<EpisodeMode, number> = { off: 0, metadata: 1, tasks: 2, full: 3 };

/** Does this mode permit at least `min`? */
export function modeAllows(mode: EpisodeMode, min: EpisodeMode): boolean {
  return MODE_RANK[mode] >= MODE_RANK[min];
}

/** Per-attempt record — the label. Present for every attempt, not just the last. */
export interface EpisodeAttempt {
  attempt: number;
  tier: number;
  agent?: string;
  runtime: string;
  model?: string;
  billing?: string;
  ok: boolean;
  degraded: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  /** why it failed, when it did — the escalation's own summary */
  error?: string;
  /** artifacts the bee could not be given in full, when the prompt had to clip them */
  truncatedArtifacts?: Array<{ ref: string; droppedChars: number }>;
  /** the runtime's own narration, when it had any (see ExecResult.diagnostics) */
  diagnostics?: string[];
}

/**
 * One execution, as the attempt row that labels it.
 *
 * One definition for both corpora. The turn record and the task record want the
 * identical projection of a `TaskResult`, and two hand-maintained copies would
 * drift the moment either grew a field — leaving two training sets that disagree
 * about what an attempt is.
 */
export function toEpisodeAttempt(r: TaskResult): EpisodeAttempt {
  return {
    attempt: r.attempt,
    tier: r.tierUsed,
    agent: r.agent,
    runtime: r.runtime,
    model: r.model,
    billing: r.billing,
    ok: r.ok,
    degraded: r.degraded,
    inputTokens: r.usage.inputTokens,
    outputTokens: r.usage.outputTokens,
    costUsd: r.usage.costUsd,
    durationMs: r.durationMs,
    error: r.error,
  };
}

export interface EpisodeTask {
  key: string;
  taskId: string;
  /** present only in `full` mode: the planner phrases it from the user's words */
  title?: string;
  skills: string[];
  difficulty?: string;
  sensitivity?: string;
  /**
   * Which keys `spec.toolInput` carried — names only, never values.
   *
   * Recorded at every mode because it is the one structural fact about a task's
   * shape that carries no content: `matchTool` and `missedToolMatch` both reason
   * about exactly this set (analyzer.ts), so a corpus that keeps it can tell
   * "this shape was one key away from tier 4" without keeping a word the user
   * wrote.
   */
  toolInputKeys?: string[];
  /**
   * The structured payload itself — values, not just names. `tasks` and above.
   *
   * `toolInputKeys` survives every mode because a key name is structure; this is
   * what the keys were set *to*, which is content. Worth recording at all because
   * when it is present the parameters of a recurring shape are already named by
   * the planner, and nothing has to infer them.
   */
  toolInput?: Record<string, unknown>;
  /** every execution tried, oldest first */
  attempts: EpisodeAttempt[];
  ok: boolean;
  /** `tasks` and above */
  input?: string;
  output?: string;
}

export interface EpisodeRecord {
  turnId: string;
  customerId: string;
  at: number;
  mode: EpisodeMode;
  /** why this turn is not `full`, when the customer asked for `full` and did not get it */
  downgradedReason?: string;
  planner: {
    model?: string;
    tier?: number;
    decision: string;
    escalated: boolean;
    difficulty?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
  };
  recall?: { ids: string[]; chars: number };
  /** which routing policy was in force, so its effect on first-attempt success is measurable */
  routing?: string;
  /** wall time per named phase: recalling, planning, dispatching, waiting, synthesizing, learning */
  phaseMs: Record<string, number>;
  tasks: EpisodeTask[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    wallMs: number;
    /** executions across all tasks — attempts, not tasks, so retries are visible in one number */
    attempts: number;
  };
  outcome: { ok: boolean; answerChars: number };
  /** present only in `full` mode */
  userMessage?: string;
  planRationale?: string;
  answer?: string;
}

// Read per call rather than at import. As module constants these were fixed by
// whatever the environment held when the first importer loaded — which made the
// rotation test assert nothing, since it set the vars in the test body and got
// the 8 MB default anyway, then passed because one un-rotated file is also
// "at most three files".
const maxFileBytes = (): number => Number(process.env.HIVE_EPISODE_FILE_BYTES ?? 8 * 1024 * 1024);
const maxFiles = (): number => Number(process.env.HIVE_EPISODE_FILES ?? 20);

/** Coerce a raw profile value, defaulting anything unrecognized to the safe mode. */
export function resolveEpisodeMode(raw: unknown): EpisodeMode {
  return raw === "off" || raw === "full" || raw === "tasks" || raw === "metadata" ? raw : "metadata";
}

/**
 * The `tasks` rung, applied to a turn record: keep the tasks, drop the conversation.
 *
 * Takes no reason, unlike `toMetadata`, because it is not a downgrade — it is
 * the fidelity the customer asked for. `downgradedReason` stays reserved for the
 * ratchet, so "was this reduced against the customer's wish?" remains answerable
 * from the row itself.
 */
export function toTaskLevel(rec: EpisodeRecord): EpisodeRecord {
  return { ...rec, userMessage: undefined, planRationale: undefined, answer: undefined };
}

/**
 * Strip every field that carries user or model text.
 *
 * Used when a turn touches confidential work, regardless of what the customer
 * profile asked for. Same one-way ratchet as `userImpliedConfidential`: a hit
 * can only ever remove content, never restore it, because the failure modes are
 * not symmetric — recording less costs a training row, recording more leaks.
 *
 * Three fields used to survive this that should not have: `title` is the
 * planner's phrasing of the user's own request, and `error`/`diagnostics` are
 * whatever a runtime chose to say — a model refusal quoting the prompt back, a
 * stack trace with an interpolated argument. Nothing read them, so nothing
 * noticed. Stripping them costs the *reason* a task failed but not the label
 * that matters: an attempt chain reading tier 3 `ok: false` then tier 1
 * `ok: true` is still a labelled example of `scoreDifficulty` guessing wrong,
 * and that structure is all numbers.
 */
export function toMetadata(rec: EpisodeRecord, reason: string): EpisodeRecord {
  return {
    ...rec,
    mode: "metadata",
    downgradedReason: reason,
    userMessage: undefined,
    planRationale: undefined,
    answer: undefined,
    tasks: rec.tasks.map((t) => ({
      ...t,
      title: undefined,
      input: undefined,
      output: undefined,
      // toolInputKeys deliberately survives: names, never values.
      toolInput: undefined,
      attempts: t.attempts.map((a) => ({ ...a, error: undefined, diagnostics: undefined })),
    })),
  };
}

/**
 * One settled task, whoever asked for it.
 *
 * The turn-level record above answers "what did that conversation cost, and did
 * the planner route it well?" — questions about a *turn*, which only the
 * conversational Queen has. But `/v1/chat/completions` and `POST /tasks` reach
 * `submitTask` without ever making a turn, so on the surface the hive is moving
 * toward (DESIGN §3), that record is never written and the corpus stays empty.
 *
 * This is the smaller, more universal row: one line per task reaching a terminal
 * state, written from `settle()`, which every intake path funnels through. A
 * task is also the right grain for the question "is this shape worth replacing
 * with a program?" — that is a property of the work, not of the conversation
 * that happened to ask for it.
 */
export interface TaskEpisode {
  taskId: string;
  customerId: string;
  /** when it settled */
  at: number;
  mode: EpisodeMode;
  downgradedReason?: string;
  skills: string[];
  /** what `scoreDifficulty` said about the spec — the label, before any escalation */
  difficulty?: string;
  sensitivity?: string;
  /** names only, never values; see EpisodeTask.toolInputKeys */
  toolInputKeys?: string[];
  /** how many artifact refs the spec carried; a shape fact, not content */
  artifactCount: number;
  /** every execution tried, oldest first. Empty when the result came from cache. */
  attempts: EpisodeAttempt[];
  ok: boolean;
  wallMs: number;
  /**
   * The result was served from `ResultCache`, so nothing ran and nothing was
   * spent.
   *
   * Recorded because the shape genuinely recurred, and frequency is the first
   * thing anyone asks of this corpus. Dropping these rows would hide repetition
   * precisely where it is highest — a shape asked for often enough to keep
   * hitting a 10-minute cache is the strongest candidate there is for being
   * replaced by a program, and it would have looked like the weakest.
   *
   * `taskId` is the id of the task whose result was reused: no new task exists,
   * and minting an id for one would put a fiction in the corpus. So count rows
   * for occurrences, and filter these out to count executions.
   */
  cached?: boolean;
  /**
   * Who asked, when the intake knew.
   *
   * Both are identifiers rather than content, so both survive every fidelity —
   * `userId` is a name assigned in `HIVE_API_KEYS`, and `endUserHash` is a hash
   * of a caller-supplied field whose value is never written down. `auth.ts` has
   * promised per-user attribution since it was introduced; this is where it
   * actually lands.
   */
  userId?: string;
  endUserHash?: string;
  /** `tasks` and above */
  title?: string;
  input?: string;
  output?: string;
  /** `tasks` and above — values; see EpisodeTask.toolInput */
  toolInput?: Record<string, unknown>;
}

/** `toMetadata`'s rule, applied to the task-level row. Same one-way ratchet. */
export function toTaskMetadata(rec: TaskEpisode, reason: string): TaskEpisode {
  return {
    ...rec,
    mode: "metadata",
    downgradedReason: reason,
    title: undefined,
    input: undefined,
    output: undefined,
    toolInput: undefined,
    attempts: rec.attempts.map((a) => ({ ...a, error: undefined, diagnostics: undefined })),
  };
}

/**
 * Append-only JSONL writer: rotate, prune, read back.
 *
 * Never publishes. The log-privacy fence (`queen/test/log-privacy.test.ts`)
 * governs narration reaching the broker and every open browser tab; this writes
 * to local disk on the Queen's own host and must stay there. That distinction is
 * what makes recording task text defensible at all — see DESIGN.md §7.
 *
 * Generic over the row because there are now two corpora with identical
 * mechanics and different questions, and the bounded-file discipline (§4) is
 * exactly the part that must not be reimplemented per caller.
 */
export class JsonlLog<T extends { at: number; mode: EpisodeMode }> {
  private readonly dir: string;
  private readonly file: string;

  constructor(root: string, private readonly base: string) {
    this.dir = join(root, "data", "episodes");
    this.file = join(this.dir, `${this.base}.jsonl`);
  }

  /**
   * Write one turn. Best-effort: a hive that cannot record must still answer, so
   * every failure here is swallowed after a warning. Losing a training row is a
   * cost; failing a user's turn to protect one is not a trade worth making.
   */
  append(rec: T, warn?: (msg: string) => void): void {
    if (rec.mode === "off") return;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.rotateIfNeeded();
      // Append rather than read-modify-write: a crash mid-write costs the tail of
      // one line, which a JSONL reader skips, instead of the whole corpus.
      appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
    } catch (err) {
      warn?.(`episode not recorded: ${String(err).slice(0, 160)}`);
    }
  }

  /**
   * Bounded like every other long-lived structure in the hive (§4). Rolls the
   * live file aside once it is large enough and drops the oldest rolls, so a
   * long-running Queen cannot fill the disk with its own training data.
   */
  private rotateIfNeeded(): void {
    if (!existsSync(this.file)) return;
    if (statSync(this.file).size < maxFileBytes()) return;
    // A fixed suffix would collide if two rotations landed in the same
    // millisecond; a uuid slice cannot, and the name only has to sort by mtime.
    renameSync(this.file, join(this.dir, `${this.base}-${randomUUID().slice(0, 8)}.jsonl`));
    const rolled = this.rolled();
    for (const old of rolled.slice(0, Math.max(0, rolled.length - (maxFiles() - 1)))) {
      rmSync(old.path, { force: true });
    }
  }

  /**
   * Rolled files, oldest first. The live file is not one of them.
   *
   * Ties broken by name so the order is total: two rotations inside one
   * millisecond are indistinguishable by mtime, and an unstable sort there would
   * make both which-file-gets-pruned and read order depend on directory listing
   * order. Their true relative order does not matter — every record carries its
   * own `at` — but the answer must at least be the same one twice.
   */
  private rolled(): Array<{ path: string; mtimeMs: number }> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.startsWith(`${this.base}-`) && f.endsWith(".jsonl"))
      .map((f) => ({ path: join(this.dir, f), mtimeMs: statSync(join(this.dir, f)).mtimeMs }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  }

  /**
   * Read every recorded episode, oldest first.
   *
   * This used to read `episodes.jsonl` alone, which meant it saw only what had
   * accumulated since the last rotation — at the 8 MB default, a few percent of
   * a corpus that rotation was carefully keeping twenty files of. Nothing but a
   * test read it, so the gap never showed. Anything that learns from history
   * needs the history.
   *
   * `since` skips whole files rather than filtering their lines: a file's mtime
   * is its final append, so every record inside predates it. That is exact, not
   * an approximation, and it keeps a windowed read off the oldest gigabytes.
   */
  readAll(opts: { since?: number } = {}): T[] {
    const out: T[] = [];
    for (const f of [...this.rolled(), ...liveFile(this.file)]) {
      if (opts.since !== undefined && f.mtimeMs < opts.since) continue;
      for (const line of readFileSync(f.path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as T;
          if (opts.since !== undefined && rec.at < opts.since) continue;
          out.push(rec);
        } catch {
          /* a torn tail from a hard stop: skip the line, keep the corpus */
        }
      }
    }
    return out;
  }
}

function liveFile(path: string): Array<{ path: string; mtimeMs: number }> {
  return existsSync(path) ? [{ path, mtimeMs: statSync(path).mtimeMs }] : [];
}

/** One row per conversational turn: `data/episodes/episodes.jsonl`. */
export class EpisodeLog extends JsonlLog<EpisodeRecord> {
  constructor(root: string) {
    super(root, "episodes");
  }
}

/**
 * One row per settled task: `data/episodes/tasks.jsonl`.
 *
 * Separate file rather than a field on the turn record, because the two answer
 * different questions and have different lifetimes — a turn belongs to the
 * planner, a task belongs to the hive, and only one of the two is written on
 * every intake path.
 */
export class TaskEpisodeLog extends JsonlLog<TaskEpisode> {
  constructor(root: string) {
    super(root, "tasks");
  }
}
