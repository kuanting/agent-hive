import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION, VIEWS_SQL } from "./episodeSchema.js";

/**
 * Opening the corpus, and the only place in the hive that imports `node:sqlite`.
 *
 * One import site on purpose: the module is stability 1.1, so if its API moves
 * this is the single file that has to follow. Everything above it sees an
 * ordinary object with prepared statements.
 *
 * There is no dependency to add — SQLite ships inside Node — which is what makes
 * a real database defensible in a repo whose entire backend runs on six packages.
 */

export type Db = DatabaseSync;

/** How long to wait for another connection's write lock before giving up. */
const BUSY_TIMEOUT_MS = Number(process.env.HIVE_EPISODE_BUSY_MS ?? 3000);

export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly known: number,
  ) {
    super(
      `episode corpus is at schema v${found}, this build knows v${known}. ` +
        `Refusing to touch it — upgrade the hive, or point HIVE_EPISODE_DB elsewhere.`,
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * Open the corpus, creating and initializing it when it does not exist.
 *
 * @param readOnly for the out-of-process readers — `npm run breed`, a person with
 * `sqlite3`, whatever reads this next. A read-only connection cannot be tricked
 * into writing, which is the cheapest possible guarantee for a surface whose
 * whole point is that other people query it.
 */
export function openEpisodeDb(file: string, opts: { readOnly?: boolean } = {}): Db {
  if (!opts.readOnly) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { readOnly: opts.readOnly ?? false });

  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (!opts.readOnly) {
      db.exec("PRAGMA foreign_keys = ON");
      // A corpus that loses its last commit to a power cut is exactly the trade
      // `append` already makes by swallowing its own failures: recording is
      // best-effort, and answering the user is not.
      db.exec("PRAGMA synchronous = NORMAL");
    }

    const found = version(db);
    if (found > SCHEMA_VERSION) throw new SchemaTooNewError(found, SCHEMA_VERSION);
    if (found === 0 && !opts.readOnly) initialize(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

function version(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function initialize(db: Db): void {
  // WAL is negotiated rather than assumed. It needs shared memory through an
  // -shm file, which works on local disk and does not on NFS or SMB — and a
  // HIVE_ROOT can be a network share. Ask, read back what was actually granted,
  // and record it, so an operator debugging a locking problem can see which mode
  // this corpus is in without guessing.
  let journal = "delete";
  try {
    const row = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined;
    journal = String(row?.journal_mode ?? "delete");
  } catch {
    /* fall through to the default mode; nothing here is worth failing a hive over */
  }
  if (journal !== "wal") {
    try {
      db.exec("PRAGMA journal_mode = TRUNCATE");
      journal = "truncate";
    } catch {
      /* whatever mode it is in will still work, just less well */
    }
  }
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");

  db.exec(SCHEMA_SQL);
  db.exec(VIEWS_SQL);
  const meta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  meta.run("schema_version", String(SCHEMA_VERSION));
  meta.run("journal_mode", journal);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * Flush the write-ahead log back into the main file.
 *
 * Worth doing on a clean shutdown: a hive killed mid-write leaves a -wal behind,
 * and a read-only connection cannot create the -shm it would need to read past
 * it — so the next person to run a query gets a permissions error about a file
 * they can read perfectly well.
 */
export function checkpoint(db: Db): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* not in WAL, or nothing to flush */
  }
}
