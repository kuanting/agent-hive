// End-to-end check of iBuddy Office: a running iBuddys server with the demo
// company seeded (npm run db:seed:demo-org, in iBuddys) plus a real agent-hive
// box started here (broker, Queen with the Hive Link, scoped workers in API
// dry-run mode, so no Ollama and no API keys). Drives everything through the
// iBuddys HTTP API as the demo users.
//
//   IBUDDYS_URL=http://127.0.0.1:5000 node demo/org/e2e.mjs
//
// Never point it at a production iBuddys: it changes the demo company's
// settings and budgets.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HIVE = new URL("../..", import.meta.url).pathname;
const API = (process.env.IBUDDYS_URL ?? "http://127.0.0.1:5000").replace(/\/$/, "");
const PASSWORD = process.env.DEMO_PASSWORD ?? "ibuddy-demo";
const tokens = {};
for (const u of ["wang", "lin", "chen", "wu"]) {
  const r = await fetch(`${API}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usernameOrEmail: `demo_${u}`, password: PASSWORD }) });
  if (!r.ok) throw new Error(`cannot log in as demo_${u} at ${API}: is the demo company seeded?`);
  tokens[u] = (await r.json()).tokens.accessToken;
}
const tok = (u) => tokens[u];
const BROKER_PORT = 18930;
const QUEEN_PORT = 14230;

const root = mkdtempSync(join(tmpdir(), "hive-e2e-"));
symlinkSync(join(HIVE, "customers"), join(root, "customers"), "dir");
symlinkSync(join(HIVE, "llm_model_api_catalog.yaml"), join(root, "llm_model_api_catalog.yaml"), "file");
mkdirSync(join(root, "data"));

function bee(agentId, extra, cap) {
  const path = join(root, `${agentId}.yaml`);
  writeFileSync(
    path,
    `agentId: ${agentId}\nsite: office\ncustomerId: sme-demo\n${extra}capabilities:\n  - runtime: api\n    model: gpt-5-mini\n${cap}`,
  );
  return path;
}
const configs = [
  bee("pb-mbr_lin", "ownerMemberId: mbr_lin\nbindGeneral: false\n", "    tier: 3\n    billing: local\n    skills: [general, files]\n"),
  bee("pb-mbr_chen", "ownerMemberId: mbr_chen\nbindGeneral: false\n", "    tier: 3\n    billing: local\n    skills: [general, files]\n"),
  bee("dept-accounting", "departmentId: dep_acct\nbindGeneral: false\n", "    tier: 3\n    billing: local\n    skills: [general, accounting]\n"),
  bee("shared-local", "", "    tier: 3\n    billing: local\n    skills: [general]\n"),
  bee("shared-cloud", "", "    tier: 2\n    billing: per-token\n    skills: [general]\n"),
];

const env = {
  ...process.env,
  NODE_OPTIONS: "",
  HIVE_ROOT: root,
  HIVE_BROKER: "mqtt",
  MQTT_URL: `mqtt://127.0.0.1:${BROKER_PORT}`,
  MQTT_BROKER_PORT: String(BROKER_PORT),
  MQTT_BROKER_HOST: "127.0.0.1",
  QUEEN_PORT: String(QUEEN_PORT),
  HIVE_LINK_URL: `${API.replace(/^http/, "ws")}/hive-link/v1`,
  HIVE_LINK_TOKEN: `hbx_demobox01_${process.env.DEMO_HIVE_LINK_SECRET ?? "demo-link-secret-change-me"}`,
  HIVE_LINK_CUSTOMER: "sme-demo",
  HIVE_API_DRYRUN: "1",
  OPENAI_API_KEY: "sk-e2e-not-used",
  HIVE_LOG_LEVEL: "info",
};
const kids = [];
const LOG = [];
const start = (name, args) => {
  const c = spawn("npx", ["tsx", ...args], { cwd: HIVE, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  c.stdout.on("data", (d) => { LOG.push(`${new Date().toISOString().slice(11,23)} [${name}] ${d}`); if (process.env.V) process.stdout.write(`[${name}] ${d}`); });
  c.stderr.on("data", (d) => { LOG.push(`${new Date().toISOString().slice(11,23)} [${name}] ${d}`); if (process.env.V) process.stderr.write(`[${name}] ${d}`); });
  kids.push(c);
};
const stopAll = () => kids.forEach((c) => { try { process.kill(-c.pid, "SIGKILL"); } catch {} });

async function call(user, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok(user)}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000, label = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await sleep(500);
  }
}
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`); };
async function taskById(user, member, id) {
  const r = await call(user, "GET", `/api/org/members/${member}`);
  return r.data?.tasks?.find((t) => t.id === id);
}
async function waitTask(user, member, id, statuses, ms = 30000) {
  return until(async () => {
    const t = await taskById(user, member, id);
    return t && statuses.includes(t.status) ? t : null;
  }, ms, `task ${id} -> ${statuses}`);
}

try {
  console.log("\n  iBuddy Office end to end\n");
  start("broker", ["packages/shared/src/bus/broker-entry.ts"]);
  await sleep(1500);
  start("queen", ["packages/queen/src/index.ts"]);
  configs.forEach((c, i) => start(`bee${i}`, ["packages/worker/src/index.ts", c]));

  // a clean slate for budgets a previous run may have changed
  await call("wang", "PATCH", "/api/org/members/mbr_chen", { monthlyBudgetUsd: 0.5 });
  await call("wang", "PATCH", "/api/org/settings", { supervisedMode: false });

  const me = await until(async () => {
    const r = await call("wang", "GET", "/api/org/me");
    return r.data?.box?.status === "online" ? r.data : null;
  }, 60000, "box online");
  check("the Hive Box connects and the owner sees it online", me.box.status === "online");

  const members = await until(async () => {
    const r = await call("wang", "GET", "/api/org/members");
    const lin = r.data?.members?.find((m) => m.publicId === "mbr_lin");
    return lin?.online ? r.data.members : null;
  }, 60000, "lin online");
  check("林小美's own agent shows online in the office", members.find((m) => m.publicId === "mbr_lin").online);
  await until(async () => {
    const r = await call("wang", "GET", "/api/org/hive-box");
    const live = (r.data?.box?.workers ?? []).filter((w) => w.live).length;
    return live >= 5;
  }, 60000, "all five agents live");
  await sleep(3000); // a per-token bee binds its queues only after its first lease
  check("吳佩珊 (no agent running) shows offline", !members.find((m) => m.publicId === "mbr_wu").online);

  // 1. owner assigns a file task to 林小美
  const a1 = await call("wang", "POST", "/api/org/members/mbr_lin/tasks", { title: "整理本週客戶報價", input: "列出未回覆的客戶", usesPersonalData: true });
  check("owner assigns 林小美's agent a task (202, box online)", a1.status === 202 && a1.data.boxOnline, JSON.stringify(a1.data));
  const t1 = await waitTask("wang", "mbr_lin", a1.data.task.id, ["done", "failed"]);
  check("it runs on 林小美's own agent, locally, at no cost", t1.status === "done" && t1.billing === "local" && t1.costUsd === 0 && t1.hasOutput, JSON.stringify(t1));
  check("the task records who assigned it", t1.assignedBy?.publicId === "mbr_wang");

  // 2. output privacy
  const o1 = await call("wang", "GET", `/api/org/tasks/${t1.id}/output`);
  check("owner cannot read the output while supervised mode is off (403)", o1.status === 403, String(o1.status));
  const o2 = await call("lin", "GET", `/api/org/tasks/${t1.id}/output`);
  check("林小美 can read her own output", o2.status === 200 && o2.data.output.includes("[dry-run]"), JSON.stringify(o2.data).slice(0, 120));
  const s1 = await call("wang", "PATCH", "/api/org/settings", { supervisedMode: true });
  check("owner turns on supervised mode", s1.status === 200);
  await sleep(800);
  const o3 = await call("wang", "GET", `/api/org/tasks/${t1.id}/output`);
  check("owner can read it once supervised mode is on", o3.status === 200, String(o3.status) + JSON.stringify(o3.data));
  const linView = await call("lin", "GET", "/api/org/members/mbr_lin");
  check("林小美 sees that the owner viewed her result", linView.data.outputViews.length >= 1 && linView.data.outputViews[0].by === "王老闆", JSON.stringify(linView.data.outputViews));
  const audit = await call("wang", "GET", "/api/org/audit");
  check("the view and the toggle are in the audit log", ["output.view", "supervised.toggle", "task.assign"].every((a) => audit.data.entries.some((e) => e.action === a)));
  await call("wang", "PATCH", "/api/org/settings", { supervisedMode: false });

  // 3. who can see whom
  const w1 = await call("wu", "GET", "/api/org/members/mbr_lin");
  check("an employee in another department cannot see 林小美 (404)", w1.status === 404, String(w1.status));
  const c1 = await call("chen", "GET", "/api/org/members/mbr_lin");
  check("the sales manager can see 林小美", c1.status === 200);
  const w2 = await call("wu", "GET", "/api/org/dashboard");
  check("an employee gets no dashboard (403)", w2.status === 403, String(w2.status));

  // 4. urgent hard task goes to the cloud API, then the member's cap forces local
  const a2 = await call("wang", "POST", "/api/org/members/mbr_chen/tasks", { title: "design a detailed English proposal", input: "Kaohsiung distributor", urgency: "urgent" });
  const t2 = await waitTask("wang", "mbr_chen", a2.data.task.id, ["done", "failed"]);
  check("an urgent hard task runs on the cloud API with a real cost", t2.status === "done" && t2.billing === "per-token" && t2.costUsd > 0, JSON.stringify(t2));
  await call("wang", "PATCH", "/api/org/members/mbr_chen", { monthlyBudgetUsd: 0.000001 });
  await sleep(800);
  const a3 = await call("wang", "POST", "/api/org/members/mbr_chen/tasks", { title: "design a second English proposal", input: "Tainan distributor", urgency: "urgent" });
  const t3 = await waitTask("wang", "mbr_chen", a3.data.task.id, ["done", "failed"]);
  check("past 陳志明's cap, the next one runs locally, marked degraded", t3.status === "done" && t3.billing === "local" && t3.degraded, JSON.stringify(t3));

  // 5. a task that must wait, then is cancelled
  const a4 = await call("wang", "POST", "/api/org/members/mbr_wu/tasks", { title: "盤點辦公用品", usesPersonalData: true });
  const t4 = await waitTask("wang", "mbr_wu", a4.data.task.id, ["deferred"]);
  check("a file task for 吳佩珊, whose agent is off, waits instead of borrowing another agent", t4.status === "deferred", JSON.stringify(t4));
  const cx = await call("wang", "POST", `/api/org/tasks/${t4.id}/cancel`);
  const t4b = await waitTask("wang", "mbr_wu", t4.id, ["cancelled"]);
  check("the owner cancels it and the desk goes back to idle", cx.status === 200 && t4b.status === "cancelled");

  // 6. department sandbox scope
  const a5 = await call("lin", "POST", "/api/org/members/mbr_lin/tasks", { title: "查應收帳款", department: "dep_acct" });
  const t5 = await waitTask("lin", "mbr_lin", a5.data.task.id, ["failed", "done"]);
  check("a sales employee's task aimed at the accounting share is refused", t5.status === "failed" && /out of scope/.test(t5.reason ?? ""), JSON.stringify(t5));
  // 張雅婷 has no token saved; the owner assigns it to her
  const a6 = await call("wang", "POST", "/api/org/members/mbr_chang/tasks", { title: "查應收帳款", department: "dep_acct" });
  const t6 = await waitTask("wang", "mbr_chang", a6.data.task.id, ["done", "failed"]);
  check("the same task for 張雅婷 (accounting) runs on the accounting sandbox", t6.status === "done" && t6.billing === "local", JSON.stringify(t6));

  // 7. chat through the link, on the same path the web page and desktop use
  const bot = members.find((m) => m.publicId === "mbr_lin").agent.shortId;
  const chat = await fetch(`${API}/ibuddy/${bot}/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok("lin")}`, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "早安，今天要追蹤哪些客戶？" }], detectEmotion: false }),
  });
  const chatBody = await chat.json().catch(() => ({}));
  check("林小美 chats with her agent through the Hive Link", chat.status === 200 && JSON.stringify(chatBody).includes("dry-run"), `${chat.status} ${JSON.stringify(chatBody).slice(0, 160)}`);

  // 8. numbers
  await sleep(1500);
  const dash = await call("wang", "GET", "/api/org/dashboard?days=7");
  const linRow = dash.data.members.find((m) => m.publicId === "mbr_lin");
  check("dashboard totals include live work and savings", dash.status === 200 && dash.data.totals.tasksOk > 0 && dash.data.totals.savedUsd > 0 && linRow.tasksOk > 0, JSON.stringify(dash.data.totals).slice(0, 200));
  const box = await call("wang", "GET", "/api/org/hive-box");
  check("the owner sees the box's agents in settings", (box.data.box.workers ?? []).some((w) => w.agentId === "dept-accounting" && w.scope === "department"));
} catch (err) {
  check(`ran to the end: ${err.message}`, false);
} finally {
  stopAll();
  if (results.some((r) => !r)) writeFileSync(join(root, "processes.log"), LOG.join(""));
  if (results.some((r) => !r)) console.log(`  process logs: ${join(root, "processes.log")}`);
  const failed = results.filter((r) => !r).length;
  console.log(`\n  ${results.length - failed}/${results.length} passed\n`);
  process.exit(failed ? 1 : 0);
}
