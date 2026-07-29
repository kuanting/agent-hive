import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { connectAmqpBus, connectMqttBus, EXCHANGES, startEmbeddedBroker, type Bus } from "../src/bus/index.js";

/**
 * The behavior both backends owe the hive, asserted against each of them.
 *
 * RabbitMQ is the default and the production path, and until this file it had
 * **no tests at all** — a change to amqp.ts was caught by nothing. The embedded
 * broker had three. That was backwards.
 *
 * The amqp half skips itself when no broker is reachable, so `npm test` stays
 * fast and green on a laptop with no Docker while the default path is genuinely
 * covered wherever one is running (`docker compose up -d`).
 *
 * What is deliberately NOT shared: acknowledgement timing. amqp acks on
 * completion so a crashed worker's task is redelivered to a peer; mqtt acks on
 * receipt because withholding it there stalls the client's own keepalive and
 * makes the broker replay the task mid-execution. That divergence is asserted in
 * each backend's own file, on purpose, so nobody unifies it back into a bug.
 */

const MQTT_PORT = 18884;
const AMQP_URL = process.env.AMQP_URL ?? "amqp://localhost:5672";
const Msg = z.object({ n: z.number() });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function amqpReachable(): Promise<boolean> {
  try {
    const probe = await connectAmqpBus(AMQP_URL);
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

/** One suite body, run against whichever backend the caller provides. */
function contract(name: string, connect: () => Promise<Bus>, enabled = true) {
  describe.skipIf(!enabled)(`Bus contract: ${name}`, () => {
    let bus: Bus;
    // Deterministic, not random: `Bus.consume` has no autoDelete, so random names
    // would leave a new durable queue on a shared RabbitMQ on every run. Reusing
    // the same few is the tidier failure mode.
    const q = (base: string) => `contract.${name}.${base}`;

    beforeAll(async () => {
      bus = await connect();
    });
    afterAll(async () => {
      await bus.close();
    });

    it("round-trips a message on an exact routing key", async () => {
      const d = deferred<{ msg: unknown; rk: string }>();
      await bus.consume(EXCHANGES.control, q("hello"), ["agent.hello"], Msg, async (msg, rk) => d.resolve({ msg, rk }));
      bus.publish(EXCHANGES.control, "agent.hello", { n: 1 });
      const got = await d.promise;
      expect(got.msg).toEqual({ n: 1 });
      expect(got.rk).toBe("agent.hello");
    });

    it("matches a '#' pattern and reports the concrete routing key", async () => {
      const d = deferred<{ msg: unknown; rk: string }>();
      await bus.consume(EXCHANGES.telemetry, q("results"), ["task.result.#"], Msg, async (msg, rk) =>
        d.resolve({ msg, rk }),
      );
      bus.publish(EXCHANGES.telemetry, "task.result.abc123", { n: 42 });
      const got = await d.promise;
      expect(got.msg).toEqual({ n: 42 });
      expect(got.rk).toBe("task.result.abc123");
    });

    it("matches a '*' single-word pattern", async () => {
      // Never covered before on either backend, and the translation differs
      // (`*` becomes `+` on MQTT), which is exactly the sort of thing that rots.
      const d = deferred<string>();
      await bus.consume(EXCHANGES.control, q("grants"), ["budget.grant.*"], Msg, async (_m, rk) => d.resolve(rk));
      bus.publish(EXCHANGES.control, "budget.grant.local-bee-1", { n: 1 });
      expect(await d.promise).toBe("budget.grant.local-bee-1");
    });

    it("delivers to two consumers on different queues", async () => {
      const a = deferred<unknown>();
      const b = deferred<unknown>();
      await bus.consume(EXCHANGES.telemetry, q("fan-a"), ["telemetry.usage.#"], Msg, async (m) => a.resolve(m));
      await bus.consume(EXCHANGES.telemetry, q("fan-b"), ["telemetry.usage.#"], Msg, async (m) => b.resolve(m));
      bus.publish(EXCHANGES.telemetry, "telemetry.usage.x", { n: 5 });
      expect(await a.promise).toEqual({ n: 5 });
      expect(await b.promise).toEqual({ n: 5 });
    });

    it("does not deliver a message that matches no pattern", async () => {
      let seen = 0;
      await bus.consume(EXCHANGES.tasks, q("narrow"), ["tasks.t1.coding"], Msg, async () => {
        seen += 1;
      });
      bus.publish(EXCHANGES.tasks, "tasks.t3.writing", { n: 1 });
      await new Promise((r) => setTimeout(r, 250));
      expect(seen).toBe(0);
    });
  });
}

const reachable = await amqpReachable();
if (!reachable) {
  console.log(`[bus-contract] skipping the amqp half: no broker at ${AMQP_URL} (docker compose up -d)`);
}

const broker = await startEmbeddedBroker(MQTT_PORT);
afterAll(async () => {
  await broker.close();
});

contract("mqtt", () => connectMqttBus(`mqtt://127.0.0.1:${MQTT_PORT}`));
contract("amqp", () => connectAmqpBus(AMQP_URL), reachable);
