// Stop the hive: every bee drains and exits, then the Queen.
//
//   npm run stop            -> show what will stop, ask, then do it
//   npm run stop -- --yes   -> no prompt (scripts, CI, teardown hooks)
//
// This lives on the machine rather than in the console on purpose. There is no
// user authentication yet, so admin capability is confined to the hive's own
// host — and a browser is not that host. The Queen refuses the route from
// anything but loopback, but a dev-server proxy forwards from its own process,
// which makes that guard look like protection while providing none. Keeping the
// command here is what actually enforces it.
//
// See docs/DESIGN.md, "Roles", for the admin/user split this stands in for.
import { createInterface } from "node:readline/promises";

const args = process.argv.slice(2);
const assumeYes = args.includes("--yes") || args.includes("-y");
const reason = args.find((a) => !a.startsWith("-")) ?? "npm run stop";

const PORT = process.env.QUEEN_PORT ?? 4100;
const QUEEN = process.env.QUEEN_URL ?? `http://127.0.0.1:${PORT}`;

/** A hive that is not running is already stopped: say so and succeed. */
function alreadyDown(err) {
  console.log(`\n  No hive answering at ${QUEEN} — nothing to stop.\n`);
  if (process.env.HIVE_DEBUG) console.error(err);
  process.exit(0);
}

let status;
try {
  const res = await fetch(`${QUEEN}/status`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  status = await res.json();
} catch (err) {
  alreadyDown(err);
}

const live = (status.workers ?? []).filter((w) => Date.now() - w.lastSeen < 60_000);
const running = (status.tasks ?? []).filter((t) => t.status === "dispatched" || t.status === "deferred");

console.log("\n  Stop the hive?\n");
console.log(`    ${live.length} bee(s): ${live.map((w) => w.agentId).join(", ") || "(none registered)"}`);
if (running.length > 0) {
  // Worth stating precisely: a task in flight is finished and its result
  // published, not thrown away. That is the whole reason draining exists — the
  // tokens are already spent, so abandoning the work wastes them twice.
  console.log(`    ${running.length} task(s) in flight — each is finished first, not abandoned`);
  for (const t of running.slice(0, 5)) console.log(`      · ${t.taskId} ${t.spec?.title ?? ""}`);
} else {
  console.log("    nothing in flight");
}
console.log();

if (!assumeYes) {
  // Refuse rather than prompt when nobody can answer. A teardown script that
  // blocks forever on a question is worse than one that fails loudly.
  if (!process.stdin.isTTY) {
    console.error("  Refusing to prompt: stdin is not a terminal. Re-run with --yes.\n");
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("  Type 'yes' to stop the hive: ")).trim().toLowerCase();
  rl.close();
  if (answer !== "yes" && answer !== "y") {
    console.log("\n  Left running.\n");
    process.exit(0);
  }
}

let outcome;
try {
  const res = await fetch(`${QUEEN}/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "shutdown", reason }),
    // Longer than the Queen's own wait for the fleet, so the request outlives
    // the drain rather than timing out on top of a shutdown that is working.
    signal: AbortSignal.timeout(Number(process.env.HIVE_SHUTDOWN_WAIT_MS ?? 75_000) + 15_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(`\n  Queen refused: ${body.error ?? res.status}\n`);
    process.exit(1);
  }
  outcome = await res.json();
} catch (err) {
  // The Queen exits as part of this, so a dropped connection is an expected
  // ending rather than a failure — but it means we cannot report the details.
  console.log("\n  Connection closed while stopping (the Queen exits last). Check with `ss -tlnp`.\n");
  if (process.env.HIVE_DEBUG) console.error(err);
  process.exit(0);
}

const { confirmed = [], silent = [], drained = 0 } = outcome;
console.log(`\n  Hive stopped. ${confirmed.length} bee(s) confirmed${drained ? `, ${drained} task(s) finished while draining` : ""}.`);
if (silent.length > 0) console.log(`  No goodbye from: ${silent.join(", ")} — check for leftover processes.`);
console.log();
