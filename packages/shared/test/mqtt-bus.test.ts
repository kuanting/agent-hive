import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "mqtt";
import { z } from "zod";
import { connectMqttBus, EXCHANGES, startEmbeddedBroker, type Bus } from "../src/bus/index.js";

const PORT = 18883;
const URL = `mqtt://127.0.0.1:${PORT}`;
const Msg = z.object({ n: z.number() });

let broker: { close: () => Promise<void> };
let bus: Bus;

beforeAll(async () => {
  broker = await startEmbeddedBroker(PORT);
  bus = await connectMqttBus(URL);
});

afterAll(async () => {
  await bus.close();
  await broker.close();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("MqttBus (embedded Aedes)", () => {
  it("round-trips a message on an exact routing key", async () => {
    const d = deferred<{ msg: unknown; rk: string }>();
    await bus.consume(EXCHANGES.control, "test.hello", ["agent.hello"], Msg, async (msg, rk) => {
      d.resolve({ msg, rk });
    });
    bus.publish(EXCHANGES.control, "agent.hello", { n: 1 });
    const got = await d.promise;
    expect(got.msg).toEqual({ n: 1 });
    expect(got.rk).toBe("agent.hello");
  });

  it("matches AMQP '#' wildcard patterns", async () => {
    const d = deferred<{ msg: unknown; rk: string }>();
    await bus.consume(EXCHANGES.telemetry, "test.results", ["task.result.#"], Msg, async (msg, rk) => {
      d.resolve({ msg, rk });
    });
    bus.publish(EXCHANGES.telemetry, "task.result.abc123", { n: 42 });
    const got = await d.promise;
    expect(got.msg).toEqual({ n: 42 });
    expect(got.rk).toBe("task.result.abc123");
  });

  it("dead-letters a message whose handler throws", async () => {
    const dlq = deferred<string>();
    const watcher = connect(URL, { clientId: "test-dlq-watcher" });
    await new Promise<void>((res) => watcher.once("connect", () => res()));
    await new Promise<void>((res, rej) =>
      watcher.subscribe("hive.dlq", { qos: 1 }, (e) => (e ? rej(e) : res())),
    );
    watcher.on("message", (_t, payload) => dlq.resolve(payload.toString()));

    await bus.consume(EXCHANGES.tasks, "test.poison", ["tasks.t9.boom"], Msg, async () => {
      throw new Error("boom");
    });
    bus.publish(EXCHANGES.tasks, "tasks.t9.boom", { n: 7 });

    const body = await dlq.promise;
    expect(JSON.parse(body)).toEqual({ n: 7 });
    await new Promise<void>((res) => watcher.end(true, {}, () => res()));
  });
});
