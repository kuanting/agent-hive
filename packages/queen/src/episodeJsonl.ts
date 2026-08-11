import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EpisodeMode, EpisodeRecord, TaskEpisode } from "./episode.js";

// Read per call rather than at import. As module constants these were fixed by
// whatever the environment held when the first importer loaded — which made the
// rotation test assert nothing, since it set the vars in the test body and got
// the 8 MB default anyway, then passed because one un-rotated file is also
// "at most three files".
const maxFileBytes = (): number => Number(process.env.HIVE_EPISODE_FILE_BYTES ?? 8 * 1024 * 1024);
const maxFiles = (): number => Number(process.env.HIVE_EPISODE_FILES ?? 20);

/**
 * The corpus as it used to be stored, kept only so the SQL store can read it in.
 *
 * Nothing writes JSONL any more. This is the importer half of a one-way move:
 * `episodeImport.ts` reads whatever a previous version of the hive left in
 * `data/episodes/*.jsonl` and inserts it into the database, and these files are
 * never written to or deleted again. Unchanged from the version that wrote them,
 * deliberately — a reader for old data should be the code that produced it.
 */

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
export class EpisodeJsonlLog extends JsonlLog<EpisodeRecord> {
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
export class TaskEpisodeJsonlLog extends JsonlLog<TaskEpisode> {
  constructor(root: string) {
    super(root, "tasks");
  }
}
