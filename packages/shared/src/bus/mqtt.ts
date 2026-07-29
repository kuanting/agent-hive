import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { connect, type MqttClient } from "mqtt";
import type { Bus } from "./types.js";

/**
 * Embedded MQTT backend (Aedes broker + MQTT.js clients) — **lightweight mode**.
 * RabbitMQ (`./amqp.ts`) is the default and the production path; this one exists
 * so `npm install` + one command brings up the whole hive with no Docker.
 *
 * Semantics mapped from the RabbitMQ topic exchanges:
 *  - exchange + routing key  -> MQTT topic   (`hive.tasks/tasks/t3/coding`)
 *  - AMQP topic patterns     -> MQTT filters (`*`->`+`, `#` stays `#`)
 *  - unparseable payload      -> republish to `hive.dlq`
 *
 * **Delivery is at-most-once here, and that is deliberate.** The two backends
 * differ on purpose and the difference is tested (see the bus contract suite):
 * amqp acks on completion, so a crashed worker's task is redelivered to a peer;
 * this backend acks on receipt, so a crashed worker's task is simply gone and the
 * Queen's reaper redispatches it. Do not "fix" that inconsistency — acking on
 * completion here is what caused a task to re-execute every ~91 seconds (see the
 * comment on handleMessage below), and redispatching on amqp would enqueue a
 * second copy of a message the broker is still holding.
 *
 * Boundary: Aedes has no MQTT shared subscriptions (moscajs/aedes#841), so it
 * cannot load-balance one task across several *overlapping* workers the way
 * RabbitMQ competing-consumer queues do. Two workers bound to the same
 * tier+skill each receive every such task, and both execute it.
 *
 * That is a constraint on overlap, not on worker count. The solo launcher runs
 * one worker per tier — honey (1), metered (2), local (3), worker (4) — and
 * since their bindings are disjoint, every task has exactly one taker. Use the
 * amqp backend when you want several workers sharing the SAME tier.
 */

const DLQ_TOPIC = "hive.dlq";

/**
 * Salt that makes every clientId unique, so two hives — or a hive and an orphan
 * left over from a previous run — can never be mistaken for one MQTT session.
 *
 * Per `connectMqttBus()` call rather than per process, and the difference is
 * load-bearing: a module-level constant would still collide between two buses in
 * one process, which is exactly what the "distinct client ids" test caught.
 * Random rather than the pid, because pids are reused and a container that always
 * starts its worker as pid 1 would collide on every restart.
 */
function newInstanceId(): string {
  return randomUUID().slice(0, 8);
}

/** exchange + routing key -> MQTT topic (routing-key dots become topic levels) */
function toTopic(exchange: string, routingKey: string): string {
  return `${exchange}/${routingKey.split(".").join("/")}`;
}

/** AMQP topic-exchange pattern -> MQTT topic filter (`*` single word -> `+`, `#` stays) */
function toFilter(exchange: string, pattern: string): string {
  const levels = pattern.split(".").map((seg) => (seg === "*" ? "+" : seg));
  return `${exchange}/${levels.join("/")}`;
}

/** MQTT topic -> AMQP-style routing key (drop the exchange level, `/` -> `.`) */
function toRoutingKey(exchange: string, topic: string): string {
  const prefix = `${exchange}/`;
  const rest = topic.startsWith(prefix) ? topic.slice(prefix.length) : topic;
  return rest.split("/").join(".");
}

export async function connectMqttBus(url = process.env.MQTT_URL ?? "mqtt://localhost:1883"): Promise<Bus> {
  const clients: MqttClient[] = [];
  const instanceId = newInstanceId();

  /** open a client and resolve once it has connected (tolerating the broker starting slightly later) */
  function open(clientId: string, clean: boolean): { client: MqttClient; ready: Promise<MqttClient> } {
    const client = connect(url, { clientId, clean, reconnectPeriod: 1000, connectTimeout: 30_000 });
    clients.push(client);
    // Keep a listener attached so connection errors while retrying don't crash the process.
    client.on("error", (err) => console.error(`[mqtt] ${clientId}:`, err.message));
    const ready = new Promise<MqttClient>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`mqtt connect timeout for ${clientId} @ ${url}`)), 30_000);
      client.once("connect", () => {
        clearTimeout(timer);
        resolve(client);
      });
    });
    return { client, ready };
  }

  const { ready: pubReady } = open(`hive-pub-${instanceId}`, true);
  const publisher = await pubReady;

  return {
    publish(exchange, routingKey, payload) {
      publisher.publish(toTopic(exchange, routingKey), JSON.stringify(payload), { qos: 1 });
    },

    async consume(exchange, queue, patterns, schema, handler, opts = {}) {
      const { durable = true } = opts;
      // Every consumer gets its own clean session under a salted clientId.
      //
      // The salt is not cosmetic. clientId used to be `hive-${queue}` — derived
      // from the routing key alone, so byte-identical in any two processes that
      // bound the same tier+skill. MQTT reads that as "the same session", not as
      // "competing consumers", and Aedes honors [MQTT-3.1.4-2] by closing the
      // existing connection when a duplicate id appears. With reconnectPeriod 1s
      // the two sides evicted each other forever, and every reconnect replayed
      // the still-unacked task: one dispatch, unbounded executions. On the amqp
      // backend two consumers on one queue name is the *correct* competing-consumer
      // setup, which is exactly how the shared Bus interface invited the bug.
      //
      // Clean sessions follow from the salt: a per-process id has no prior session
      // for a broker to resume, so `clean: false` would only pretend to offer
      // durability. This backend is honestly at-most-once; the Queen supplies the
      // retry (see QueenCore's reaper), which is the right place for it anyway —
      // blind broker redelivery of a five-minute paid call is the worst possible
      // retry policy for this system.
      const { client, ready } = open(`hive-${queue}-${instanceId}`, true);
      const qos = durable ? 1 : 0;

      // Ack on RECEIPT, not on completion.
      //
      // The PUBACK used to be withheld until the handler resolved, which looked
      // like manual ack + prefetch-1 backpressure and was really a self-destruct.
      // mqtt.js processes one inbound packet at a time and holds the stream's
      // write callback until this `done` fires, so a long handler stalls the
      // client's entire inbound pipeline — PINGRESP included. reschedulePing only
      // runs on that inbound path, so with the default 60s keepalive the manager
      // times out at 90s, reconnects, and the broker replays the unacked message:
      // a second execution of a task the first is still running, every ~91s.
      // Adapters allow a task 300s, so this fired on a perfectly ordinary hive.
      //
      // Tempting and wrong: raising keepalive above HIVE_EXEC_TIMEOUT_MS. It
      // leaves the packet loop stalled for the whole task (nothing else reaches
      // this client) and blinds the connection to genuine death.
      //
      // The cost of acking early is that the ack can no longer report failure, so
      // a handler that throws is reported by the handler's own owner — the worker
      // publishes a failed TaskResult — rather than by the transport.
      client.handleMessage = ((packet: { topic: string; payload: Buffer }, done: (err?: Error) => void) => {
        let parsed: unknown;
        try {
          parsed = schema.parse(JSON.parse(packet.payload.toString()));
        } catch (err) {
          // A malformed payload is the one failure the transport still owns:
          // nothing downstream can act on it, so dead-letter it and move on.
          if (durable) {
            console.error(`[mqtt] ${queue} unparseable message, dead-lettering:`, err);
            try {
              publisher.publish(DLQ_TOPIC, packet.payload, { qos: 1 });
            } catch {
              /* best-effort DLQ */
            }
          } else {
            console.error(`[mqtt] ${queue} unparseable message, dropping:`, err);
          }
          done();
          return;
        }
        done(); // ack now; the socket is free while the work runs
        void Promise.resolve(handler(parsed as never, toRoutingKey(exchange, packet.topic))).catch((err) => {
          console.error(`[mqtt] ${queue} handler failed:`, err);
        });
      }) as MqttClient["handleMessage"];

      await ready;
      const filters = patterns.map((p) => toFilter(exchange, p));
      await new Promise<void>((resolve, reject) =>
        client.subscribe(filters, { qos }, (err) => (err ? reject(err) : resolve())),
      );
    },

    async close() {
      await Promise.all(
        clients.map((c) => new Promise<void>((resolve) => c.end(true, {}, () => resolve()))),
      );
    },
  };
}

/**
 * Start the embedded Aedes MQTT broker on a TCP port. Used by `npm run broker`
 * (and by the solo launcher). In-memory by default — fine for a single machine
 * where the broker and worker start together.
 */
export async function startEmbeddedBroker(
  port = Number(process.env.MQTT_BROKER_PORT ?? 1883),
): Promise<{ close: () => Promise<void> }> {
  const { Aedes } = await import("aedes");
  const aedes = await Aedes.createBroker();

  // Say when a client id is taken over. Salted client ids mean this should never
  // happen now, so if it does the operator is looking at two hives sharing a
  // broker, or an orphan from a previous run still holding subscriptions — and
  // either way the symptom (a task quietly running twice) is far harder to read
  // than the cause. The broker used to register no listeners at all, which is why
  // the original storm was invisible.
  const connected = new Set<string>();
  aedes.on("client", (client) => {
    if (client.id && connected.has(client.id)) {
      console.warn(
        `[broker] client id '${client.id}' reconnected while already connected — ` +
          `MQTT treats that as one session, so the older connection was closed. ` +
          `Two hives on one broker, or a leftover process?`,
      );
    }
    if (client.id) connected.add(client.id);
  });
  aedes.on("clientDisconnect", (client) => {
    if (client.id) connected.delete(client.id);
  });

  const server: Server = createServer(aedes.handle);
  await new Promise<void>((resolve) => server.listen(port, () => resolve()));
  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => aedes.close(() => resolve()));
    },
  };
}
