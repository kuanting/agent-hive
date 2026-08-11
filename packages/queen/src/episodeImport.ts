import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EpisodeJsonlLog, TaskEpisodeJsonlLog } from "./episodeJsonl.js";
import { episodeDbPath, EpisodeLog, TaskEpisodeLog } from "./episode.js";
import { openEpisodeDb } from "./episodeDb.js";

/**
 * Carry a previous version's JSONL corpus into the database, once.
 *
 * The corpus is the one store in the hive that cannot be regenerated: the ledger
 * rebuilds from customer profiles, learned memory re-earns itself from traffic,
 * artifacts are scratch. This is a record of what actually happened, so an
 * upgrade that silently stopped reading it would quietly destroy the only copy.
 *
 * Idempotent on the file's size and mtime, and the source files are never
 * deleted — if this import is wrong in some way nobody has noticed yet, the
 * evidence is still there to redo it from.
 */
export function importLegacyJsonl(root: string, warn?: (msg: string) => void): number {
  const dir = join(root, "data", "episodes");
  if (!existsSync(dir)) return 0;

  let imported = 0;
  try {
    const db = openEpisodeDb(episodeDbPath(root));
    const seen = db.prepare("SELECT file, mtime_ms, size_bytes FROM import_state");
    const mark = db.prepare(
      "INSERT OR REPLACE INTO import_state (file, mtime_ms, size_bytes, rows, at) VALUES (?,?,?,?,?)",
    );
    const done = new Map<string, { mtime_ms: number; size_bytes: number }>();
    for (const r of seen.all() as Array<{ file: string; mtime_ms: number; size_bytes: number }>) {
      done.set(r.file, r);
    }

    // Both corpora, each read by the code that wrote it.
    const sources: Array<{ prefix: string; read: () => Array<{ at: number; mode: string }>; write: (rows: never[]) => void }> = [
      {
        prefix: "tasks",
        read: () => new TaskEpisodeJsonlLog(root).readAll() as Array<{ at: number; mode: string }>,
        write: (rows) => {
          const store = new TaskEpisodeLog(root);
          for (const r of rows) store.append(r);
        },
      },
      {
        prefix: "episodes",
        read: () => new EpisodeJsonlLog(root).readAll() as Array<{ at: number; mode: string }>,
        write: (rows) => {
          const store = new EpisodeLog(root);
          for (const r of rows) store.append(r);
        },
      },
    ];

    for (const src of sources) {
      // The live file plus every roll-up, as one unit: the reader already stitches
      // them, and fingerprinting the live file is enough to tell "nothing new".
      const files = readdirSync(dir).filter((f) => f.startsWith(src.prefix) && f.endsWith(".jsonl"));
      if (files.length === 0) continue;
      const key = `${src.prefix}.jsonl`;
      const live = join(dir, key);
      const stamp = existsSync(live) ? statSync(live) : { mtimeMs: 0, size: 0 };
      const already = done.get(key);
      if (already && already.mtime_ms === Math.floor(stamp.mtimeMs) && already.size_bytes === stamp.size) continue;

      const rows = src.read();
      if (rows.length > 0) src.write(rows as never[]);
      mark.run(key, Math.floor(stamp.mtimeMs), stamp.size, rows.length, Date.now());
      imported += rows.length;
    }

    db.close();
    if (imported > 0) warn?.(`imported ${imported} legacy episode row(s) from ${dir}`);
  } catch (err) {
    // A hive that cannot import must still start. The files stay where they are.
    warn?.(`legacy episode import skipped: ${String(err).slice(0, 160)}`);
  }
  return imported;
}
