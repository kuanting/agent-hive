import { beforeEach, describe, expect, it } from "vitest";
import { directQueueKey, EXCHANGES, TaskSpec, tierQueueKey, type Bus, type TaskResult } from "@hive/shared";
import { QueenCore, PERSONAL_SKILLS } from "../src/core.js";
import { BudgetLedger } from "../src/budget.js";
import { ResultCache } from "../src/resultCache.js";
import type { CallerContext } from "../src/store.js";
import { tmpRootWithCustomers } from "./tmpRoot.js";

/**
 * Member scope: in an organisation, each employee's task runs only on the bees
 * that employee may use, and a bee that belongs to someone runs only their work.
 *
 * The tests that matter most are the negative ones. Routing the right task to
 * the right bee is the feature; never routing Amy's task to Bob's desktop, or an
 * anonymous task to anyone's desktop, is the reason anyone would trust it.
 */

const SME = `
customerId: sme
name: SME demo
budget:
  capUsd: 50
policy:
  onBudgetBlock: degrade
  recordEpisodes: off
`;

function fakeBus() {
  const published: Array<{ exchange: string; key: string; payload: Record<string, any> }> = [];
  const handlers = new Map<string, (msg: unknown, rk: string) => Promise<void>>();
  const bus: Bus = {
    publish(exchange, key, payload) {
      published.push({ exchange, key, payload: payload as Record<string, any> });
    },
    async consume(_exchange, queue, _patterns, schema, handler) {
      handlers.set(queue, (msg, rk) => handler(schema.parse(msg), rk));
    },
    async pause() {},
    async close() {},
  };
  return {
    bus,
    deliver: (queue: string, msg: unknown) => handlers.get(queue)!(msg, ""),
    tasks: () => published.filter((p) => p.exchange === EXCHANGES.tasks),
    lastTask: () => [...published].reverse().find((p) => p.exchange === EXCHANGES.tasks),
    control: () => published.filter((p) => p.exchange === EXCHANGES.control),
  };
}

const local = (skills = ["general"]) => ({ runtime: "ollama", agent: "ollama", model: "qwen3.5:4b", tier: 3, billing: "local", skills });
const personal = (skills = ["general", "files", "email"]) => ({
  runtime: "personal",
  agent: "personal-mini",
  model: "qwen3.5:4b",
  tier: 3,
  billing: "local",
  skills,
});
const hello = (agentId: string, capabilities: unknown[], owner?: { memberId?: string; departmentId?: string }) => ({
  kind: "agent.hello",
  agentId,
  site: "office",
  capabilities,
  bindsGeneral: !owner,
  owner,
});

const AMY = "mbr_amy";
const BOB = "mbr_bob";
const SALES = "dep_sales";
const ACCT = "dep_acct";

const amy = (over: Partial<CallerContext> = {}): CallerContext => ({ memberId: AMY, userId: AMY, departmentIds: [SALES], ...over });
const bob = (over: Partial<CallerContext> = {}): CallerContext => ({ memberId: BOB, userId: BOB, departmentIds: [ACCT], ...over });

const spec = (over: Record<string, unknown> = {}) =>
  TaskSpec.parse({ customerId: "sme", title: "summarize the week", input: "list open quotes", ...over });

function resultFor(taskId: string, agentId: string, over: Partial<TaskResult> = {}): TaskResult {
  return {
    kind: "task.result",
    taskId,
    attempt: 1,
    agentId,
    customerId: "sme",
    ok: true,
    output: "ok",
    tierUsed: 3,
    runtime: "personal-mini",
    billing: "local",
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
    degraded: false,
    durationMs: 100,
    ...over,
  };
}

let f: ReturnType<typeof fakeBus>;
let core: QueenCore;

beforeEach(async () => {
  f = fakeBus();
  core = await QueenCore.create(tmpRootWithCustomers({ sme: SME }), f.bus);
  await f.deliver("queen.hello", hello("shared-local", [local()]));
  await f.deliver("queen.hello", hello("shared-personal", [personal()]));
  await f.deliver("queen.hello", hello("desk-amy", [personal()], { memberId: AMY }));
  await f.deliver("queen.hello", hello("desk-bob", [personal()], { memberId: BOB }));
  await f.deliver("queen.hello", hello("dept-acct", [local(["accounting"])], { departmentId: ACCT }));
});

describe("a member's task runs on that member's own agent", () => {
  it("addresses the member's scoped bee by name and stamps who it is for", () => {
    core.submitTask(spec(), undefined, undefined, amy());
    const sent = f.lastTask()!;
    expect(sent.key).toBe(directQueueKey("desk-amy"));
    expect(sent.payload.principal).toEqual({ memberId: AMY, departmentIds: [SALES] });
  });

  it("keeps work that needs the member's files on the member's own bee", () => {
    core.submitTask(spec({ skills: ["files"] }), undefined, undefined, bob());
    expect(f.lastTask()!.key).toBe(directQueueKey("desk-bob"));
  });

  it("waits, rather than falling back to someone else's data, when the member's agent is offline", async () => {
    await f.deliver("queen.goodbye", { kind: "agent.goodbye", agentId: "desk-amy", at: Date.now() });
    const out = core.submitTask(spec({ skills: ["files"] }), undefined, undefined, amy());
    expect(out.status).toBe("deferred");
    expect(core.getTask(out.taskId)?.reason).toMatch(/member's own agent/);
    // and nothing was published anywhere, least of all to the shared personal bee
    expect(f.tasks()).toHaveLength(0);
  });

  it("asks the member before running a task someone else assigned", () => {
    core.submitTask(spec(), undefined, undefined, amy({ requireApproval: true, assignedBy: "mbr_boss" }));
    expect(f.lastTask()!.payload.requireApproval).toBe(true);
  });

  it("knows every personal skill the personal bee advertises", () => {
    expect(PERSONAL_SKILLS).toEqual(expect.arrayContaining(["files", "email", "calendar"]));
  });
});

describe("nobody else's work reaches a scoped bee", () => {
  it("routes an anonymous task over shared bees only", () => {
    core.submitTask(spec());
    const sent = f.lastTask()!;
    expect(sent.key).toBe(tierQueueKey(3, "general"));
    expect(sent.payload.principal).toBeUndefined();
  });

  it("never offers one member another member's desktop", async () => {
    await f.deliver("queen.goodbye", { kind: "agent.goodbye", agentId: "desk-amy", at: Date.now() });
    core.submitTask(spec(), undefined, undefined, amy());
    const sent = f.lastTask()!;
    expect(sent.key).not.toBe(directQueueKey("desk-bob"));
    // the shared local bee, through its tier queue
    expect(sent.key).toBe(tierQueueKey(3, "general"));
  });

  it("never puts the shared personal bee, which reads one person's folder, in a member's scope", async () => {
    await f.deliver("queen.goodbye", { kind: "agent.goodbye", agentId: "desk-amy", at: Date.now() });
    await f.deliver("queen.goodbye", { kind: "agent.goodbye", agentId: "shared-local", at: Date.now() });
    const out = core.submitTask(spec(), undefined, undefined, amy());
    expect(out.status).toBe("deferred");
    expect(f.tasks()).toHaveLength(0);
  });

  it("ignores a pin to a bee outside the member's scope", () => {
    core.submitTask(spec({ pinnedAgentId: "desk-bob" }), undefined, undefined, amy());
    expect(f.lastTask()!.key).toBe(directQueueKey("desk-amy"));
  });
});

describe("department sandboxes", () => {
  it("refuses, as out of scope, a task aimed at a department the member is not in", () => {
    const out = core.submitTask(spec(), undefined, undefined, amy({ targetDepartmentId: ACCT }));
    expect(out.status).toBe("failed");
    const result = core.getTask(out.taskId)?.result;
    expect(result?.terminal).toBe("out-of-scope");
    expect(f.tasks()).toHaveLength(0);
  });

  it("runs the same task for a member of that department on its sandbox", () => {
    core.submitTask(spec(), undefined, undefined, bob({ targetDepartmentId: ACCT }));
    expect(f.lastTask()!.key).toBe(directQueueKey("dept-acct"));
  });

  it("offers a department's bee untargeted work only when the skills say so", () => {
    core.submitTask(spec({ skills: ["accounting"] }), undefined, undefined, bob());
    expect(f.lastTask()!.key).toBe(directQueueKey("dept-acct"));
    core.submitTask(spec({ title: "something else" }), undefined, undefined, bob());
    expect(f.lastTask()!.key).toBe(directQueueKey("desk-bob"));
  });
});

describe("the caller survives every re-dispatch", () => {
  it("keeps the principal and the scope on an escalation retry", async () => {
    const { taskId } = core.submitTask(spec(), undefined, undefined, amy());
    await f.deliver("queen.results", resultFor(taskId, "desk-amy", { ok: false, error: "model gave up" }));
    const retry = f.lastTask()!;
    expect(retry.payload.attempt).toBe(2);
    expect(retry.payload.principal?.memberId).toBe(AMY);
  });

  it("does not escalate a task the member declined", async () => {
    const { taskId } = core.submitTask(spec(), undefined, undefined, amy({ requireApproval: true }));
    const before = f.tasks().length;
    await f.deliver("queen.results", resultFor(taskId, "desk-amy", { ok: false, terminal: "declined", error: "no" }));
    expect(core.getTask(taskId)?.status).toBe("declined");
    expect(f.tasks()).toHaveLength(before);
  });

  it("does not escalate an out-of-scope refusal from a bee", async () => {
    const { taskId } = core.submitTask(spec(), undefined, undefined, amy());
    const before = f.tasks().length;
    await f.deliver("queen.results", resultFor(taskId, "desk-amy", { ok: false, terminal: "out-of-scope", error: "x" }));
    expect(core.getTask(taskId)?.status).toBe("failed");
    expect(f.tasks()).toHaveLength(before);
  });
});

describe("the reaper", () => {
  it("redispatches a member's lost task, still inside that member's scope", async () => {
    const { taskId } = core.submitTask(spec(), undefined, undefined, amy());
    const first = f.lastTask()!;
    expect(first.key).toBe(directQueueKey("desk-amy"));
    // nobody ticked: the dispatch was lost
    core.reapOnce(Date.now() + 16_000);
    const retry = f.lastTask()!;
    expect(retry).not.toBe(first);
    expect(retry.payload.attempt).toBe(2);
    expect(retry.key).toBe(directQueueKey("desk-amy"));
    expect(retry.payload.principal?.memberId).toBe(AMY);
    expect(core.getTask(taskId)?.attempts).toBe(2);
  });

  it("redispatches a member's urgent task that went to a shared tier queue", async () => {
    await f.deliver(
      "queen.hello",
      hello("shared-api", [{ runtime: "api", model: "gpt-5-mini", tier: 2, billing: "per-token", skills: ["general"] }]),
    );
    core.submitTask(spec({ title: "design a detailed proposal", input: "x", urgency: "urgent" }), undefined, undefined, bob());
    expect(f.lastTask()!.key).toBe(tierQueueKey(2, "general"));
    core.reapOnce(Date.now() + 16_000);
    expect(f.lastTask()!.payload.attempt).toBe(2);
  });
});

describe("the result cache keeps members apart", () => {
  it("does not serve one member another member's answer to the same words", async () => {
    const first = core.submitTask(spec(), undefined, undefined, amy());
    await f.deliver("queen.results", resultFor(first.taskId, "desk-amy", { output: "amy's quotes" }));
    const second = core.submitTask(spec(), undefined, undefined, bob());
    expect(second.cached).toBeUndefined();
    // and the same member asking again is still served from cache
    const again = core.submitTask(spec(), undefined, undefined, amy());
    expect(again.cached).toBe(true);
  });

  it("puts the member in the key", () => {
    const s = spec();
    expect(ResultCache.key(s, undefined, undefined, { memberId: AMY })).not.toBe(ResultCache.key(s, undefined, undefined, { memberId: BOB }));
    expect(ResultCache.key(s)).not.toBe(ResultCache.key(s, undefined, undefined, { memberId: AMY }));
    // one API key (the Hive Link) asks for every member, so the same userId must not merge them
    const link = { userId: "hive-link" };
    expect(ResultCache.key(s, undefined, undefined, { ...link, memberId: AMY })).not.toBe(ResultCache.key(s, undefined, undefined, { ...link, memberId: BOB }));
  });
});

describe("cancel", () => {
  it("cancels a dispatched task, tells the bee holding it, and answers waiters at once", async () => {
    const { taskId } = core.submitTask(spec(), undefined, undefined, amy());
    await f.deliver("queen.progress", {
      kind: "task.progress",
      taskId,
      agentId: "desk-amy",
      at: Date.now(),
      elapsedMs: 10,
      state: "running",
      tier: 3,
      runtime: "personal",
    });
    const waiting = core.awaitResult(taskId);
    expect(core.cancelTask(taskId, "owner changed their mind")).toBe(true);
    const result = await waiting;
    expect(result.terminal).toBe("cancelled");
    expect(core.getTask(taskId)?.status).toBe("cancelled");
    const cancel = f.control().find((c) => c.key === "queen.cancel.desk-amy");
    expect(cancel?.payload).toMatchObject({ kind: "queen.cancel", taskId });
  });

  it("broadcasts when no bee has claimed the task yet", () => {
    const { taskId } = core.submitTask(spec(), undefined, undefined, amy());
    core.cancelTask(taskId);
    expect(f.control().some((c) => c.key === "queen.cancel" && c.payload.taskId === taskId)).toBe(true);
  });

  it("stops a deferred task without telling any bee", async () => {
    await f.deliver("queen.goodbye", { kind: "agent.goodbye", agentId: "desk-amy", at: Date.now() });
    const { taskId } = core.submitTask(spec({ skills: ["files"] }), undefined, undefined, amy());
    expect(core.cancelTask(taskId)).toBe(true);
    expect(core.getTask(taskId)?.status).toBe("cancelled");
    expect(f.control().some((c) => c.payload.kind === "queen.cancel")).toBe(false);
  });

  it("refuses to cancel what has already finished", async () => {
    const { taskId } = core.submitTask(spec(), undefined, undefined, amy());
    await f.deliver("queen.results", resultFor(taskId, "desk-amy"));
    expect(core.cancelTask(taskId)).toBe(false);
    expect(core.getTask(taskId)?.status).toBe("done");
  });

  it("still books the money a bee spent finishing a cancelled task, exactly once", async () => {
    const { taskId } = core.submitTask(spec(), undefined, undefined, amy());
    core.cancelTask(taskId);
    const late = resultFor(taskId, "desk-amy", { billing: "per-token", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.25 } });
    await f.deliver("queen.results", late);
    await f.deliver("queen.results", late);
    const snap = core.ledger.snapshot();
    expect(snap.customers.find((c) => c.customerId === "sme")?.spentUsd).toBeCloseTo(0.25);
    expect(snap.principals.find((p) => p.key === `member:${AMY}`)?.spentUsd).toBeCloseTo(0.25);
    expect(core.getTask(taskId)?.status).toBe("cancelled");
  });
});

describe("member and department budgets", () => {
  it("charges spend to the member and their department as well as the company", async () => {
    const { taskId } = core.submitTask(spec(), undefined, undefined, amy());
    await f.deliver(
      "queen.results",
      resultFor(taskId, "desk-amy", { billing: "per-token", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 } }),
    );
    const keys = core.ledger.snapshot().principals.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining([`member:${AMY}`, `dept:${SALES}`]));
  });

  it("degrades an urgent cloud task to local once the member's cap is spent", async () => {
    await f.deliver(
      "queen.hello",
      hello("shared-api", [{ runtime: "api", model: "gpt-5-mini", tier: 2, billing: "per-token", skills: ["general"] }]),
    );
    // no local bee of her own, so the cheapest adequate option for a hard,
    // urgent task is the per-token API
    await f.deliver("queen.goodbye", { kind: "agent.goodbye", agentId: "desk-amy", at: Date.now() });
    core.ledger.setPrincipalCap(`member:${AMY}`, 0);
    const hard = spec({
      // "design" is what the difficulty scorer reads as complex, which rules out
      // tier 3 and leaves the per-token API as the only adequate option
      title: "design a detailed English proposal",
      input: "for the Kaohsiung distributor",
      urgency: "urgent",
    });
    core.submitTask(hard, undefined, undefined, amy());
    const sent = f.lastTask()!;
    expect(sent.payload.envelope.degraded).toBe(true);
    expect(sent.key).toBe(tierQueueKey(3, "general"));
  });
});

describe("LedgerView", () => {
  it("is the tightest of the company, member and department caps", () => {
    const ledger = new BudgetLedger();
    ledger.addCustomer("sme", 10);
    ledger.setPrincipalCap("member:a", 3);
    ledger.setPrincipalCap("dept:d", 1);
    expect(ledger.viewFor(["member:a"]).usdRemaining("sme")).toBe(3);
    expect(ledger.viewFor(["member:a", "dept:d"]).usdRemaining("sme")).toBe(1);
    ledger.recordPrincipalSpend(["member:a"], 2.5);
    expect(ledger.viewFor(["member:a"]).usdRemaining("sme")).toBeCloseTo(0.5);
    // an uncapped member is limited by the company alone
    expect(ledger.viewFor(["member:z"]).usdRemaining("sme")).toBe(10);
  });
});
