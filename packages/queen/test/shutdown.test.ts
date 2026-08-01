import { describe, expect, it } from "vitest";
import { EXCHANGES, type Bus } from "@hive/shared";
import { QueenCore } from "../src/core.js";
import { tmpRoot } from "./tmpRoot.js";

/**
 * Stopping the hive is an order, not an inference.
 *
 * The property under test is as much about what does NOT happen: a Queen that
 * restarts, crashes or is redeployed must leave its bees running. They are
 * autonomous consumers, usually on other machines, and losing a fleet because
 * the control plane bounced would be far worse than a moment without a Queen.
 * So only an explicit request may publish queen.shutdown.
 */

const ROOT = tmpRoot();

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
    async pause() {},
    async close() {},
  };
  return {
    bus,
    published,
    deliver: (queue: string, msg: unknown) => handlers.get(queue)!(msg, ""),
    shutdowns: () => published.filter((p) => p.key === "queen.shutdown"),
  };
}

const hello = (agentId: string) => ({
  kind: "agent.hello",
  agentId,
  site: "local",
  capabilities: [{ runtime: "ollama", tier: 3, billing: "local", skills: ["general"] }],
});

const goodbye = (agentId: string, drained = 0) => ({
  kind: "agent.goodbye",
  agentId,
  at: Date.now(),
  drained,
  abandoned: 0,
});

async function hiveWith(agentIds: string[]) {
  const f = fakeBus();
  const core = await QueenCore.create(ROOT, f.bus);
  for (const id of agentIds) await f.deliver("queen.hello", hello(id));
  return { f, core };
}

describe("stopping the hive is something you ask for", () => {
  it("publishes the order once and reports who confirmed", async () => {
    const { f, core } = await hiveWith(["local-bee-1", "worker-bee-1"]);

    const stopping = core.shutdownHive("maintenance", 5_000);
    // Both bees drain and say so.
    await f.deliver("queen.goodbye", goodbye("local-bee-1", 2));
    await f.deliver("queen.goodbye", goodbye("worker-bee-1", 0));
    const outcome = await stopping;

    expect(f.shutdowns()).toHaveLength(1);
    expect(f.shutdowns()[0].exchange).toBe(EXCHANGES.control);
    expect(f.shutdowns()[0].payload).toMatchObject({ kind: "queen.shutdown", reason: "maintenance" });
    expect(outcome.confirmed.sort()).toEqual(["local-bee-1", "worker-bee-1"]);
    expect(outcome.silent).toEqual([]);
    expect(outcome.drained).toBe(2);
  });

  it("names the bees that never answered instead of waiting forever", async () => {
    const { f, core } = await hiveWith(["local-bee-1", "ghost-bee-1"]);

    const stopping = core.shutdownHive(undefined, 300);
    await f.deliver("queen.goodbye", goodbye("local-bee-1"));
    const outcome = await stopping;

    expect(outcome.confirmed).toEqual(["local-bee-1"]);
    expect(outcome.silent).toEqual(["ghost-bee-1"]);
  });

  it("returns promptly when there is no hive to stop", async () => {
    const f = fakeBus();
    const core = await QueenCore.create(ROOT, f.bus);
    const outcome = await core.shutdownHive(undefined, 30_000);
    expect(outcome.confirmed).toEqual([]);
    expect(outcome.silent).toEqual([]);
  });

  it("drops a bee from the roster the moment it says goodbye", async () => {
    // Distinct from letting it go stale: it is gone on purpose, so it must stop
    // being a capability the Queen might route to, immediately.
    const { f, core } = await hiveWith(["local-bee-1"]);
    expect(core.registry.liveCapabilities()).toHaveLength(1);

    await f.deliver("queen.goodbye", goodbye("local-bee-1"));

    expect(core.registry.liveCapabilities()).toHaveLength(0);
    expect(core.status().workers.map((w) => w.agentId)).not.toContain("local-bee-1");
  });
});

describe("a Queen going away is not a shutdown", () => {
  it("never publishes the order just by starting or running", async () => {
    // The regression that matters most. If booting, registering bees or handling
    // heartbeats ever emitted queen.shutdown, restarting the control plane would
    // silently take down every worker on every host.
    const { f } = await hiveWith(["local-bee-1", "honey-bee-1"]);
    await f.deliver("queen.heartbeat", { kind: "agent.heartbeat", agentId: "local-bee-1", at: Date.now() });
    await f.deliver("queen.heartbeat", { kind: "agent.heartbeat", agentId: "stranger-bee-1", at: Date.now() });

    expect(f.shutdowns()).toHaveLength(0);
  });

  it("leaves the roster intact across a fresh Queen over the same bees", async () => {
    // A restarted Queen re-learns the fleet (via rollcall) rather than replacing
    // it: the bees never stopped, so their capabilities are still routable.
    const first = await hiveWith(["local-bee-1"]);
    expect(first.f.shutdowns()).toHaveLength(0);

    const second = fakeBus();
    const revived = await QueenCore.create(ROOT, second.bus);
    await second.deliver("queen.hello", hello("local-bee-1"));

    expect(revived.registry.liveCapabilities()).toHaveLength(1);
    expect(second.shutdowns()).toHaveLength(0);
  });
});
