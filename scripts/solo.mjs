// Solo launcher: bring up the whole hive on one machine, with every kind of bee
// this host can actually run.
//
//   npm run solo                      -> broker + queen + console + every viable bee
//   npm run solo -- --frontier        -> metered bee uses the frontier model profile
//   npm run solo -- --only=local,worker  -> just those bees
//   npm run solo -- --no-console      -> skip the web console
//   npm run solo -- --dry-run         -> print the roster and exit, start nothing
//
// Each bee owns exactly one tier, which is what lets them share the embedded MQTT
// broker. Aedes has no shared subscriptions, so it can't split one task between
// two workers that serve the same tier+skill — but bees with *disjoint* tiers
// never contend, and every task has exactly one taker. (Use the amqp backend when
// you want several workers on the SAME tier.)
//
// Bees whose dependencies are missing are simply not started, and the roster says
// why. Worker bees need nothing, so a bare `npm install` still gets a live hive.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OPENCLAW_URL = process.env.OPENCLAW_URL ?? "http://localhost:18789";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const frontier = has("--frontier");
const noConsole = has("--no-console");
const dryRun = has("--dry-run");
const onlyArg = args.find((a) => a.startsWith("--only="));
// iBuddy Office demo: `--org=sme-demo` adds the company's member and department
// bees from demo/org/workers, binds the broker to loopback, and dials the Hive
// Link to a local iBuddys. `--skip=mbr_lin` leaves a member's bee to their
// desktop app instead.
const orgArg = args.find((a) => a.startsWith("--org="));
const org = orgArg ? orgArg.slice("--org=".length) : null;
const skipArg = args.find((a) => a.startsWith("--skip="));
const skip = new Set(skipArg ? skipArg.slice("--skip=".length).split(",").map((s) => s.trim()) : []);
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim())) : null;

// ---- probes ----

/** Whether a command resolves to an executable on PATH. Same rule the worker's preflight uses. */
function onPath(command) {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function anyKey(...names) {
  return names.filter((n) => process.env[n]?.trim());
}

async function ollamaModels() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return null;
  }
}

/**
 * Whether a local OpenClaw gateway is serving an OpenAI-compatible surface.
 * Reachability alone isn't enough: OpenClaw's control UI shares the port and
 * answers 200 HTML for any GET, so a bare check claims a gateway that can't
 * take a chat call — and hides the next backend in the chain. Mirrors
 * openclawUp() in packages/adapters/src/personal-agent.
 */
async function openclawUp() {
  try {
    const res = await fetch(`${OPENCLAW_URL}/v1/models`, { signal: AbortSignal.timeout(2500) });
    return res.ok && (res.headers.get("content-type") ?? "").includes("json");
  } catch {
    return false;
  }
}

/**
 * The agents a bee's config declares. The hive advertises what the operator
 * harnessed, so the roster reads the same configs the worker will — rather than
 * listing every model on the machine, which says nothing about what will run.
 */
function configuredAgents(configPath) {
  try {
    const cfg = parse(readFileSync(join(ROOT, configPath), "utf8"));
    const caps = cfg?.capabilities ?? [];
    const names = [...new Set(caps.map((c) => c.agent ?? c.runtime).filter(Boolean))];
    return names;
  } catch {
    return [];
  }
}

// ---- roster ----

const models = await ollamaModels();
const openclaw = await openclawUp();
const hermes = onPath(process.env.HERMES_CMD ?? "hermes");
const claude = onPath("claude");
const codex = onPath("codex");
const openaiKeys = anyKey("OPENAI_API_KEY");
const anthropicKeys = anyKey("ANTHROPIC_API_KEY");
const googleKeys = anyKey("GEMINI_API_KEY", "GOOGLE_API_KEY");
const apiProviders = [
  ...(openaiKeys.length ? ["OpenAI"] : []),
  ...(anthropicKeys.length ? ["Anthropic"] : []),
  ...(googleKeys.length ? ["Google"] : []),
];
const localModels = (models ?? []).filter((m) => !/cloud/.test(m));

const bees = [
  {
    key: "honey",
    icon: "🍯",
    label: "honey bee",
    tier: "tier 1 · subscription seats",
    config: "demo/workers/honey-bee.yaml",
    ready: claude || codex,
    detail: claude && codex ? "claude + codex" : claude ? "claude (codex missing)" : codex ? "codex (claude missing)" : "",
    why: "neither `claude` nor `codex` is on PATH",
  },
  {
    key: "metered",
    icon: "💵",
    label: "metered bee",
    tier: "tier 2 · per-token API",
    config: frontier ? "demo/workers/metered-bee-frontier.yaml" : "demo/workers/metered-bee.yaml",
    ready: apiProviders.length > 0,
    detail: `${apiProviders.join(", ")}${frontier ? " · frontier profile" : ""}`,
    why: "no OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY set",
  },
  {
    key: "local",
    icon: "🏠",
    label: "local bee",
    tier: "tier 3 · local models",
    config: "demo/workers/local-bee.yaml",
    ready: localModels.length > 0,
    detail: `${configuredAgents("demo/workers/local-bee.yaml").join(", ") || "none configured"} · ${localModels.length} model${localModels.length === 1 ? "" : "s"} on this host`,
    why: models === null ? `no Ollama daemon answering at ${OLLAMA_URL}` : "Ollama is running but has no local models (try `ollama pull gemma4:12b`)",
  },
  {
    key: "personal",
    icon: "🏡",
    label: "personal bee",
    tier: "tier 3 · personal data",
    config: "demo/workers/personal-bee.yaml",
    ready: openclaw || hermes || localModels.length > 0,
    // Lead with what the bee is configured to run; then every backend that can
    // actually serve it, in the order the adapter will try them. Showing only
    // the winner once made an installed Hermes look undetected.
    detail: (() => {
      const configured = configuredAgents("demo/workers/personal-bee.yaml");
      const chain = [
        ...(openclaw ? ["openclaw"] : []),
        ...(hermes ? ["hermes"] : []),
        ...(localModels.length ? ["personal-mini"] : []),
      ];
      const named = configured[0];
      const ok = !named || chain.includes(named) || named === "personal";
      return `${configured.join(", ") || "default chain"}${ok ? "" : " (UNAVAILABLE — will fall back)"} · via ${chain.join(" → ")}`;
    })(),
    why: `no OpenClaw gateway at ${OPENCLAW_URL}, no \`hermes\` on PATH, and no local Ollama models`,
  },
  {
    key: "worker",
    icon: "🐝",
    label: "worker bee",
    tier: "tier 4 · tools, no LLM",
    config: "demo/workers/worker-bee.yaml",
    ready: true,
    detail: "csv-report, log-extract",
    why: "",
  },
];

if (org) {
  // The shared personal bee reads one person's folder; in a company it would be
  // nobody's, and member scope never routes to it anyway. Leave it out.
  bees.splice(bees.findIndex((b) => b.key === "personal"), 1);
  const dir = join(ROOT, "demo", "org", "workers");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const cfg = parse(readFileSync(join(dir, file), "utf8"));
    const owner = cfg.ownerMemberId ?? cfg.departmentId;
    if (skip.has(owner)) continue;
    bees.push({
      key: cfg.agentId,
      icon: cfg.departmentId ? "🗂️" : "🧑‍💼",
      label: cfg.agentId,
      tier: cfg.departmentId ? `dept · ${cfg.departmentId}` : `member · ${cfg.ownerMemberId}`,
      config: `demo/org/workers/${file}`,
      // personal-mini only, so it needs a local model
      ready: localModels.length > 0,
      detail: `personal-mini over ${cfg.personalDataDir}`,
      why: models === null ? `no Ollama daemon answering at ${OLLAMA_URL}` : "Ollama has no local models",
    });
  }
}

const selected = bees.filter((b) => b.ready && (!only || only.has(b.key)));
const skipped = bees.filter((b) => !selected.includes(b));

console.log("\n  agent-hive · solo\n");
for (const b of bees) {
  const chosen = selected.includes(b);
  const mark = chosen ? "✓" : "·";
  const note = chosen
    ? b.detail
    : !b.ready
      ? b.why
      : "excluded by --only";
  console.log(`  ${mark} ${b.icon} ${b.label.padEnd(12)} ${b.tier.padEnd(26)} ${note}`);
}
console.log();

for (const b of selected) {
  if (!existsSync(join(ROOT, b.config))) {
    console.error(`  missing config: ${b.config}`);
    process.exit(1);
  }
}

if (selected.length === 0) {
  console.error("  no bees selected — nothing to run.\n");
  process.exit(1);
}
if (!selected.some((b) => b.key !== "worker")) {
  console.log("  Only worker bees: tool tasks will run, anything needing an LLM will defer.");
  console.log("  Install Ollama, log into `claude`/`codex`, or set an API key to add more bees.\n");
}
if (dryRun) process.exit(0);

// ---- launch ----

const procs = [
  { name: "broker", cmd: ["npm", "run", "broker"] },
  { name: "queen", cmd: ["npm", "run", "queen"] },
  ...selected.map((b) => ({ name: b.key, cmd: ["npm", "run", "worker", "--", b.config] })),
  ...(noConsole ? [] : [{ name: "console", cmd: ["npm", "run", "console"] }]),
];

const env = { ...process.env, HIVE_BROKER: "mqtt" };
if (org) {
  // Loopback only: the embedded broker has no auth, and on one demo machine nothing else needs it.
  env.MQTT_BROKER_HOST ??= "127.0.0.1";
  env.HIVE_LINK_CUSTOMER ??= org;
  // The iBuddys demo seed pre-enrolls this box with this token; override both
  // to point at a real deployment.
  env.HIVE_LINK_URL ??= "ws://127.0.0.1:5000/hive-link/v1";
  env.HIVE_LINK_TOKEN ??= `hbx_demobox01_${process.env.DEMO_HIVE_LINK_SECRET ?? "demo-link-secret-change-me"}`;
  console.log(`  hive link -> ${env.HIVE_LINK_URL} (customer ${org})${skip.size ? ` · left to the desktop: ${[...skip].join(", ")}` : ""}\n`);
}
const children = [];
let shuttingDown = false;

/**
 * How long the launcher waits before killing what is left.
 *
 * Sized to sit OUTSIDE the drain it is supervising, and the ordering is the
 * whole point: a bee drains for up to HIVE_DRAIN_GRACE_MS, the Queen waits for
 * those farewells for up to HIVE_SHUTDOWN_WAIT_MS, and only then may the
 * launcher lose patience. This was 8 seconds, which is shorter than any of them
 * — so `npm run stop` would order a drain, the Queen would exit, the launcher
 * would read that as a crash, and SIGKILL the bees eight seconds later while
 * they were still finishing paid-for work. Measured: a 50-second task died at
 * the 8-second mark and its result was never published.
 *
 * Waiting longer costs nothing in the ordinary case, because shutdown() waits on
 * the children's actual exits and only falls back to this deadline for
 * stragglers.
 */
const SHUTDOWN_GRACE_MS = Number(
  process.env.HIVE_SHUTDOWN_GRACE_MS ?? Number(process.env.HIVE_SHUTDOWN_WAIT_MS ?? 75_000) + 15_000,
);

/**
 * Signal a child's whole process group, not just the process we spawned.
 *
 * `npm run worker -- x.yaml` is four processes deep — npm, its `sh -c`, the tsx
 * launcher, and finally the worker — and a signal to the top of that chain does
 * not reliably reach the bottom. Spawning detached makes each child a process
 * group leader, so the negative pid addresses every descendant at once.
 *
 * Failure is expected and ignored: by the time we escalate, the group has
 * usually exited and ESRCH is the normal answer.
 */
function signalGroup(child, sig) {
  try {
    process.kill(-child.pid, sig);
  } catch {
    /* already gone */
  }
}

/**
 * Take the whole hive down, and do not return until it is actually down.
 *
 * This used to SIGTERM each direct child and then `process.exit` 500ms later
 * regardless. Both halves were wrong. The signal reached only the npm wrapper,
 * and the deadline was far shorter than a bee's real work — adapters allow a
 * task 300 seconds — so the launcher exited while its grandchildren were still
 * mid-task. They survived, were reparented to init, and kept consuming from the
 * broker: invisible bees still taking work and still spending tokens, which is
 * the expensive kind of leak in a system that measures itself in tokens.
 *
 * So: signal the group, wait for every child to actually exit, and only then
 * leave. Anything still alive at the deadline is killed outright rather than
 * abandoned.
 */
/**
 * Ask the Queen to drain the hive before we start signalling processes.
 *
 * Same path a distributed operator uses, so local and multi-machine shutdowns
 * behave alike — and it is the only one that finishes in-flight work instead of
 * severing it. A bee two minutes into a model call has already spent those
 * tokens; SIGTERM throws that away, draining does not.
 *
 * Best-effort by design: if the Queen is already gone, never came up, or is
 * wedged, the signalling below still stops everything. This only ever improves
 * the outcome, so nothing here is allowed to block it for long.
 */
async function askQueenToDrain() {
  const port = process.env.QUEEN_PORT ?? 4100;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "shutdown", reason: "npm run solo stopped" }),
      signal: AbortSignal.timeout(SHUTDOWN_GRACE_MS),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      console.log(`\n  hive drained: ${body.confirmed?.length ?? 0} bee(s) confirmed, ${body.drained ?? 0} task(s) finished\n`);
      return true;
    }
  } catch {
    /* Queen down or slow — the signals below are the backstop */
  }
  return false;
}

async function shutdown(code, { askQueen = true } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;

  // Only ask when WE are the ones deciding. If a child already stopped cleanly,
  // someone else is orchestrating this — `npm run stop`, or the Queen acting on
  // an order — and a second request would publish a duplicate shutdown while the
  // first is still draining, then log a confusing "npm run solo stopped" on top
  // of it. Follow that teardown rather than starting a competing one.
  if (askQueen) await askQueenToDrain();

  const alive = children.filter((c) => c.exitCode === null && c.signalCode === null);
  if (alive.length === 0) process.exit(code);

  for (const child of alive) signalGroup(child, "SIGTERM");

  const exited = Promise.all(
    alive.map((child) => new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)))),
  );
  const deadline = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
  await Promise.race([exited, deadline]);

  const stubborn = alive.filter((c) => c.exitCode === null && c.signalCode === null);
  if (stubborn.length > 0) {
    console.error(`\n  ${stubborn.length} process(es) ignored SIGTERM after ${SHUTDOWN_GRACE_MS}ms — killing.\n`);
    for (const child of stubborn) signalGroup(child, "SIGKILL");
  }
  process.exit(code);
}

for (const { name, cmd } of procs) {
  // detached: each child leads its own process group, so shutdown() can signal
  // the entire chain. It also takes them out of this terminal's foreground
  // group, which means Ctrl-C no longer reaches them by accident — deliberate,
  // since relying on tty semantics is exactly what made cleanup depend on HOW
  // you stopped the launcher. Every exit path now runs the same code.
  const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  children.push(child);
  const prefix = `[${name}]`;
  const relay = (stream, sink) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      // The services already prefix their own lines; add ours only when they don't.
      for (const line of lines) sink.write(line.startsWith("[") ? `${line}\n` : `${prefix} ${line}\n`);
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    // Exit 0 is an orderly stop, not a crash — it is what a bee does when the
    // Queen orders a drain, or `npm run stop` takes the hive down from outside.
    // The rest still follows it down (the hive is going away either way), but
    // saying "crashed" about a clean exit sends people looking for a fault that
    // is not there.
    // A clean exit is not a reason to tear anything down, and treating it as one
    // broke `npm run stop`: the Queen orders a drain, the idle bees finish
    // instantly and exit 0, and the launcher read the first of those as a crash
    // and SIGTERM'd everything — including the Queen, which was still waiting on
    // the bee that had actual work to finish. The task died and its result was
    // never published.
    //
    // So a clean exit is just noted. The hive is down when every child is down,
    // and the Queen is deliberately last, which makes "nothing left" the honest
    // signal rather than "something moved".
    if (code === 0) {
      console.log(`  ${name} stopped.`);
      // The Queen is deliberately the last hive member to go, so its clean exit
      // means the hive is finished. What is left — the broker, the console — is
      // infrastructure that exists only to serve it, and nothing else will ever
      // tell those to stop. Without this, `npm run stop` left a broker holding
      // :1883 and a launcher waiting for a child that never exits.
      if (name === "queen") void shutdown(0, { askQueen: false });
      else if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) {
        console.log("\n  hive stopped.\n");
        process.exit(0);
      }
      return;
    }
    console.error(`\n  ${name} exited (${code}) — shutting down the hive.\n`);
    void shutdown(code ?? 1);
  });
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
// A closed terminal is a shutdown too, and the one most likely to strand a hive:
// nothing else would have told the launcher to clean up.
process.on("SIGHUP", () => void shutdown(0));

console.log(`  queen  http://localhost:${process.env.QUEEN_PORT ?? 4100}`);
if (!noConsole) console.log("  console  http://localhost:5180");
console.log("\n  next:  bash demo/walkthrough.sh   (in another terminal)");
console.log("         npm run watch             (live bee roster)\n");
