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

  it("dead-letters a message it cannot parse", async () => {
    // The DLQ is now for payloads nothing downstream could act on. A handler that
    // throws is NOT dead-lettered any more: the ack fires on receipt, so by the
    // time the handler fails the transport has already let go — and the component
    // that owns the work owns reporting its failure (the worker publishes a failed
    // TaskResult). See the handleMessage comment in bus/mqtt.ts.
    const dlq = deferred<string>();
    const watcher = connect(URL, { clientId: "test-dlq-watcher" });
    await new Promise<void>((res) => watcher.once("connect", () => res()));
    await new Promise<void>((res, rej) =>
      watcher.subscribe("hive.dlq", { qos: 1 }, (e) => (e ? rej(e) : res())),
    );
    watcher.on("message", (_t, payload) => dlq.resolve(payload.toString()));

    await bus.consume(EXCHANGES.tasks, "test.poison", ["tasks.t9.boom"], Msg, async () => {});
    bus.publish(EXCHANGES.tasks, "tasks.t9.boom", { wrong: "shape" });

    const body = await dlq.promise;
    expect(JSON.parse(body)).toEqual({ wrong: "shape" });
    await new Promise<void>((res) => watcher.end(true, {}, () => res()));
  });

  it("does not block the next message while a handler is still running", async () => {
    // The regression that matters most. The ack used to be withheld until the
    // handler resolved, which stalled mqtt.js's entire inbound packet pipeline —
    // PINGRESP included — so a task longer than the 90s keepalive window killed
    // its own connection, reconnected, and had the broker replay the unacked
    // message. One dispatch, a fresh execution every ~91 seconds. Acking on
    // receipt is what fixes it, and "a slow handler doesn't hold the socket" is
    // the observable form of that.
    const second = deferred<unknown>();
    let releaseFirst!: () => void;
    const firstStarted = deferred<void>();
    const blocked = new Promise<void>((r) => (releaseFirst = r));

    await bus.consume(EXCHANGES.tasks, "test.slow", ["tasks.t9.slow"], Msg, async (msg) => {
      if ((msg as { n: number }).n === 1) {
        firstStarted.resolve();
        await blocked;
        return;
      }
      second.resolve(msg);
    });

    bus.publish(EXCHANGES.tasks, "tasks.t9.slow", { n: 1 });
    await firstStarted.promise;
    bus.publish(EXCHANGES.tasks, "tasks.t9.slow", { n: 2 });

    // Arrives while the first handler is still pending.
    expect(await second.promise).toEqual({ n: 2 });
    releaseFirst();
  });

  it("gives two connections from the same process distinct client ids", async () => {
    // The other half of the bug: clientId used to be `hive-${queue}`, derived from
    // the routing key alone and therefore identical in any two processes binding
    // the same tier+skill. MQTT reads that as one session and Aedes honors
    // [MQTT-3.1.4-2] by closing the older connection, so the two sides evicted
    // each other on a ~1s reconnect loop and every reconnect replayed the unacked
    // task. Two independent buses consuming the same queue name must now coexist.
    const other = await connectMqttBus(URL);
    try {
      const a = deferred<unknown>();
      const b = deferred<unknown>();
      await bus.consume(EXCHANGES.tasks, "test.shared", ["tasks.t9.shared"], Msg, async (m) => a.resolve(m));
      await other.consume(EXCHANGES.tasks, "test.shared", ["tasks.t9.shared"], Msg, async (m) => b.resolve(m));

      bus.publish(EXCHANGES.tasks, "tasks.t9.shared", { n: 99 });

      // Both receive it — Aedes has no shared subscriptions, so overlap fans out
      // rather than load-balancing (that is the documented limitation). What must
      // NOT happen is either connection being evicted and replaying forever.
      expect(await a.promise).toEqual({ n: 99 });
      expect(await b.promise).toEqual({ n: 99 });
    } finally {
      await other.close();
    }
  });
});
