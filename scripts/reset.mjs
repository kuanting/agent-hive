// Reset local demo state so the hive starts fresh.
//
//   npm run reset             -> clear the budget ledger (spend + seat windows)
//   npm run reset -- --memory -> also clear what the Queen has learned
//   npm run reset -- --all    -> also clear the artifact store and learned memory
//
// The plan guides in customers/ are never removed: they are hand-authored
// configuration, like customers/*.yaml. Only learned memory under data/ is
// runtime state. That split is the whole authored-vs-learned distinction.
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
const alsoArtifacts = process.argv.includes("--all");
const alsoMemory = alsoArtifacts || process.argv.includes("--memory");

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
console.log(
  "[reset] done — the ledger rebuilds from customers/*.yaml on the next queen start." +
    (alsoArtifacts ? "" : "\n[reset] tip: `npm run reset -- --all` also clears the artifact store and learned memory."),
);
