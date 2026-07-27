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
import { accessSync, constants, existsSync } from "node:fs";
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

/** Whether a local OpenClaw gateway is listening (any HTTP response counts). */
async function openclawUp() {
  try {
    await fetch(`${OPENCLAW_URL}/v1/models`, { signal: AbortSignal.timeout(2500) });
    return true;
  } catch {
    return false;
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
    detail: localModels.slice(0, 3).join(", ") + (localModels.length > 3 ? `, +${localModels.length - 3} more` : ""),
    why: models === null ? `no Ollama daemon answering at ${OLLAMA_URL}` : "Ollama is running but has no local models (try `ollama pull gemma3:4b`)",
  },
  {
    key: "personal",
    icon: "🏡",
    label: "personal bee",
    tier: "tier 3 · personal data",
    config: "demo/workers/personal-bee.yaml",
    ready: openclaw || hermes || localModels.length > 0,
    detail: openclaw
      ? "OpenClaw gateway"
      : hermes
        ? "Hermes CLI"
        : `built-in mini agent on ${localModels[0] ?? "local model"}`,
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
const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}

for (const { name, cmd } of procs) {
  const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
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
    if (!shuttingDown) {
      console.error(`\n  ${name} exited (${code}) — shutting down the hive.\n`);
      shutdown(code ?? 1);
    }
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`  queen  http://localhost:${process.env.QUEEN_PORT ?? 4100}`);
if (!noConsole) console.log("  console  http://localhost:5180");
console.log("\n  next:  bash demo/walkthrough.sh   (in another terminal)");
console.log("         npm run watch             (live bee roster)\n");
