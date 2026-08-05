import { beforeEach, describe, expect, it } from "vitest";
import { TaskSpec, type Bus } from "@hive/shared";
import { QueenCore } from "../src/core.js";
import { tmpRootWithCustomers } from "./tmpRoot.js";

/**
 * A tier-4 tool belongs to the customer that declared it.
 *
 * `matchTool` was handed one flat list built from every loaded profile, so any
 * customer's task could route into any customer's tool on nothing more than a
 * skill overlap and the right key names. Both shipped demo profiles declare the
 * same two tools, which is exactly why nobody saw it: the wrong answer and the
 * right one were the same tool.
 *
 * It matters more now than it did. A tool is a *program*, declared per customer
 * because it encodes that customer's data shapes — and since an API key maps to
 * a customerId (`auth.ts`), "somebody else's customer" is a caller rather than a
 * hypothetical. It matters more again once bees are bred from one customer's
 * recorded traffic.
 */

const TOOL_CO = `customerId: tool-co
name: tool-co
budget:
  capUsd: 10
tools:
  - toolId: csv-report
    skills: [reporting]
    requiredKeys: [csv]
`;

const PLAIN_CO = `customerId: plain-co
name: plain-co
budget:
  capUsd: 10
`;

function fakeBus() {
  const published: Array<{ key: string }> = [];
  const handlers = new Map<string, (msg: unknown, rk: string) => Promise<void>>();
  const bus: Bus = {
    publish(_exchange, key) {
      published.push({ key });
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
    keys: () => published.map((p) => p.key),
  };
}

/** The same work, worded identically, differing only in who is asking. */
const csvTask = (customerId: string): TaskSpec =>
  TaskSpec.parse({
    customerId,
    title: "csv report",
    input: "summarize the csv",
    skills: ["reporting"],
    toolInput: { csv: "a,b\n1,2" },
  });

let f: ReturnType<typeof fakeBus>;
let core: QueenCore;

beforeEach(async () => {
  f = fakeBus();
  core = await QueenCore.create(tmpRootWithCustomers({ "tool-co": TOOL_CO, "plain-co": PLAIN_CO }), f.bus);
  // A bee that can serve the work the ordinary way, so "not tier 4" still has
  // somewhere to go and the test is about routing rather than about refusal.
  await f.deliver("queen.hello", {
    kind: "agent.hello",
    agentId: "local-bee-1",
    site: "local",
    capabilities: [
      { agent: "hermes", runtime: "hermes", model: "gemma4:12b", tier: 3, billing: "local", skills: ["reporting"] },
    ],
  });
});

describe("a tier-4 tool serves only the customer that declared it", () => {
  it("routes the declaring customer's task to tier 4", () => {
    const { reason } = core.submitTask(csvTask("tool-co"));
    expect(reason).toBe("tool match: csv-report");
    expect(f.keys()).toContain("tasks.t4.csv-report");
  });

  it("does not route another customer's identical task into that tool", () => {
    const { reason } = core.submitTask(csvTask("plain-co"));
    // Same skills, same required keys, same words — everything matchTool looks
    // at. The only difference is who asked, and that has to be enough.
    expect(reason).not.toBe("tool match: csv-report");
    expect(f.keys()).not.toContain("tasks.t4.csv-report");
  });

  it("exposes the scoping directly, so callers cannot rebuild the flat list", () => {
    expect(core.toolsFor("tool-co").map((t) => t.toolId)).toEqual(["csv-report"]);
    expect(core.toolsFor("plain-co")).toEqual([]);
    // An unknown customer gets nothing rather than everything — the safe end of
    // the failure, and the one a typo lands on.
    expect(core.toolsFor("no-such-customer")).toEqual([]);
  });
});
