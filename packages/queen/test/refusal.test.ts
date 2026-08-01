import { beforeEach, describe, expect, it } from "vitest";
import { EXCHANGES, TaskSpec, type Bus } from "@hive/shared";
import { QueenCore } from "../src/core.js";
import { tmpRoot } from "./tmpRoot.js";

/**
 * "No" is an answer, and the hive owes the caller one.
 *
 * A task the fleet cannot serve used to defer every 60 seconds forever while
 * `awaitResult` held its caller open with no timeout — so the request neither
 * succeeded, failed, nor returned. These assert the other half: that a
 * structural gap ends the task promptly, says what is missing, and releases
 * whoever was waiting on it.
 */

const ROOT = tmpRoot();

function fakeBus() {
  const published: Array<{ exchange: string; key: string }> = [];
  const handlers = new Map<string, (msg: unknown, rk: string) => Promise<void>>();
  const bus: Bus = {
    publish(exchange, key) {
      published.push({ exchange, key });
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
    tasksPublished: () => published.filter((p) => p.exchange === EXCHANGES.tasks),
  };
}

const spec = (over: Partial<TaskSpec> = {}): TaskSpec =>
  TaskSpec.parse({ customerId: "aiotlab", title: "t", input: "do a thing", ...over });

let f: ReturnType<typeof fakeBus>;
let core: QueenCore;

beforeEach(async () => {
  f = fakeBus();
  core = await QueenCore.create(ROOT, f.bus);
});

/** A fleet that exists but holds only cloud billing — so confidential work has nowhere to go. */
async function registerCloudOnlyBee() {
  await f.deliver("queen.hello", {
    kind: "agent.hello",
    agentId: "metered-bee-1",
    site: "cloud",
    capabilities: [
      { agent: "api", runtime: "api", model: "gemini-3-flash-preview", tier: 2, billing: "per-token", skills: ["general"] },
    ],
  });
}

describe("a task nobody can serve is answered, not abandoned", () => {
  it("settles the caller instead of leaving awaitResult open", async () => {
    await registerCloudOnlyBee();
    const { taskId } = core.submitTask(spec({ sensitivity: "confidential" }));
    // No fake timers, no reaper ticks: the refusal is synchronous with dispatch,
    // which is the whole point — the caller learns now, not in an hour.
    await expect(core.awaitResult(taskId)).resolves.toMatchObject({ ok: false });
  });

  it("says what is missing and what would fix it", async () => {
    await registerCloudOnlyBee();
    const { taskId } = core.submitTask(spec({ sensitivity: "confidential" }));
    const result = await core.awaitResult(taskId);
    expect(result.error).toContain("confidential");
    expect(result.error).toContain("local or free");
  });

  it("never reaches a bee, and never invents one in the books", async () => {
    await registerCloudOnlyBee();
    const { taskId } = core.submitTask(spec({ sensitivity: "confidential" }));
    const result = await core.awaitResult(taskId);

    expect(f.tasksPublished()).toHaveLength(0);
    expect(result.agentId).toBe("none");
    expect(result.usage.costUsd).toBe(0);
    // A refusal is not a failed attempt: nothing ran, so nothing was spent from
    // the escalation budget either.
    expect(core.getTask(taskId)!.attempts).toBe(0);
  });

  it("keeps waiting while the roster is still empty", async () => {
    // The Queen starts before its bees. A task submitted in that window has to
    // wait, or `npm run solo` would fail everything for its first few seconds.
    const { taskId } = core.submitTask(spec());
    expect(core.getTask(taskId)!.status).toBe("deferred");
  });

  it("reports a refusal as failed, so the console shows an outcome", async () => {
    await registerCloudOnlyBee();
    const { taskId } = core.submitTask(spec({ sensitivity: "confidential" }));
    await core.awaitResult(taskId);
    const state = core.getTask(taskId)!;
    expect(state.status).toBe("failed");
    expect(state.reason).toContain("confidential");
  });
});
