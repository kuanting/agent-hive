// Reset local demo state so the hive starts fresh.
//
//   npm run reset               -> clear the budget ledger (spend + seat windows)
//   npm run reset -- --memory   -> also clear what the Queen has learned
//   npm run reset -- --episodes -> also clear the usage corpus
//   npm run reset -- --all      -> all of the above, plus the artifact store
//
// The plan guides in customers/ are never removed: they are hand-authored
// configuration, like customers/*.yaml. That split is the whole
// authored-vs-learned distinction.
//
// The usage corpus gets its own flag rather than riding along with --memory,
// because the two are not the same kind of thing. Learned memory is DERIVED: wipe
// it and traffic re-earns it. The corpus IS the traffic — a record of what
// actually happened, which nothing can reconstruct — so deleting it should take
// saying so. It was also never cleaned at all until now, while this comment and
// the README both implied it was.
//
// The ledger rebuilds from customers/*.yaml on the next queen start, so run this
// while the hive is stopped (a running queen holds the ledger in memory and would
// re-save it). HIVE_ROOT / HIVE_ARTIFACTS are read from .env, matching the queen.
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.env.HIVE_ROOT ?? ".");
const ledgerPath = join(root, "data", "ledger.json");
const artifactsPath = join(root, process.env.HIVE_ARTIFACTS ?? "artifacts");
const memoryPath = join(root, "data", "memory");
// The whole directory, not just episodes.db: a stale -wal left beside a deleted
// database resurrects the rows it was holding.
const episodesPath = join(root, "data", "episodes");
const alsoArtifacts = process.argv.includes("--all");
const alsoMemory = alsoArtifacts || process.argv.includes("--memory");
const alsoEpisodes = alsoArtifacts || process.argv.includes("--episodes");

function drop(path, label) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    console.log(`[reset] removed ${label} (${path})`);
  } else {
    console.log(`[reset] ${label} already clean (${path})`);
  }
}

drop(ledgerPath, "budget ledger");
if (alsoArtifacts) drop(artifactsPath, "artifact store");
if (alsoMemory) {
  drop(memoryPath, "learned memory");
  console.log("[reset] plan guides in customers/ are configuration and were left alone.");
}
if (alsoEpisodes) drop(episodesPath, "usage corpus");
else console.log("[reset] usage corpus left alone (it is the record of what happened; --episodes clears it).");
console.log(
  "[reset] done — the ledger rebuilds from customers/*.yaml on the next queen start." +
    (alsoArtifacts
      ? ""
      : "\n[reset] tip: `npm run reset -- --all` also clears the artifact store, learned memory and the usage corpus."),
);
