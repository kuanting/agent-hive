import { beforeEach, describe, expect, it } from "vitest";
import { directQueueKey, EXCHANGES, type Bus, type TaskResult } from "@hive/shared";
import { envelope, type BoxToCloud, type CloudToBox, type Directory } from "@hive/link";
import { QueenCore } from "../src/core.js";
import { LinkBridge, type LinkTransport } from "../src/link-bridge.js";
import { tmpRootWithCustomers } from "./tmpRoot.js";

/**
 * The bridge between the Hive Link and the Queen, driven end to end through a
 * real QueenCore with a fake bus on one side and a fake link on the other.
 *
 * What it must get right: a cloud command becomes exactly one scoped hive task,
 * the cloud hears every state change, outputs never leave without a permitted
 * request, and a confidential title stays on the box.
 */

const SME = `
customerId: sme-demo
name: SME demo
budget:
  capUsd: 30
policy:
  onBudgetBlock: degrade
  recordEpisodes: off
`;

const DIRECTORY: Directory = {
  version: 1,
  org: { orgId: "org_demo", hiveCustomerId: "sme-demo", supervised: false, monthlyBudgetUsd: 30, referenceModel: "gpt-5.4" },
  departments: [{ departmentId: "dep_sales", slug: "sales", monthlyBudgetUsd: 10 }],
  members: [
    { memberId: "mbr_lin", role: "employee", status: "active", departmentIds: ["dep_sales"], monthlyBudgetUsd: 2, approvalPolicy: "personal-data" },
    { memberId: "mbr_wang", role: "owner", status: "active", departmentIds: [], monthlyBudgetUsd: null, approvalPolicy: "never" },
    { memberId: "mbr_gone", role: "employee", status: "suspended", departmentIds: [], monthlyBudgetUsd: null, approvalPolicy: "never" },
  ],
};

function fakeBus() {
  const published: Array<{ exchange: string; key: string; payload: Record<string, any> }> = [];
  const handlers = new Map<string, (msg: unknown, rk: string) => Promise<void>>();
  const bus: Bus = {
    publish(exchange, key, payload) {
      published.push({ exchange, key, payload: payload as Record<string, any> });
    },
    async consume(_e, queue, _p, schema, handler) {
      handlers.set(queue, (msg, rk) => handler(schema.parse(msg), rk));
    },
    async pause() {},
    async close() {},
  };
  return {
    bus,
    deliver: (queue: string, msg: unknown) => handlers.get(queue)!(msg, ""),
    lastTask: () => [...published].reverse().find((p) => p.exchange === EXCHANGES.tasks),
  };
}

function fakeLink() {
  const sent: BoxToCloud[] = [];
  const transport: LinkTransport = {
    connected: true,
    send(type, body) {
      sent.push(envelope(type, body) as BoxToCloud);
    },
  };
  return {
    transport,
    sent,
    of: <T extends BoxToCloud["type"]>(type: T) => sent.filter((m): m is Extract<BoxToCloud, { type: T }> => m.type === type),
    lastEvent: () => [...sent].reverse().find((m) => m.type === "task.event") as Extract<BoxToCloud, { type: "task.event" }>,
  };
}

const cmd = <T extends CloudToBox["type"]>(type: T, body: Extract<CloudToBox, { type: T }>["body"]) =>
  envelope(type, body) as unknown as CloudToBox;

const assign = (seq: number, over: Record<string, unknown> = {}) =>
  cmd("task.assign", {
    seq,
    clientRef: `ct_${seq}`,
    memberId: "mbr_lin",
    assignedBy: "mbr_wang",
    origin: "owner-assign",
    title: "整理本週客戶報價",
    input: "列出未回覆的客戶",
    skills: [],
    sensitivity: "normal",
    urgency: "normal",
    requireApproval: false,
    ...over,
  } as never);

const done = (taskId: string, over: Partial<TaskResult> = {}): TaskResult => ({
  kind: "task.result",
  taskId,
  attempt: 1,
  agentId: "desk-lin",
  customerId: "sme-demo",
  ok: true,
  output: "三家客戶尚未回覆",
  tierUsed: 3,
  runtime: "personal-mini",
  billing: "local",
  usage: { inputTokens: 900, outputTokens: 120, costUsd: 0 },
  degraded: false,
  durationMs: 4000,
  ...over,
});

let f: ReturnType<typeof fakeBus>;
let link: ReturnType<typeof fakeLink>;
let core: QueenCore;
let bridge: LinkBridge;

beforeEach(async () => {
  f = fakeBus();
  link = fakeLink();
  const root = tmpRootWithCustomers({ "sme-demo": SME });
  core = await QueenCore.create(root, f.bus);
  bridge = new LinkBridge(core, link.transport, { root, boxId: "boxdemo", customerId: "sme-demo" });
  bridge.start();
  await bridge.handle(cmd("directory.sync", DIRECTORY));
  await f.deliver("queen.hello", {
    kind: "agent.hello",
    agentId: "desk-lin",
    site: "office",
    bindsGeneral: false,
    owner: { memberId: "mbr_lin" },
    capabilities: [{ runtime: "personal", agent: "personal-mini", model: "qwen3.5:4b", tier: 3, billing: "local", skills: ["general", "files"] }],
  });
});

describe("assigning a task", () => {
  it("becomes one scoped hive task on the member's own agent, acknowledged with its id", async () => {
    await bridge.handle(assign(1));
    const ack = link.of("command.ack")[0].body;
    expect(ack).toMatchObject({ seq: 1, ok: true, clientRef: "ct_1" });
    expect(f.lastTask()!.key).toBe(directQueueKey("desk-lin"));
    expect(f.lastTask()!.payload.principal.memberId).toBe("mbr_lin");
    const ev = link.lastEvent().body.task;
    expect(ev).toMatchObject({ taskId: ack.taskId, clientRef: "ct_1", memberId: "mbr_lin", departmentId: "dep_sales", origin: "owner-assign", status: "queued" });
  });

  it("applies the cloud's budgets to the ledger", () => {
    const principals = core.ledger.snapshot().principals;
    expect(principals.find((p) => p.key === "member:mbr_lin")?.capUsd).toBe(2);
    expect(principals.find((p) => p.key === "dept:dep_sales")?.capUsd).toBe(10);
  });

  it("runs a resent command once and answers it the same way", async () => {
    await bridge.handle(assign(2));
    const first = link.of("command.ack")[0].body;
    const tasksBefore = core.status().tasks.length;
    await bridge.handle(assign(2));
    expect(link.of("command.ack")[1].body).toEqual(first);
    expect(core.status().tasks.length).toBe(tasksBefore);
  });

  it("refuses work for a suspended or unknown member", async () => {
    await bridge.handle(assign(3, { memberId: "mbr_gone" }));
    await bridge.handle(assign(4, { memberId: "mbr_nobody" }));
    const acks = link.of("command.ack").map((m) => m.body);
    expect(acks[0]).toMatchObject({ ok: false, error: "member is suspended" });
    expect(acks[1]).toMatchObject({ ok: false, error: "unknown member" });
  });

  it("masks a confidential title unless the org is supervised", async () => {
    await bridge.handle(assign(5, { sensitivity: "confidential", title: "王先生的薪資調整" }));
    expect(link.lastEvent().body.task.title).toBe("Confidential task");
    await bridge.handle(cmd("directory.sync", { ...DIRECTORY, version: 2, org: { ...DIRECTORY.org, supervised: true } }));
    await bridge.handle(assign(6, { sensitivity: "confidential", title: "王先生的薪資調整" }));
    expect(link.lastEvent().body.task.title).toBe("王先生的薪資調整");
  });
});

describe("following a task", () => {
  it("reports running, then done with its cost, its counterfactual and a rollup", async () => {
    await bridge.handle(assign(10));
    const taskId = link.of("command.ack")[0].body.taskId!;
    await f.deliver("queen.progress", {
      kind: "task.progress",
      taskId,
      agentId: "desk-lin",
      at: Date.now(),
      elapsedMs: 1200,
      state: "running",
      tier: 3,
      runtime: "personal",
      phase: "reading-files",
      step: { n: 1, of: 4 },
    });
    expect(link.lastEvent().body.task).toMatchObject({ status: "running", phase: "reading-files", agentId: "desk-lin" });

    await f.deliver("queen.results", done(taskId));
    const final = link.lastEvent().body.task;
    expect(final).toMatchObject({ status: "done", billing: "local", hasOutput: true });
    expect(final.usage.costUsd).toBe(0);
    expect(final.usage.counterfactualUsd).toBeGreaterThan(0);
    const bucket = link.of("usage.rollup").at(-1)!.body.buckets[0];
    expect(bucket).toMatchObject({ memberKey: "mbr_lin", tasks: 1, tasksOk: 1, localTokens: 1020, cloudTokens: 0 });
    // versions only move forward
    const versions = link.of("task.event").filter((e) => e.body.task.taskId === taskId).map((e) => e.body.task.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  it("shows a task waiting on its person as awaiting-approval", async () => {
    await bridge.handle(assign(11, { requireApproval: true }));
    const taskId = link.of("command.ack")[0].body.taskId!;
    await f.deliver("queen.progress", {
      kind: "task.progress", taskId, agentId: "desk-lin", at: Date.now(), elapsedMs: 10, state: "awaiting-approval", tier: 3, runtime: "personal",
    });
    expect(link.lastEvent().body.task.status).toBe("awaiting-approval");
  });

  it("cancels by the cloud's own reference", async () => {
    await bridge.handle(assign(12));
    await bridge.handle(cmd("task.cancel", { seq: 13, clientRef: "ct_12", reason: "owner changed plans" }));
    expect(link.of("command.ack")[1].body).toMatchObject({ seq: 13, ok: true });
    expect(link.lastEvent().body.task.status).toBe("cancelled");
  });
});

describe("outputs stay on the box until a permitted request", () => {
  async function finished(): Promise<string> {
    await bridge.handle(assign(20));
    const taskId = link.of("command.ack")[0].body.taskId!;
    await f.deliver("queen.results", done(taskId));
    // nothing in any event carries the output itself
    expect(JSON.stringify(link.sent)).not.toContain("三家客戶尚未回覆");
    return taskId;
  }

  it("gives the member their own output", async () => {
    const taskId = await finished();
    await bridge.handle(cmd("task.content.request", { requestId: "r1", taskId, requesterMemberId: "mbr_lin", reason: "self" }));
    expect(link.of("task.content")[0].body).toMatchObject({ ok: true, output: "三家客戶尚未回覆" });
  });

  it("refuses the owner while the org is not supervised, even if the cloud claims it is", async () => {
    const taskId = await finished();
    await bridge.handle(cmd("task.content.request", { requestId: "r2", taskId, requesterMemberId: "mbr_wang", reason: "supervised" }));
    expect(link.of("task.content")[0].body.ok).toBe(false);
  });

  it("gives the owner the output once supervised mode is on", async () => {
    const taskId = await finished();
    await bridge.handle(cmd("directory.sync", { ...DIRECTORY, version: 2, org: { ...DIRECTORY.org, supervised: true } }));
    await bridge.handle(cmd("task.content.request", { requestId: "r3", taskId, requesterMemberId: "mbr_wang", reason: "supervised" }));
    expect(link.of("task.content")[0].body).toMatchObject({ ok: true });
  });
});

describe("reconnecting", () => {
  it("resends roster, budget and every live task", async () => {
    await bridge.handle(assign(30));
    link.sent.length = 0;
    bridge.onConnected();
    const types = new Set(link.sent.map((m) => m.type));
    for (const t of ["roster.snapshot", "budget.snapshot", "task.event"]) expect(types.has(t as BoxToCloud["type"])).toBe(true);
    const roster = link.of("roster.snapshot")[0].body.workers;
    expect(roster.find((w) => w.agentId === "desk-lin")).toMatchObject({ scope: "member", memberId: "mbr_lin", live: true });
  });
});
