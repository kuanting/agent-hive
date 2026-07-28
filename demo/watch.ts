import "@hive/shared/env";
import { connect } from "mqtt";

/**
 * Live view of the hive for a second terminal: which bees are alive, what they
 * hold, how much seat quota and budget is left, and what is in flight right now.
 *
 *   npm run watch
 *
 * Two sources, deliberately: /status is the Queen's own view (polled), and the
 * raw MQTT topics are the wire itself (streamed). Seeing both makes it obvious
 * that the console isn't inventing anything — every task card corresponds to a
 * real message on hive.tasks.
 *
 * Solo/MQTT only. Under the amqp backend, watch the RabbitMQ UI on :15672.
 */

const QUEEN = process.env.QUEEN_URL ?? "http://localhost:4100";
const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const POLL_MS = 2000;
const FEED_LINES = 12;

const BEE_OF_TIER: Record<number, string> = { 1: "🍯", 2: "💵", 3: "🏠", 4: "🐝" };
const TIER_NAME: Record<number, string> = {
  1: "honey bee",
  2: "metered bee",
  3: "local bee",
  4: "worker bee",
};

interface Capability {
  tier: number;
  billing: string;
  agent?: string;
  runtime: string;
  model?: string;
  toolId?: string;
  skills?: string[];
  quotaWindow?: { seatId: string };
}
interface Status {
  workers: Array<{ agentId: string; site: string; capabilities: Capability[]; lastSeen: number }>;
  budget: {
    customers: Array<{ customerId: string; capUsd: number; spentUsd: number }>;
    seats: Array<{ seatId: string; tokensPerWindow: number; usedTokens: number; remaining: number }>;
  };
  plannerCostUsd: number;
  tasks: Array<{ taskId: string; spec: { title: string }; status: string; reason: string; tierUsed?: number }>;
}

const feed: string[] = [];
let status: Status | undefined;
let queenUp = false;

function note(line: string) {
  feed.push(line);
  while (feed.length > FEED_LINES) feed.shift();
}

// ---- wire tap ----

const client = connect(MQTT_URL, { clientId: `hive-watch-${process.pid}`, clean: true, reconnectPeriod: 2000 });
client.on("error", () => {}); // reported through the header instead of crashing
client.on("connect", () => {
  client.subscribe(["hive.tasks/#", "hive.control/#", "hive.telemetry/#"], { qos: 0 });
  note("\x1b[2mconnected to the broker\x1b[0m");
});
client.on("message", (topic, payload) => {
  let msg: Record<string, any> = {};
  try {
    msg = JSON.parse(payload.toString());
  } catch {
    return;
  }
  const routing = topic.split("/").slice(1).join(".");
  switch (msg.kind) {
    case "task":
      note(`\x1b[36m→ dispatch\x1b[0m ${msg.taskId}  ${routing}  tier ${msg.envelope?.tier} cap $${(msg.envelope?.maxUsd ?? 0).toFixed(4)}`);
      break;
    case "task.result": {
      const ok = msg.ok ? "\x1b[32m✓ result \x1b[0m" : "\x1b[31m✗ failed \x1b[0m";
      const cost = `$${(msg.usage?.costUsd ?? 0).toFixed(4)}`;
      const deg = msg.degraded ? " \x1b[33mdegraded\x1b[0m" : "";
      // agent = configured, runtime = what ran; unequal means it substituted.
      const ran = msg.agent && msg.agent !== msg.runtime ? `${msg.agent}→${msg.runtime}` : msg.runtime;
      note(`${ok} ${msg.taskId}  ${msg.agentId}  ${ran}${msg.model ? `/${msg.model}` : ""}  ${cost}${deg}`);
      if (!msg.ok && msg.error) note(`  \x1b[31m${String(msg.error).slice(0, 88)}\x1b[0m`);
      break;
    }
    case "agent.hello":
      note(`\x1b[2m↑ hello   ${msg.agentId} (${msg.capabilities?.length ?? 0} capabilities)\x1b[0m`);
      break;
    case "budget.request":
      note(`\x1b[2m$ lease requested by ${msg.agentId} (${msg.reason})\x1b[0m`);
      break;
    case "budget.grant":
      note(`\x1b[2m$ lease granted to ${msg.agentId}: $${msg.usdAllowance}, ${msg.quotaTokens} tokens\x1b[0m`);
      break;
    // heartbeats are deliberately not shown; they'd drown everything else
  }
});

// ---- queen poll ----

async function poll() {
  try {
    const res = await fetch(`${QUEEN}/status`, { signal: AbortSignal.timeout(1500) });
    status = (await res.json()) as Status;
    queenUp = true;
  } catch {
    queenUp = false;
  }
}

// ---- render ----

function bar(used: number, total: number, width = 20): string {
  const pct = total > 0 ? Math.min(1, used / total) : 0;
  const filled = Math.round(pct * width);
  const color = pct > 0.9 ? "\x1b[31m" : pct > 0.6 ? "\x1b[33m" : "\x1b[32m";
  return `${color}${"█".repeat(filled)}\x1b[2m${"░".repeat(width - filled)}\x1b[0m`;
}

function render() {
  const out: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);

  out.push("");
  out.push(`  \x1b[1magent-hive\x1b[0m  ${queenUp ? "\x1b[32m● queen up\x1b[0m" : "\x1b[31m● queen down\x1b[0m"}  \x1b[2m${QUEEN}\x1b[0m`);
  out.push("");

  if (status) {
    const now = Date.now();
    out.push("  \x1b[1mBEES\x1b[0m");
    if (status.workers.length === 0) out.push("    \x1b[2m(none registered)\x1b[0m");
    for (const w of status.workers) {
      const stale = now - w.lastSeen > 60_000;
      const tiers = [...new Set(w.capabilities.map((c) => c.tier))].sort();
      const icons = tiers.map((t) => BEE_OF_TIER[t] ?? "?").join("");
      const name = tiers.length === 1 ? TIER_NAME[tiers[0]] ?? "" : "multi-tier";
      out.push(
        `    ${icons} ${pad(w.agentId, 16)} ${pad(name, 13)} ${stale ? "\x1b[31mstale\x1b[0m" : "\x1b[32malive\x1b[0m"}  \x1b[2m${w.capabilities.length} capabilit${w.capabilities.length === 1 ? "y" : "ies"}\x1b[0m`,
      );
      for (const c of w.capabilities.slice(0, 5)) {
        // Two records can share a runtime/model and differ only by seat or
        // skills (the honey bee's tiny demo seat, for one), so show both.
        const what = `${c.agent ?? c.runtime}${c.model ? `/${c.model}` : ""}${c.toolId ? ` [${c.toolId}]` : ""}`;
        const seat = c.quotaWindow ? ` seat=${c.quotaWindow.seatId}` : "";
        const skills = c.skills?.length ? ` {${c.skills.join(",")}}` : "";
        out.push(`        \x1b[2mt${c.tier} ${pad(c.billing, 12)} ${pad(what, 26)}${seat}${skills}\x1b[0m`);
      }
      if (w.capabilities.length > 5) out.push(`        \x1b[2m… +${w.capabilities.length - 5} more\x1b[0m`);
    }

    out.push("");
    out.push("  \x1b[1mSEATS\x1b[0m \x1b[2m(prepaid quota, refills each window)\x1b[0m");
    for (const s of status.budget.seats) {
      out.push(
        `    ${pad(s.seatId, 16)} ${bar(s.usedTokens, s.tokensPerWindow)} ${s.usedTokens}/${s.tokensPerWindow}`,
      );
    }

    out.push("");
    out.push("  \x1b[1mBUDGET\x1b[0m \x1b[2m(real dollars, per-token only)\x1b[0m");
    for (const c of status.budget.customers) {
      out.push(
        `    ${pad(c.customerId, 16)} ${bar(c.spentUsd, c.capUsd)} $${c.spentUsd.toFixed(4)}/$${c.capUsd.toFixed(2)}`,
      );
    }
    out.push(`    ${pad("planner", 16)} \x1b[2m$${(status.plannerCostUsd ?? 0).toFixed(4)}\x1b[0m`);

    const active = status.tasks.filter((t) => t.status === "dispatched" || t.status === "deferred");
    out.push("");
    out.push(`  \x1b[1mIN FLIGHT\x1b[0m \x1b[2m(${status.tasks.length} tasks total)\x1b[0m`);
    if (active.length === 0) out.push("    \x1b[2m(idle)\x1b[0m");
    for (const t of active.slice(0, 6)) {
      const color = t.status === "deferred" ? "\x1b[33m" : "\x1b[36m";
      out.push(`    ${color}${pad(t.status, 10)}\x1b[0m ${pad(t.spec.title.slice(0, 28), 30)} \x1b[2m${t.reason.slice(0, 40)}\x1b[0m`);
    }
  }

  out.push("");
  out.push("  \x1b[1mWIRE\x1b[0m \x1b[2m(hive.tasks / hive.control / hive.telemetry)\x1b[0m");
  for (const line of feed) out.push(`    ${line}`);
  out.push("");
  out.push("  \x1b[2mctrl-c to stop\x1b[0m");

  process.stdout.write(`\x1b[H\x1b[2J${out.join("\n")}\n`);
}

process.on("SIGINT", () => {
  process.stdout.write("\x1b[?25h\n");
  client.end(true);
  process.exit(0);
});

process.stdout.write("\x1b[?25l"); // hide cursor
await poll();
render();
setInterval(async () => {
  await poll();
  render();
}, POLL_MS);
