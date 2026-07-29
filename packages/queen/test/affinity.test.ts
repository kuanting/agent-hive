import { beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { directQueueKey, EXCHANGES, TaskSpec, tierQueueKey, type Bus, type TaskResult } from "@hive/shared";
import { QueenCore } from "../src/core.js";
import { buildPrompt, splitStablePrefix, STABLE_PROMPT_PREFIX } from "@hive/adapters";

/**
 * Session affinity: a follow-up goes back to the bee that still holds the CLI
 * session, so the second turn of a conversation is not a cold start.
 *
 * The load-bearing test here is the confidentiality one. A pin becomes a direct
 * queue key, and the direct queue is the one route that bypasses the tier queues
 * — which is where confidentiality is actually enforced. So affinity is one
 * `pinnedAgentId` away from being a way to route confidential work onto a cloud
 * seat while the routing decision that forbade it sits correctly in the log.
 */

const ROOT = resolve(import.meta.dirname, "../../..");

function fakeBus() {
  const published: Array<{ exchange: string; key: string; payload: Record<string, unknown> }> = [];
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
    deliver: (queue: string, msg: unknown) => handlers.get(queue)!(msg, ""),
    tasksPublished: () => published.filter((p) => p.exchange === EXCHANGES.tasks),
    lastTask: () => [...published].reverse().find((p) => p.exchange === EXCHANGES.tasks)!,
  };
}

/** The honey bee: tier 1 on a prepaid seat, which is `subscription` — not local. */
const HONEY = {
  kind: "agent.hello",
  agentId: "honey-bee-1",
  site: "local",
  capabilities: [
    { agent: "claude-code", runtime: "claude-code", model: "sonnet", tier: 1, billing: "subscription", skills: ["general"] },
  ],
};

/** The local bee: tier 3, `local` billing, so confidential work may reach it. */
const LOCAL = {
  kind: "agent.hello",
  agentId: "local-bee-1",
  site: "local",
  capabilities: [
    { agent: "ollama", runtime: "ollama", model: "gemma4:12b", tier: 3, billing: "local", skills: ["general"] },
  ],
};

function resultFor(taskId: string, over: Partial<TaskResult> = {}): TaskResult {
  return {
    kind: "task.result",
    taskId,
    attempt: 1,
    agentId: "honey-bee-1",
    customerId: "aiotlab",
    ok: true,
    output: "done",
    tierUsed: 1,
    runtime: "claude-code",
    billing: "subscription",
    sessionRef: "11111111-2222-3333-4444-555555555555",
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 },
    degraded: false,
    durationMs: 1000,
    ...over,
  };
}

/** A first turn that finishes on the honey bee and reports a session. */
async function firstTurn(f: ReturnType<typeof fakeBus>, core: QueenCore, over: Partial<TaskResult> = {}) {
  const { taskId } = core.submitTask(
    TaskSpec.parse({ customerId: "aiotlab", title: "step one", input: "do the first thing", skills: ["general"] }),
  );
  await f.deliver("queen.results", resultFor(taskId, over));
  return taskId;
}

let f: ReturnType<typeof fakeBus>;
let core: QueenCore;

beforeEach(async () => {
  f = fakeBus();
  core = await QueenCore.create(ROOT, f.bus);
  await f.deliver("queen.hello", HONEY);
  await f.deliver("queen.hello", LOCAL);
});

describe("a follow-up goes back to the bee that holds the session", () => {
  it("pins the continuation and hands the bee its session to resume", async () => {
    const first = await firstTurn(f, core);
    expect(core.getTask(first)?.result?.sessionRef).toBeDefined();

    core.submitTask(
      TaskSpec.parse({
        customerId: "aiotlab",
        title: "step two",
        input: "now do the second thing",
        skills: ["general"],
        continues: first,
      }),
    );

    const sent = f.lastTask();
    expect(sent.key).toBe(directQueueKey("honey-bee-1"));
    expect(sent.payload.resumeSession).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("leaves the envelope alone: affinity picks the bee, never the budget", async () => {
    const first = await firstTurn(f, core);
    const cold = f.lastTask().payload.envelope as Record<string, unknown>;

    core.submitTask(
      TaskSpec.parse({ customerId: "aiotlab", title: "step two", input: "second", skills: ["general"], continues: first }),
    );
    const warm = f.lastTask().payload.envelope as Record<string, unknown>;

    // Same tier, same cap, same degraded flag — the router decided both, and the
    // pin only changed which queue the message went to.
    expect(warm.tier).toBe(cold.tier);
    expect(warm.maxUsd).toBe(cold.maxUsd);
    expect(warm.degraded).toBe(cold.degraded);
  });
});

describe("affinity is refused rather than honored when it would be unsafe", () => {
  it("does NOT pin a confidential follow-up to a subscription-billed bee", async () => {
    const first = await firstTurn(f, core);

    core.submitTask(
      TaskSpec.parse({
        customerId: "aiotlab",
        title: "step two",
        input: "now do the secret thing",
        skills: ["general"],
        sensitivity: "confidential",
        continues: first,
      }),
    );

    const sent = f.lastTask();
    // Honoring the pin here would put confidential work on a cloud seat via the
    // direct queue, past the filter that exists to prevent exactly that. It must
    // route by tier like any other confidential task.
    expect(sent.key).not.toBe(directQueueKey("honey-bee-1"));
    expect(sent.payload.resumeSession).toBeUndefined();
    expect(sent.key).toBe(tierQueueKey(3, "general")); // the local bee's queue
  });

  it("refuses a caller-supplied pin that would do the same thing", async () => {
    // The hole is in the mechanism, not in affinity: a site-bound task with an
    // explicit pinnedAgentId could always bypass the tier filter this way.
    core.submitTask(
      TaskSpec.parse({
        customerId: "aiotlab",
        title: "site task",
        input: "confidential work, pinned by the caller",
        skills: ["general"],
        sensitivity: "confidential",
        pinnedAgentId: "honey-bee-1",
      }),
    );
    expect(f.lastTask().key).not.toBe(directQueueKey("honey-bee-1"));
  });

  it("still honors a caller-supplied pin for normal work", async () => {
    core.submitTask(
      TaskSpec.parse({
        customerId: "aiotlab",
        title: "site task",
        input: "ordinary work, pinned by the caller",
        skills: ["general"],
        pinnedAgentId: "honey-bee-1",
      }),
    );
    expect(f.lastTask().key).toBe(directQueueKey("honey-bee-1"));
  });

  it("runs cold when the bee that held the session is gone", async () => {
    const bare = fakeBus();
    const lonely = await QueenCore.create(ROOT, bare.bus);
    await bare.deliver("queen.hello", HONEY);
    const first = await firstTurn(bare, lonely);

    // The bee never says hello again and its record goes stale; the Queen must not
    // dispatch into a queue nobody is consuming.
    await bare.deliver("queen.hello", LOCAL);
    const registry = lonely.registry as unknown as { workers: Map<string, { lastSeen: number }> };
    registry.workers.get("honey-bee-1")!.lastSeen = Date.now() - 120_000;

    lonely.submitTask(
      TaskSpec.parse({ customerId: "aiotlab", title: "step two", input: "second", skills: ["general"], continues: first }),
    );
    const sent = bare.lastTask();
    expect(sent.key).not.toBe(directQueueKey("honey-bee-1"));
    expect(sent.payload.resumeSession).toBeUndefined();
  });

  it("runs cold when the predecessor failed or reported no session", async () => {
    const failed = await firstTurn(f, core, { ok: false, error: "boom", sessionRef: undefined });
    core.submitTask(
      TaskSpec.parse({ customerId: "aiotlab", title: "step two", input: "second", skills: ["general"], continues: failed }),
    );
    expect(f.lastTask().payload.resumeSession).toBeUndefined();

    const noSession = await firstTurn(f, core, { sessionRef: undefined });
    core.submitTask(
      TaskSpec.parse({ customerId: "aiotlab", title: "step three", input: "third", skills: ["general"], continues: noSession }),
    );
    expect(f.lastTask().payload.resumeSession).toBeUndefined();
  });

  it("runs cold when continuing a task the Queen has never heard of", async () => {
    core.submitTask(
      TaskSpec.parse({ customerId: "aiotlab", title: "orphan", input: "second", skills: ["general"], continues: "no-such" }),
    );
    expect(f.lastTask().payload.resumeSession).toBeUndefined();
  });
});

describe("bee prompts share a byte-identical prefix", () => {
  const task = (title: string, input: string) => ({
    kind: "task" as const,
    taskId: "x",
    attempt: 1,
    spec: TaskSpec.parse({ customerId: "aiotlab", title, input }),
    envelope: { maxUsd: 1, tier: 3 as const, allowEscalation: true, urgency: "normal" as const, degraded: false },
    difficulty: "standard" as const,
  });

  it("puts the stable block at byte zero, ahead of anything per-task", () => {
    // The property that makes provider-side caching possible at all, checked
    // directly rather than inferred from the fact that a marker was set.
    const a = buildPrompt(task("alpha", "do alpha"), () => "");
    const b = buildPrompt(task("beta", "do beta"), () => "");

    expect(a.startsWith(STABLE_PROMPT_PREFIX)).toBe(true);
    expect(b.startsWith(STABLE_PROMPT_PREFIX)).toBe(true);
    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
    expect(shared).toBeGreaterThanOrEqual(STABLE_PROMPT_PREFIX.length);
  });

  it("carries nothing per-task, per-customer, or per-clock in the block itself", () => {
    // Any of these would turn one shared prefix into one prefix per request.
    expect(STABLE_PROMPT_PREFIX).not.toMatch(/alpha|aiotlab|\d{4}-\d{2}-\d{2}/);
  });

  it("splits back apart for providers that take a system field, without duplicating it", () => {
    const prompt = buildPrompt(task("alpha", "do alpha"), () => "");
    const { system, body } = splitStablePrefix(prompt);
    expect(system).toBe(STABLE_PROMPT_PREFIX);
    expect(body.startsWith("Task: alpha")).toBe(true);
    // Paying for the same tokens twice would defeat the point of moving them.
    expect(body).not.toContain(STABLE_PROMPT_PREFIX);
  });

  it("leaves a prompt without the prefix alone", () => {
    expect(splitStablePrefix("Task: legacy\n\nbody")).toEqual({ body: "Task: legacy\n\nbody" });
  });
});
