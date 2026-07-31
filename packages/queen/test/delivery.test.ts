import { beforeEach, describe, expect, it } from "vitest";
import { EXCHANGES, TaskSpec, type Bus, type TaskProgress, type TaskResult } from "@hive/shared";
import { QueenCore } from "../src/core.js";
import { tmpRoot } from "./tmpRoot.js";

/**
 * The Queen's half of "the broker delivers, the Queen guarantees".
 *
 * These drive the real dispatch, ledger and reaper logic through a fake bus,
 * invoking the consumer handlers the way a broker would. That is the only way to
 * assert the thing that actually cost money: the books must be written exactly
 * once per (taskId, attempt), whatever the transport does.
 */

const ROOT = tmpRoot();

interface Published {
  exchange: string;
  key: string;
  payload: Record<string, unknown>;
}

/** Captures publishes and hands back the consumer handlers so a test can feed them. */
function fakeBus() {
  const published: Published[] = [];
  const handlers = new Map<string, (msg: unknown, rk: string) => Promise<void>>();
  const bus: Bus = {
    publish(exchange, key, payload) {
      published.push({ exchange, key, payload: payload as Record<string, unknown> });
    },
    async consume(_exchange, queue, _patterns, schema, handler) {
      handlers.set(queue, (msg, rk) => handler(schema.parse(msg), rk));
    },
    async close() {},
  };
  return {
    bus,
    published,
    deliver: (queue: string, msg: unknown) => handlers.get(queue)!(msg, ""),
    tasksPublished: () => published.filter((p) => p.exchange === EXCHANGES.tasks),
  };
}

function spec(over: Partial<TaskSpec> = {}): TaskSpec {
  return TaskSpec.parse({ customerId: "aiotlab", title: "t", input: "do a thing", ...over });
}

function resultFor(taskId: string, attempt: number, over: Partial<TaskResult> = {}): TaskResult {
  return {
    kind: "task.result",
    taskId,
    attempt,
    agentId: "metered-bee-1",
    customerId: "aiotlab",
    ok: true,
    output: "done",
    tierUsed: 2,
    runtime: "api",
    billing: "per-token",
    usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.25 },
    degraded: false,
    durationMs: 1200,
    ...over,
  };
}

function progressFor(taskId: string, attempt: number, at: number): TaskProgress {
  return {
    kind: "task.progress",
    taskId,
    agentId: "local-bee-1",
    at,
    elapsedMs: 1000,
    attempt,
    state: "running",
    tier: 3,
    runtime: "ollama",
  };
}

let f: ReturnType<typeof fakeBus>;
let core: QueenCore;

beforeEach(async () => {
  f = fakeBus();
  core = await QueenCore.create(ROOT, f.bus);
  // A live bee, or the tier mapper defers everything and nothing is ever
  // dispatched — which is a different code path from the one under test here.
  await f.deliver("queen.hello", {
    kind: "agent.hello",
    agentId: "local-bee-1",
    site: "local",
    capabilities: [{ agent: "ollama", runtime: "ollama", model: "gemma4:12b", tier: 3, billing: "local", skills: ["general"] }],
  });
});

describe("the books are written once per execution", () => {
  it("does not charge twice for a duplicate result", async () => {
    const { taskId } = core.submitTask(spec());
    const before = core.ledger.snapshot().customers.find((c) => c.customerId === "aiotlab")!.spentUsd;

    await f.deliver("queen.results", resultFor(taskId, 1));
    const afterOne = core.ledger.snapshot().customers.find((c) => c.customerId === "aiotlab")!.spentUsd;

    // The same result again — a redelivery, or a bee answering a duplicate
    // dispatch from its own memory.
    await f.deliver("queen.results", resultFor(taskId, 1));
    const afterTwo = core.ledger.snapshot().customers.find((c) => c.customerId === "aiotlab")!.spentUsd;

    expect(afterOne - before).toBeCloseTo(0.25, 6);
    expect(afterTwo).toBeCloseTo(afterOne, 6);
  });

  it("ignores a result for a task it has never heard of", async () => {
    const before = core.ledger.snapshot().customers.find((c) => c.customerId === "aiotlab")!.spentUsd;
    // The ledger writes used to happen above the task lookup, so this charged.
    await f.deliver("queen.results", resultFor("never-seen", 1));
    expect(core.ledger.snapshot().customers.find((c) => c.customerId === "aiotlab")!.spentUsd).toBeCloseTo(before, 6);
  });

  it("ignores a late failure from a superseded attempt instead of re-escalating a finished task", async () => {
    const { taskId } = core.submitTask(spec());
    await f.deliver("queen.results", resultFor(taskId, 1));
    expect(core.getTask(taskId)?.status).toBe("done");

    const dispatchesBefore = f.tasksPublished().length;
    await f.deliver("queen.results", resultFor(taskId, 1, { ok: false, error: "slow attempt lost the race" }));

    expect(core.getTask(taskId)?.status).toBe("done");
    expect(f.tasksPublished().length).toBe(dispatchesBefore);
  });
});

describe("waiting for a seat is not an attempt", () => {
  it("keeps the escalation budget intact across deferrals", async () => {
    // Its own core with no bee registered, so the tier mapper defers. `attempts`
    // used to be incremented on every entry to dispatch — and the deferral timer
    // re-enters it — so two waits for a seat window left attempts at 3 and the
    // first genuine failure died permanently without ever escalating. Waiting is
    // not trying.
    const bare = fakeBus();
    const idle = await QueenCore.create(ROOT, bare.bus);
    const { taskId } = idle.submitTask(spec());
    const state = idle.getTask(taskId)!;

    expect(state.status).toBe("deferred");
    expect(state.attempts).toBe(0);
    expect(state.deferrals).toBe(1);
    expect(bare.tasksPublished()).toHaveLength(0);
  });
});

describe("the reaper redispatches what nobody took", () => {
  it("gives up on a dispatch that never produced a tick", async () => {
    const { taskId } = core.submitTask(spec());
    const state = core.getTask(taskId)!;
    expect(state.status).toBe("dispatched");
    const dispatches = f.tasksPublished().length;

    // Well inside the accept window: nothing should move yet.
    core.reapOnce(state.dispatchedAt! + 1_000);
    expect(f.tasksPublished().length).toBe(dispatches);

    core.reapOnce(state.dispatchedAt! + 60_000);
    expect(f.tasksPublished().length).toBe(dispatches + 1);
    expect(core.getTask(taskId)!.attempts).toBe(2);
  });

  it("leaves a task alone while its bee is still ticking", async () => {
    const { taskId } = core.submitTask(spec());
    const dispatches = f.tasksPublished().length;
    const now = Date.now();

    await f.deliver("queen.progress", progressFor(taskId, 1, now));
    core.reapOnce(now + 20_000); // past the accept deadline, inside the stall one

    expect(f.tasksPublished().length).toBe(dispatches);
  });

  it("redispatches when a ticking bee goes silent", async () => {
    const { taskId } = core.submitTask(spec());
    const dispatches = f.tasksPublished().length;
    const now = Date.now();

    await f.deliver("queen.progress", progressFor(taskId, 1, now));
    core.reapOnce(now + 120_000);

    expect(f.tasksPublished().length).toBe(dispatches + 1);
  });

  it("fails the task rather than redispatching forever", async () => {
    const { taskId } = core.submitTask(spec());
    for (let i = 0; i < 6; i++) {
      const at = core.getTask(taskId)!.dispatchedAt ?? Date.now();
      core.reapOnce(at + 60_000);
    }
    const state = core.getTask(taskId)!;
    expect(state.status).toBe("failed");
    expect(state.attempts).toBeLessThanOrEqual(3);
    expect(state.result?.error).toContain("abandoned");
  });

  it("settles awaitResult when it gives up, so a chat turn cannot hang forever", async () => {
    const { taskId } = core.submitTask(spec());
    const settled = core.awaitResult(taskId);
    for (let i = 0; i < 6; i++) {
      const at = core.getTask(taskId)!.dispatchedAt ?? Date.now();
      core.reapOnce(at + 60_000);
    }
    await expect(settled).resolves.toMatchObject({ ok: false });
  });
});

describe("registration recovers from a lost hello", () => {
  it("asks an unknown bee to introduce itself when it hears a heartbeat", async () => {
    await f.deliver("queen.heartbeat", { kind: "agent.heartbeat", agentId: "stranger-bee-1", at: Date.now() });
    const asked = f.published.filter((p) => p.key === "queen.rollcall.stranger-bee-1");
    expect(asked).toHaveLength(1);
  });

  it("does not answer a flood of heartbeats with a flood of rollcalls", async () => {
    // A bee running older code never replies, and an orphaned client can flush a
    // long backlog of queued heartbeats the moment it reconnects — observed once
    // as ~500 in a few seconds. Amplifying that one-for-one would be our bug.
    for (let i = 0; i < 50; i++) {
      await f.deliver("queen.heartbeat", { kind: "agent.heartbeat", agentId: "mute-bee-1", at: Date.now() });
    }
    expect(f.published.filter((p) => p.key === "queen.rollcall.mute-bee-1")).toHaveLength(1);
  });

  it("stops asking once the bee has registered", async () => {
    await f.deliver("queen.hello", {
      kind: "agent.hello",
      agentId: "known-bee-1",
      site: "local",
      capabilities: [{ runtime: "ollama", tier: 3, billing: "local", skills: ["general"] }],
    });
    await f.deliver("queen.heartbeat", { kind: "agent.heartbeat", agentId: "known-bee-1", at: Date.now() });
    expect(f.published.filter((p) => p.key.startsWith("queen.rollcall."))).toHaveLength(0);
  });
});

/**
 * The attempt chain is the label an episode is worth recording for: "failed at
 * tier 3, succeeded at tier 1" says scoreDifficulty under-rated the task, and
 * that is the row a future planner learns from. `state.result` holds only the
 * last attempt, so keeping only it would erase exactly that transition.
 */
describe("the escalation record survives for training", () => {
  it("keeps every accepted attempt, not just the one that succeeded", async () => {
    const out = core.submitTask(spec({ skills: ["general"] }));
    await f.deliver(
      "queen.results",
      resultFor(out.taskId, 1, { ok: false, error: "local model gave up", tierUsed: 3, output: "partial work" }),
    );
    await f.deliver("queen.results", resultFor(out.taskId, 2, { ok: true, tierUsed: 1, output: "the answer" }));

    const history = core.attemptHistory(out.taskId);
    expect(history.map((r) => ({ tier: r.tierUsed, ok: r.ok }))).toEqual([
      { tier: 3, ok: false },
      { tier: 1, ok: true },
    ]);
  });

  it("hands the retry its predecessor's output by reference", async () => {
    const out = core.submitTask(spec({ skills: ["general"] }));
    await f.deliver(
      "queen.results",
      resultFor(out.taskId, 1, { ok: false, error: "nope", tierUsed: 3, output: "what attempt 1 produced" }),
    );
    const redispatch = f.tasksPublished().at(-1)!.payload as { escalation?: { priorOutputRef?: string } };
    expect(redispatch.escalation?.priorOutputRef).toBeTruthy();
  });

  it("does not let a replayed result inflate the history", async () => {
    // Same guard the ledger gets: the books and the training set must agree that
    // one execution happened once.
    const out = core.submitTask(spec({ skills: ["general"] }));
    const r = resultFor(out.taskId, 1, { ok: true, tierUsed: 3 });
    await f.deliver("queen.results", r);
    await f.deliver("queen.results", r);
    expect(core.attemptHistory(out.taskId)).toHaveLength(1);
  });
});
