// Reset local demo state so the hive starts fresh.
//
//   npm run reset            -> clear the budget ledger (spend + seat windows)
//   npm run reset -- --all   -> also clear the on-disk artifact store
//
// The ledger rebuilds from customers/*.yaml on the next queen start, so run this
// while the hive is stopped (a running queen holds the ledger in memory and would
// re-save it). HIVE_ROOT / HIVE_ARTIFACTS are read from .env, matching the queen.
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.env.HIVE_ROOT ?? ".");
const ledgerPath = join(root, "data", "ledger.json");
const artifactsPath = join(root, process.env.HIVE_ARTIFACTS ?? "artifacts");
const alsoArtifacts = process.argv.includes("--all");

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
console.log(
  "[reset] done — the ledger rebuilds from customers/*.yaml on the next queen start." +
    (alsoArtifacts ? "" : "\n[reset] tip: `npm run reset -- --all` also clears the artifact store."),
);
