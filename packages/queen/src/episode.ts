import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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

/** How much of a turn may be written down. */
export type EpisodeMode = "off" | "metadata" | "full";

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

export interface EpisodeTask {
  key: string;
  taskId: string;
  title?: string;
  skills: string[];
  difficulty?: string;
  sensitivity?: string;
  /** every execution tried, oldest first */
  attempts: EpisodeAttempt[];
  ok: boolean;
  /** present only in `full` mode */
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

const MAX_FILE_BYTES = Number(process.env.HIVE_EPISODE_FILE_BYTES ?? 8 * 1024 * 1024);
const MAX_FILES = Number(process.env.HIVE_EPISODE_FILES ?? 20);

/** Coerce a raw profile value, defaulting anything unrecognized to the safe mode. */
export function resolveEpisodeMode(raw: unknown): EpisodeMode {
  return raw === "off" || raw === "full" || raw === "metadata" ? raw : "metadata";
}

/**
 * Strip every field that carries user or model text.
 *
 * Used when a turn touches confidential work, regardless of what the customer
 * profile asked for. Same one-way ratchet as `userImpliedConfidential`: a hit
 * can only ever remove content, never restore it, because the failure modes are
 * not symmetric — recording less costs a training row, recording more leaks.
 */
export function toMetadata(rec: EpisodeRecord, reason: string): EpisodeRecord {
  return {
    ...rec,
    mode: "metadata",
    downgradedReason: reason,
    userMessage: undefined,
    planRationale: undefined,
    answer: undefined,
    tasks: rec.tasks.map((t) => ({ ...t, input: undefined, output: undefined })),
  };
}

/**
 * Append-only JSONL episode writer.
 *
 * Never publishes. The log-privacy fence (`queen/test/log-privacy.test.ts`)
 * governs narration reaching the broker and every open browser tab; this writes
 * to local disk on the Queen's own host and must stay there. That distinction is
 * what makes recording task text defensible at all — see DESIGN.md §7.
 */
export class EpisodeLog {
  private readonly dir: string;
  private readonly file: string;

  constructor(root: string) {
    this.dir = join(root, "data", "episodes");
    this.file = join(this.dir, "episodes.jsonl");
  }

  /**
   * Write one turn. Best-effort: a hive that cannot record must still answer, so
   * every failure here is swallowed after a warning. Losing a training row is a
   * cost; failing a user's turn to protect one is not a trade worth making.
   */
  append(rec: EpisodeRecord, warn?: (msg: string) => void): void {
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
    if (statSync(this.file).size < MAX_FILE_BYTES) return;
    // A fixed suffix would collide if two rotations landed in the same
    // millisecond; a uuid slice cannot, and the name only has to sort by mtime.
    renameSync(this.file, join(this.dir, `episodes-${randomUUID().slice(0, 8)}.jsonl`));
    const rolled = readdirSync(this.dir)
      .filter((f) => f.startsWith("episodes-") && f.endsWith(".jsonl"))
      .map((f) => ({ f, at: statSync(join(this.dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of rolled.slice(Math.max(0, MAX_FILES - 1))) {
      rmSync(join(this.dir, old.f), { force: true });
    }
  }

  /** Read every recorded episode, newest file last. For tests and for whatever reads the corpus. */
  readAll(): EpisodeRecord[] {
    if (!existsSync(this.file)) return [];
    const out: EpisodeRecord[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as EpisodeRecord);
      } catch {
        /* a torn tail from a hard stop: skip the line, keep the corpus */
      }
    }
    return out;
  }
}
