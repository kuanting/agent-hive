import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");

/**
 * A private hive root for one test file.
 *
 * `QueenCore.create(root)` reads three things off its root: `customers/` and
 * `llm_model_api_catalog.yaml`, which are read-only configuration, and
 * `data/ledger.json`, which it *writes* on every spend. Pointing tests at the
 * repo root meant every test file sharing that one mutable ledger — with the
 * live hive's, if one happened to be running on the same machine.
 *
 * That is what made `affinity.test.ts` and `delivery.test.ts` flake: vitest runs
 * files in parallel, so one could read the ledger while another was writing it.
 * Atomic writes (see `BudgetLedger.save`) close that particular window, but two
 * suites sharing one spend record is wrong independently of the race — each
 * would still see the other's numbers.
 *
 * So: the config is symlinked, because it is read-only and should stay in one
 * place, and `data/` is the test's own.
 *
 * Removing it afterwards is the run's job, not this helper's — see
 * vitest.globalSetup.ts, which scopes every test's temp directory to one folder
 * it deletes on teardown.
 */
export function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hive-root-"));
  symlinkSync(join(REPO, "customers"), join(root, "customers"), "dir");
  symlinkSync(join(REPO, "llm_model_api_catalog.yaml"), join(root, "llm_model_api_catalog.yaml"), "file");
  mkdirSync(join(root, "data"), { recursive: true });
  return root;
}

/**
 * A hive root whose customer profiles the test writes itself.
 *
 * `tmpRoot` symlinks the repo's real profiles, which is right when a test needs
 * *a* customer and wrong when it needs a specific policy: both shipped profiles
 * record episodes at `metadata` and declare the same two tools, so anything
 * asserting on a mode or on per-customer scoping would be asserting on demo
 * configuration that is free to change.
 *
 * @param profiles customerId -> yaml body
 */
export function tmpRootWithCustomers(profiles: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "hive-root-"));
  symlinkSync(join(REPO, "llm_model_api_catalog.yaml"), join(root, "llm_model_api_catalog.yaml"), "file");
  mkdirSync(join(root, "customers"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  for (const [id, body] of Object.entries(profiles)) {
    writeFileSync(join(root, "customers", `${id}.yaml`), body);
  }
  return root;
}
