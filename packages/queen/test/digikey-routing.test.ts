import { beforeEach, describe, expect, it } from "vitest";
import { TaskSpec, type Bus } from "@hive/shared";
import { QueenCore } from "../src/core.js";
import { tmpRoot } from "./tmpRoot.js";

/**
 * The Queen's half of the loop the corpus asked for.
 *
 * The story is that traffic showed a recurring `digikey_search -> get_price`
 * procedure, somebody wrote the tool, and the same work now costs nothing. This
 * asserts the hinge: that a task carrying what the tool declares actually
 * reaches tier 4 rather than falling through to a model, which is the only part
 * of the claim that can silently stop being true.
 *
 * Sibling of `tool-scope.test.ts`, and deliberately close to it — the two halves
 * of a tier-4 match are "the right task reaches it" and "somebody else's does
 * not".
 */

const ROOT = tmpRoot();

function fakeBus() {
  const published: Array<{ key: string; payload: Record<string, unknown> }> = [];
  const handlers = new Map<string, (msg: unknown, rk: string) => Promise<void>>();
  const bus: Bus = {
    publish(_exchange, key, payload) {
      published.push({ key, payload: payload as Record<string, unknown> });
    },
    async consume(_exchange, queue, _patterns, schema, handler) {
      handlers.set(queue, (msg, rk) => handler(schema.parse(msg), rk));
    },
    async pause() {},
    async close() {},
  };
  return {
    bus,
    deliver: (q: string, m: unknown) => handlers.get(q)!(m, ""),
    keys: () => published.map((p) => p.key),
    last: () => published[published.length - 1],
  };
}

/** The request the agent loops were making, once it is a structured task. */
const priceTask = (over: Partial<TaskSpec> = {}): TaskSpec =>
  TaskSpec.parse({
    customerId: "breeder",
    title: "digikey price",
    input: "what does an STM32F103C8T6 cost",
    skills: ["sourcing"],
    toolInput: { part: "STM32F103C8T6" },
    ...over,
  });

let f: ReturnType<typeof fakeBus>;
let core: QueenCore;

beforeEach(async () => {
  f = fakeBus();
  core = await QueenCore.create(ROOT, f.bus);
  // A bee that could serve the work the expensive way, so "did not reach tier 4"
  // means routed elsewhere rather than refused for want of anywhere to go.
  await f.deliver("queen.hello", {
    kind: "agent.hello",
    agentId: "local-bee-1",
    site: "local",
    capabilities: [
      { agent: "hermes", runtime: "hermes", model: "gemma4:12b", tier: 3, billing: "local", skills: ["sourcing", "general"] },
    ],
  });
});

describe("the bred tool serves the work it was bred for", () => {
  it("routes a part lookup to tier 4", () => {
    const { reason } = core.submitTask(priceTask());
    expect(reason).toBe("tool match: digikey-price");
    expect(f.keys()).toContain("tasks.t4.digikey-price");
  });

  it("does not fire without the key the tool declares", () => {
    // `requiredKeys: [part]`. Without it there is nothing for the program to do,
    // and falling through to a model is the correct outcome.
    const { reason } = core.submitTask(priceTask({ toolInput: { sku: "497-6063-ND" } }));
    expect(reason).not.toBe("tool match: digikey-price");
    expect(f.keys()).not.toContain("tasks.t4.digikey-price");
  });

  it("does not fire on a task tagged for other work", () => {
    // matchTool wants a skill overlap as well as the keys, so a `writing` task
    // that happens to mention a part does not get answered by a price lookup.
    const { reason } = core.submitTask(priceTask({ skills: ["writing"] }));
    expect(reason).not.toBe("tool match: digikey-price");
  });

  it("keeps the tool to the customer it was bred from", () => {
    // A tool is a program encoding one customer's data shapes. It was bred from
    // breeder's traffic and belongs to breeder.
    const { reason } = core.submitTask(priceTask({ customerId: "aiotlab" }));
    expect(reason).not.toBe("tool match: digikey-price");
    expect(core.toolsFor("breeder").map((t) => t.toolId)).toContain("digikey-price");
    expect(core.toolsFor("aiotlab").map((t) => t.toolId)).not.toContain("digikey-price");
  });

  it("dispatches it with no money attached", () => {
    // The envelope is the claim: tier 4, and a per-task cap of zero. A tool that
    // arrived with a budget would be a tool that could spend one.
    core.submitTask(priceTask());
    const msg = f.last();
    expect(msg.key).toBe("tasks.t4.digikey-price");
    expect(msg.payload.envelope).toMatchObject({ tier: 4, maxUsd: 0 });
    expect(msg.payload.matchedToolId).toBe("digikey-price");
  });
});
