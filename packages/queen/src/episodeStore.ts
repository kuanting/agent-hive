import { join } from "node:path";
import { checkpoint, openEpisodeDb, type Db } from "./episodeDb.js";
import type { EpisodeAttempt, EpisodeMode, EpisodeRecord, TaskEpisode } from "./episode.js";

/**
 * Reading and writing the corpus, with the same two methods the JSONL logs had.
 *
 * `append(rec, warn?)` and `readAll({since})` keep their exact signatures, which
 * is what makes this migration cheap: the two writers in the hive and the one
 * out-of-process reader do not change a line, and neither does anything near the
 * privacy ratchet. Churn next to an invariant is how invariants die.
 *
 * The write connection is opened once and held. Opening per call would have
 * mirrored `appendFileSync` more closely, and it was the first thing tried —
 * but closing a WAL database checkpoints it, so every single append paid a full
 * fsync-heavy checkpoint plus the deletion of the -wal. Measured at **453 ms per
 * append**, against an estimate of one or two. Holding the handle takes that to
 * a fraction of a millisecond.
 *
 * Nothing is required to close it. `close()` exists for a clean shutdown and for
 * tests that want determinism, but a process that simply exits releases the
 * handle, which is what the ~30 tests constructing a `QueenCore` and walking
 * away rely on.
 */

/** How much history to keep. The file-rotation knobs this replaces bounded bytes; these bound rows and age. */
const maxDays = (): number => Number(process.env.HIVE_EPISODE_MAX_DAYS ?? 180);
const maxRows = (): number => Number(process.env.HIVE_EPISODE_MAX_ROWS ?? 500_000);
/** Pruning is a scan; doing it on every append would cost more than it saves. */
const PRUNE_EVERY = 512;

export function episodeDbPath(root: string): string {
  return process.env.HIVE_EPISODE_DB ?? join(root, "data", "episodes", "episodes.db");
}

/** Set a key only when there is something to set, so an absent field stays absent. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) target[key] = value;
}

const bool = (v: unknown): boolean => v === 1 || v === true;
const jsonOrNull = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const parseOr = <T>(v: unknown, fallback: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : fallback);
const sortedKey = (xs: readonly string[] | undefined): string | null => (xs ? [...xs].sort().join(",") : null);

/**
 * A store over one table, sharing the open/transaction/prune machinery.
 *
 * Both corpora want identical mechanics and answer different questions, which is
 * the same reason the JSONL version was generic over its row.
 */
/** A prepared statement, as `node:sqlite` hands them back. */
type Stmt = ReturnType<Db["prepare"]>;

abstract class SqlStore<T extends { at: number; mode: EpisodeMode }> {
  private appends = 0;
  private handle?: Db;
  /**
   * Prepared statements, cached against the handle that owns them.
   *
   * Re-preparing the insert on every append was most of what remained after the
   * connection stopped being reopened: 3.7 ms down to a fraction of that. Cleared
   * whenever the handle is, since a statement outliving its connection is a
   * segfault waiting to happen.
   */
  private stmts = new Map<string, Stmt>();

  constructor(protected readonly file: string) {}

  protected abstract insert(db: Db, rec: T): void;
  protected abstract selectAll(db: Db, since?: number): T[];
  protected abstract table: string;

  /** The held write connection, opened on first use. */
  private writer(): Db {
    if (!this.handle) this.handle = openEpisodeDb(this.file);
    return this.handle;
  }

  /** A prepared statement on the write connection, prepared at most once. */
  protected stmt(db: Db, sql: string): Stmt {
    let s = this.stmts.get(sql);
    if (!s) {
      s = db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Drop the handle so the next call reopens rather than reusing a broken one. */
  private discard(): void {
    this.stmts.clear();
    try {
      this.handle?.close();
    } catch {
      /* already gone */
    }
    this.handle = undefined;
  }

  /**
   * Write one row. Best-effort, exactly as before: a hive that cannot record
   * must still answer. Losing a row is a cost; failing somebody's task to
   * protect one is not a trade worth making.
   */
  append(rec: T, warn?: (msg: string) => void): void {
    if (rec.mode === "off") return;
    try {
      const db = this.writer();
      db.exec("BEGIN IMMEDIATE");
      try {
        this.insert(db, rec);
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* the transaction already unwound */
        }
        throw err;
      }
      if (++this.appends % PRUNE_EVERY === 0) this.prune(db);
    } catch (err) {
      // A failed open leaves nothing to reuse, and a failed write may have left
      // the connection somewhere unhelpful. Either way the next append should
      // start clean rather than inherit this one's problem.
      this.discard();
      warn?.(`episode not recorded: ${String(err).slice(0, 160)}`);
    }
  }

  /**
   * Every recorded row, oldest first. `since` filters on the timestamp exactly.
   *
   * Opened read-only and closed immediately: a reader is usually a different
   * process — `npm run breed`, or a person with `sqlite3` — and a connection
   * that cannot write is the cheapest guarantee available for a surface whose
   * whole purpose is that other people query it.
   */
  readAll(opts: { since?: number } = {}): T[] {
    let db: Db | undefined;
    try {
      db = openEpisodeDb(this.file, { readOnly: true });
      return this.selectAll(db, opts.since);
    } catch {
      // No corpus yet is not an error — it is what a hive that has not run yet
      // looks like, and it is what the JSONL reader did too.
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        /* nothing to release */
      }
    }
  }

  /**
   * Bounded like every other long-lived structure in the hive: by age and by
   * count. Children go with their parents through ON DELETE CASCADE, and the
   * freed pages are returned rather than left as a file that only grows.
   */
  private prune(db: Db): void {
    try {
      const cutoff = Date.now() - maxDays() * 86_400_000;
      db.prepare(`DELETE FROM ${this.table} WHERE at < ?`).run(cutoff);
      db.prepare(
        `DELETE FROM ${this.table} WHERE id NOT IN (SELECT id FROM ${this.table} ORDER BY id DESC LIMIT ?)`,
      ).run(maxRows());
      db.exec("PRAGMA incremental_vacuum");
    } catch {
      /* pruning is housekeeping; it must never cost a row that was just written */
    }
  }

  /**
   * Flush the write-ahead log and release the handle.
   *
   * Worth calling on a clean shutdown so a reader never meets a -wal it cannot
   * open, but never required: exiting the process does the same thing.
   */
  close(): void {
    if (!this.handle) return;
    try {
      checkpoint(this.handle);
    } catch {
      /* nothing to flush */
    }
    this.discard();
  }
}

export class TaskEpisodeStore extends SqlStore<TaskEpisode> {
  protected table = "task";

  constructor(root: string) {
    super(episodeDbPath(root));
  }

  protected insert(db: Db, rec: TaskEpisode): void {
    const info = this
      .stmt(db,
        `INSERT INTO task (task_id, customer_id, at, mode, downgraded_reason,
           skills, skills_key, difficulty, sensitivity, tool_input_keys, tool_input_keys_key,
           artifact_count, ok, wall_ms, cached, user_id, end_user_hash, loop_id, turn_index,
           declared_tools, title, input, output, tool_input)
         VALUES (?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?)`,
      )
      .run(
        rec.taskId,
        rec.customerId,
        rec.at,
        rec.mode,
        rec.downgradedReason ?? null,
        JSON.stringify(rec.skills ?? []),
        sortedKey(rec.skills) ?? "",
        rec.difficulty ?? null,
        rec.sensitivity ?? null,
        jsonOrNull(rec.toolInputKeys),
        sortedKey(rec.toolInputKeys),
        rec.artifactCount ?? 0,
        rec.ok ? 1 : 0,
        rec.wallMs ?? 0,
        rec.cached === undefined ? null : rec.cached ? 1 : 0,
        rec.userId ?? null,
        rec.endUserHash ?? null,
        rec.loopId ?? null,
        rec.turnIndex ?? null,
        jsonOrNull(rec.declaredTools),
        rec.title ?? null,
        rec.input ?? null,
        rec.output ?? null,
        jsonOrNull(rec.toolInput),
      );
    insertAttempts((sql) => this.stmt(db, sql), Number(info.lastInsertRowid), rec.attempts ?? []);
  }

  protected selectAll(db: Db, since?: number): TaskEpisode[] {
    const rows = (
      since === undefined
        ? db.prepare("SELECT * FROM task ORDER BY id").all()
        : db.prepare("SELECT * FROM task WHERE at >= ? ORDER BY id").all(since)
    ) as Array<Record<string, unknown>>;
    const attempts = attemptsByTask(db);
    return rows.map((r) => {
      const rec: Record<string, unknown> = {
        taskId: r.task_id,
        customerId: r.customer_id,
        at: r.at,
        mode: r.mode,
        skills: parseOr<string[]>(r.skills, []),
        artifactCount: r.artifact_count,
        attempts: attempts.get(Number(r.id)) ?? [],
        ok: bool(r.ok),
        wallMs: r.wall_ms,
      };
      put(rec, "downgradedReason", r.downgraded_reason);
      put(rec, "difficulty", r.difficulty);
      put(rec, "sensitivity", r.sensitivity);
      if (r.tool_input_keys !== null) rec.toolInputKeys = parseOr<string[]>(r.tool_input_keys, []);
      if (r.cached !== null) rec.cached = bool(r.cached);
      put(rec, "userId", r.user_id);
      put(rec, "endUserHash", r.end_user_hash);
      put(rec, "loopId", r.loop_id);
      put(rec, "turnIndex", r.turn_index);
      if (r.declared_tools !== null) rec.declaredTools = parseOr<string[]>(r.declared_tools, []);
      put(rec, "title", r.title);
      put(rec, "input", r.input);
      put(rec, "output", r.output);
      if (r.tool_input !== null) rec.toolInput = parseOr<Record<string, unknown>>(r.tool_input, {});
      return rec as unknown as TaskEpisode;
    });
  }
}

function insertAttempts(stmt: (sql: string) => Stmt, taskRowId: number, attempts: EpisodeAttempt[]): void {
  const insA = stmt(
    `INSERT INTO attempt (task_row_id, ordinal, attempt, tier, agent, runtime, model, billing,
       ok, degraded, input_tokens, output_tokens, cost_usd, duration_ms,
       truncated_artifacts, tool_call_count, error, diagnostics)
     VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)`,
  );
  const insC = stmt(
    "INSERT INTO tool_call (attempt_row_id, seq, name, arg_keys, arg_keys_key) VALUES (?,?,?,?,?)",
  );
  attempts.forEach((a, ordinal) => {
    const info = insA.run(
      taskRowId,
      ordinal,
      a.attempt,
      a.tier,
      a.agent ?? null,
      a.runtime,
      a.model ?? null,
      a.billing ?? null,
      a.ok ? 1 : 0,
      a.degraded ? 1 : 0,
      a.inputTokens ?? 0,
      a.outputTokens ?? 0,
      a.costUsd ?? 0,
      a.durationMs ?? 0,
      jsonOrNull(a.truncatedArtifacts),
      a.toolCallNames === undefined ? null : a.toolCallNames.length,
      a.error ?? null,
      jsonOrNull(a.diagnostics),
    );
    const attemptRowId = Number(info.lastInsertRowid);
    (a.toolCallNames ?? []).forEach((name, seq) => {
      const keys = a.toolCallArgKeys?.[seq];
      insC.run(attemptRowId, seq, name, jsonOrNull(keys), (keys ?? []).join(","));
    });
  });
}

/** Every attempt with its tool calls, grouped by task, in one pass. */
function attemptsByTask(db: Db): Map<number, EpisodeAttempt[]> {
  const calls = new Map<number, Array<{ name: string; argKeys: string[] | undefined }>>();
  for (const c of db.prepare("SELECT * FROM tool_call ORDER BY attempt_row_id, seq").all() as Array<
    Record<string, unknown>
  >) {
    const list = calls.get(Number(c.attempt_row_id)) ?? [];
    list.push({
      name: String(c.name),
      argKeys: c.arg_keys === null ? undefined : parseOr<string[]>(c.arg_keys, []),
    });
    calls.set(Number(c.attempt_row_id), list);
  }

  const out = new Map<number, EpisodeAttempt[]>();
  for (const r of db.prepare("SELECT * FROM attempt ORDER BY task_row_id, ordinal").all() as Array<
    Record<string, unknown>
  >) {
    const a: Record<string, unknown> = {
      attempt: r.attempt,
      tier: r.tier,
      runtime: r.runtime,
      ok: bool(r.ok),
      degraded: bool(r.degraded),
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd,
      durationMs: r.duration_ms,
    };
    put(a, "agent", r.agent);
    put(a, "model", r.model);
    put(a, "billing", r.billing);
    put(a, "error", r.error);
    if (r.truncated_artifacts !== null) a.truncatedArtifacts = parseOr(r.truncated_artifacts, []);
    if (r.diagnostics !== null) a.diagnostics = parseOr<string[]>(r.diagnostics, []);
    // NULL means the runtime never reported a tool-call field; 0 means it
    // reported an empty one. Only the second should read back as an empty array.
    if (r.tool_call_count !== null) {
      const mine = calls.get(Number(r.id)) ?? [];
      a.toolCallNames = mine.map((c) => c.name);
      if (mine.some((c) => c.argKeys !== undefined)) a.toolCallArgKeys = mine.map((c) => c.argKeys ?? []);
    }
    const list = out.get(Number(r.task_row_id)) ?? [];
    list.push(a as unknown as EpisodeAttempt);
    out.set(Number(r.task_row_id), list);
  }
  return out;
}

export class TurnEpisodeStore extends SqlStore<EpisodeRecord> {
  protected table = "turn";

  constructor(root: string) {
    super(episodeDbPath(root));
  }

  protected insert(db: Db, rec: EpisodeRecord): void {
    this.stmt(
      db,
      `INSERT INTO turn (turn_id, customer_id, at, mode, downgraded_reason,
         planner_model, planner_tier, decision, escalated, planner_difficulty,
         planner_input_tokens, planner_output_tokens, planner_cost_usd, planner_latency_ms,
         recall_ids, recall_chars, routing, phase_ms,
         total_input_tokens, total_output_tokens, total_cost_usd, total_wall_ms, total_attempts,
         outcome_ok, outcome_answer_chars, user_message, plan_rationale, answer, tasks)
       VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?)`,
    ).run(
      rec.turnId,
      rec.customerId,
      rec.at,
      rec.mode,
      rec.downgradedReason ?? null,
      rec.planner.model ?? null,
      rec.planner.tier ?? null,
      rec.planner.decision,
      rec.planner.escalated ? 1 : 0,
      rec.planner.difficulty ?? null,
      rec.planner.inputTokens,
      rec.planner.outputTokens,
      rec.planner.costUsd,
      rec.planner.latencyMs,
      jsonOrNull(rec.recall?.ids),
      rec.recall?.chars ?? null,
      rec.routing ?? null,
      JSON.stringify(rec.phaseMs ?? {}),
      rec.totals.inputTokens,
      rec.totals.outputTokens,
      rec.totals.costUsd,
      rec.totals.wallMs,
      rec.totals.attempts,
      rec.outcome.ok ? 1 : 0,
      rec.outcome.answerChars,
      rec.userMessage ?? null,
      rec.planRationale ?? null,
      rec.answer ?? null,
      // Stored whole and post-ratchet. See the note on the `turn` table: joining
      // this back to `task` would undo the turn-level strip.
      JSON.stringify(rec.tasks ?? []),
    );
  }

  protected selectAll(db: Db, since?: number): EpisodeRecord[] {
    const rows = (
      since === undefined
        ? db.prepare("SELECT * FROM turn ORDER BY id").all()
        : db.prepare("SELECT * FROM turn WHERE at >= ? ORDER BY id").all(since)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const planner: Record<string, unknown> = {
        decision: r.decision,
        escalated: bool(r.escalated),
        inputTokens: r.planner_input_tokens,
        outputTokens: r.planner_output_tokens,
        costUsd: r.planner_cost_usd,
        latencyMs: r.planner_latency_ms,
      };
      put(planner, "model", r.planner_model);
      put(planner, "tier", r.planner_tier);
      put(planner, "difficulty", r.planner_difficulty);

      const rec: Record<string, unknown> = {
        turnId: r.turn_id,
        customerId: r.customer_id,
        at: r.at,
        mode: r.mode,
        planner,
        phaseMs: parseOr<Record<string, number>>(r.phase_ms, {}),
        tasks: parseOr(r.tasks, []),
        totals: {
          inputTokens: r.total_input_tokens,
          outputTokens: r.total_output_tokens,
          costUsd: r.total_cost_usd,
          wallMs: r.total_wall_ms,
          attempts: r.total_attempts,
        },
        outcome: { ok: bool(r.outcome_ok), answerChars: r.outcome_answer_chars },
      };
      put(rec, "downgradedReason", r.downgraded_reason);
      if (r.recall_ids !== null) {
        rec.recall = { ids: parseOr<string[]>(r.recall_ids, []), chars: r.recall_chars ?? 0 };
      }
      put(rec, "routing", r.routing);
      put(rec, "userMessage", r.user_message);
      put(rec, "planRationale", r.plan_rationale);
      put(rec, "answer", r.answer);
      return rec as unknown as EpisodeRecord;
    });
  }
}
