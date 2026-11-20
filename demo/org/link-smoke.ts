/**
 * Smoke test for the box half of iBuddy Office, as real processes.
 *
 * Starts the embedded broker, a Queen with the Hive Link enabled, and one bee
 * scoped to member mbr_lin, then plays the cloud: a WebSocket server speaking
 * the link protocol, as iBuddys would. No database, no Ollama, no API keys: the
 * bee's capability is the API adapter in dry-run mode (HIVE_API_DRYRUN=1).
 *
 *   npx tsx demo/org/link-smoke.ts
 *
 * Checks, in order: the box connects and authenticates; the roster shows the
 * scoped bee; an assigned task runs on that member's bee and reports done; a
 * resent command is not run twice; the member can read the output and a
 * supervisor cannot while the org is unsupervised; a task for a member with no
 * agent in scope waits instead of borrowing someone else's; a chat turn comes
 * back; usage is rolled up per member.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { BoxToCloud, envelope, LINK_PATH, type Directory } from "@hive/link";

const REPO = resolve(import.meta.dirname, "../..");
const SECRET = "smoke-secret-0123456789abcdef";
const TOKEN = `hbx_smokebox_${SECRET}`;
const BROKER_PORT = 18830 + Math.floor(Math.random() * 100);
const QUEEN_PORT = 14100 + Math.floor(Math.random() * 100);

const root = mkdtempSync(join(tmpdir(), "hive-smoke-"));
symlinkSync(join(REPO, "customers"), join(root, "customers"), "dir");
symlinkSync(join(REPO, "llm_model_api_catalog.yaml"), join(root, "llm_model_api_catalog.yaml"), "file");
mkdirSync(join(root, "data"));
const workerConfig = join(root, "pb-smoke.yaml");
writeFileSync(
  workerConfig,
  `agentId: pb-smoke
site: office
customerId: sme-demo
ownerMemberId: mbr_lin
bindGeneral: false
capabilities:
  - runtime: api
    model: gpt-5-mini
    tier: 3
    billing: local   # a test fixture: dry-run costs nothing, so price it as local
    skills: [general, files]
`,
);

const directory: Directory = {
  version: 1,
  org: { orgId: "org_smoke", hiveCustomerId: "sme-demo", supervised: false, monthlyBudgetUsd: 30, referenceModel: "gpt-5.4" },
  departments: [{ departmentId: "dep_sales", slug: "sales", monthlyBudgetUsd: null }],
  members: [
    { memberId: "mbr_lin", role: "employee", status: "active", departmentIds: ["dep_sales"], monthlyBudgetUsd: 1, approvalPolicy: "personal-data" },
    { memberId: "mbr_chen", role: "manager", status: "active", departmentIds: ["dep_sales"], monthlyBudgetUsd: 1, approvalPolicy: "personal-data" },
  ],
};

// ---------- the stand-in cloud ----------

const received: BoxToCloud[] = [];
const waiters: Array<{ match: (m: BoxToCloud) => boolean; resolve: (m: BoxToCloud) => void }> = [];
let box: WebSocket | undefined;

const wss = new WebSocketServer({ port: 0, path: LINK_PATH });
wss.on("connection", (ws, req) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    ws.close(4001, "bad token");
    return;
  }
  box = ws;
  ws.on("message", (data) => {
    const msg = BoxToCloud.parse(JSON.parse(String(data)));
    received.push(msg);
    if (msg.type === "link.hello") {
      send("link.welcome", { boxId: msg.body.boxId, orgId: "org_smoke", serverTime: Date.now(), lastEventSeq: 0 });
      send("directory.sync", directory);
    }
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
});
const linkPort = await new Promise<number>((r) => wss.on("listening", () => r((wss.address() as { port: number }).port)));

function send(type: string, body: unknown) {
  box?.send(JSON.stringify(envelope(type, body)));
}

function waitFor<T extends BoxToCloud["type"]>(
  type: T,
  match: (m: Extract<BoxToCloud, { type: T }>) => boolean = () => true,
  timeoutMs = 20_000,
): Promise<Extract<BoxToCloud, { type: T }>> {
  const already = received.find((m) => m.type === type && match(m as Extract<BoxToCloud, { type: T }>));
  if (already) return Promise.resolve(already as Extract<BoxToCloud, { type: T }>);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    waiters.push({
      match: (m) => m.type === type && match(m as Extract<BoxToCloud, { type: T }>),
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m as Extract<BoxToCloud, { type: T }>);
      },
    });
  });
}

// ---------- the box ----------

const env = {
  ...process.env,
  HIVE_ROOT: root,
  HIVE_BROKER: "mqtt",
  MQTT_URL: `mqtt://127.0.0.1:${BROKER_PORT}`,
  MQTT_BROKER_PORT: String(BROKER_PORT),
  MQTT_BROKER_HOST: "127.0.0.1",
  QUEEN_PORT: String(QUEEN_PORT),
  HIVE_LINK_URL: `ws://127.0.0.1:${linkPort}${LINK_PATH}`,
  HIVE_LINK_TOKEN: TOKEN,
  HIVE_LINK_CUSTOMER: "sme-demo",
  HIVE_API_DRYRUN: "1",
  OPENAI_API_KEY: "sk-smoke-not-used",
  HIVE_LOG_LEVEL: process.env.HIVE_LOG_LEVEL ?? "warn",
};
const children: ChildProcess[] = [];
function start(name: string, args: string[]) {
  const child = spawn("npx", ["tsx", ...args], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const verbose = process.env.SMOKE_VERBOSE === "1";
  child.stdout?.on("data", (d) => verbose && process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d) => verbose && process.stderr.write(`[${name}] ${d}`));
  children.push(child);
}
function stopAll() {
  for (const c of children) {
    try {
      process.kill(-c.pid!, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  wss.close();
}

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
};

try {
  start("broker", ["packages/shared/src/bus/broker-entry.ts"]);
  await new Promise((r) => setTimeout(r, 1500));
  start("queen", ["packages/queen/src/index.ts"]);
  start("worker", ["packages/worker/src/index.ts", workerConfig]);
  console.log("\n  iBuddy Office link smoke test\n");

  const hello = await waitFor("link.hello", undefined, 40_000);
  check("box connects with its token and says hello", hello.body.boxId === "smokebox" && hello.body.customerId === "sme-demo");

  const roster = await waitFor("roster.snapshot", (m) => m.body.workers.some((w) => w.agentId === "pb-smoke" && w.live), 40_000);
  const bee = roster.body.workers.find((w) => w.agentId === "pb-smoke")!;
  check("roster shows the member's own bee, scoped to that member", bee.scope === "member" && bee.memberId === "mbr_lin");

  const assign = {
    seq: 1,
    clientRef: "ct_smoke1",
    memberId: "mbr_lin",
    assignedBy: "mbr_chen",
    origin: "owner-assign",
    title: "整理本週客戶報價",
    input: "列出未回覆的客戶",
    skills: ["files"],
    sensitivity: "normal",
    urgency: "normal",
    requireApproval: false,
  };
  send("task.assign", assign);
  const ack = await waitFor("command.ack", (m) => m.body.seq === 1);
  check("assigned task is acknowledged with a hive task id", ack.body.ok && !!ack.body.taskId);

  const done = await waitFor("task.event", (m) => m.body.task.clientRef === "ct_smoke1" && m.body.task.status === "done");
  const t = done.body.task;
  check("task ran on that member's bee and reported done", t.agentId === "pb-smoke" && t.memberId === "mbr_lin" && t.departmentId === "dep_sales");
  check("done event carries metadata, a counterfactual price, and no output", t.hasOutput && t.usage.counterfactualUsd > 0 && !JSON.stringify(done).includes("[dry-run]"));

  send("task.assign", assign);
  const reAck = await waitFor("command.ack", (m) => m.body.seq === 1 && m !== ack);
  await new Promise((r) => setTimeout(r, 800));
  const newTasks = received.filter((m) => m.type === "task.event" && m.body.task.taskId !== t.taskId && m.body.task.clientRef === "ct_smoke1");
  check("a resent command is acknowledged again, not run twice", reAck.body.taskId === ack.body.taskId && newTasks.length === 0);

  send("task.content.request", { requestId: "r-self", taskId: t.taskId, requesterMemberId: "mbr_lin", reason: "self" });
  const own = await waitFor("task.content", (m) => m.body.requestId === "r-self");
  check("the member can read their own output", own.body.ok && (own.body.output ?? "").includes("[dry-run]"));

  send("task.content.request", { requestId: "r-boss", taskId: t.taskId, requesterMemberId: "mbr_chen", reason: "supervised" });
  const boss = await waitFor("task.content", (m) => m.body.requestId === "r-boss");
  check("a supervisor cannot read it while the org is not supervised", !boss.body.ok);

  send("task.assign", { ...assign, seq: 2, clientRef: "ct_smoke2", memberId: "mbr_chen", skills: ["files"] });
  const waiting = await waitFor("task.event", (m) => m.body.task.clientRef === "ct_smoke2" && m.body.task.status !== "queued");
  check(
    "a task needing another member's files waits for their own agent",
    waiting.body.task.status === "deferred" && /own agent/.test(waiting.body.task.reason ?? ""),
  );

  send("chat.request", {
    requestId: "c1",
    memberId: "mbr_lin",
    body: { model: "hive/auto", messages: [{ role: "user", content: "早安，今天有什麼要追蹤的？" }] },
    timeoutMs: 30_000,
  });
  const chat = await waitFor("chat.response", (m) => m.body.requestId === "c1");
  check("a member's chat turn comes back as an OpenAI completion", chat.body.ok && Array.isArray((chat.body.body as any).choices));

  const rollup = await waitFor("usage.rollup", (m) => m.body.buckets.some((b) => b.memberKey === "mbr_lin" && b.tasksOk >= 1));
  check("usage is rolled up per member", rollup.body.buckets.some((b) => b.memberKey === "mbr_lin"));
} catch (err) {
  check(`smoke test ran to the end (${(err as Error).message})`, false);
} finally {
  stopAll();
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n  ${checks.length - failed}/${checks.length} passed\n`);
  process.exit(failed ? 1 : 0);
}
