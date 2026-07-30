import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Give the whole test run one scratch directory, and delete it afterwards.
 *
 * Tests make their own temp directories with `mkdtempSync(join(tmpdir(), ...))`
 * in fourteen places across the suite, under a dozen different prefixes, and
 * none of them clean up. A few weeks of `npm test` leaves hundreds of
 * `hive-sec-*` and `hive-led-*` directories in /tmp.
 *
 * Adding a teardown to each call site would fix today's fourteen and rely on the
 * fifteenth remembering. Redirecting `tmpdir()` fixes all of them at once,
 * including the ones not written yet: Node reads TMPDIR on every call, so
 * pointing it at a run-scoped directory puts every scratch file inside something
 * we can delete wholesale.
 *
 * This runs in the main process before the worker pool starts, which is what
 * lets the workers inherit the override.
 */
let root: string | undefined;

export function setup(): void {
  root = mkdtempSync(join(tmpdir(), "hive-test-run-"));
  process.env.TMPDIR = root;
  // Windows reads TMP/TEMP rather than TMPDIR; setting all three costs nothing.
  process.env.TMP = root;
  process.env.TEMP = root;
}

export function teardown(): void {
  // force: a test that already removed its own directory must not fail the run.
  if (root) rmSync(root, { recursive: true, force: true });
}
