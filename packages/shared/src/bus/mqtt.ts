import { createServer, type Server } from "node:net";
import { connect, type MqttClient } from "mqtt";
import type { Bus } from "./types.js";

/**
 * Embedded MQTT backend (Aedes broker + MQTT.js clients). The "single-machine /
 * solo" path: a pure-JS broker that installs from npm and runs in-process, so
 * `npm install` + one command brings up the whole hive with no Docker.
 *
 * Semantics mapped from the RabbitMQ topic exchanges:
 *  - exchange + routing key  -> MQTT topic   (`hive.tasks/tasks/t3/coding`)
 *  - AMQP topic patterns     -> MQTT filters (`*`->`+`, `#` stays `#`)
 *  - per-task-cap ordering    -> QoS 1 + one-at-a-time `handleMessage` backpressure
 *  - ack on success / DLQ     -> ack via the handleMessage callback, republish to `hive.dlq` on failure
 *
 * Boundary: Aedes has no MQTT shared subscriptions (moscajs/aedes#841), so it
 * cannot load-balance one task across several *overlapping* workers the way
 * RabbitMQ competing-consumer queues do. The solo launcher runs a single worker,
 * so there is nothing to balance; use the amqp backend for horizontal worker scale.
 */

const DLQ_TOPIC = "hive.dlq";

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

  const { ready: pubReady } = open(`hive-pub-${process.pid}`, true);
  const publisher = await pubReady;

  return {
    publish(exchange, routingKey, payload) {
      publisher.publish(toTopic(exchange, routingKey), JSON.stringify(payload), { qos: 1 });
    },

    async consume(exchange, queue, patterns, schema, handler) {
      // A persistent session per queue (stable clientId) so QoS-1 messages published
      // while a consumer is briefly down are redelivered on reconnect.
      const { client, ready } = open(`hive-${queue}`, false);

      // Overriding handleMessage gives us both prefetch=1 backpressure ("one at a
      // time") and manual ack: the PUBACK fires when we invoke the callback.
      client.handleMessage = ((packet: { topic: string; payload: Buffer }, done: (err?: Error) => void) => {
        void (async () => {
          try {
            const parsed = schema.parse(JSON.parse(packet.payload.toString()));
            await handler(parsed, toRoutingKey(exchange, packet.topic));
          } catch (err) {
            console.error(`[mqtt] ${queue} handler failed, dead-lettering:`, err);
            try {
              publisher.publish(DLQ_TOPIC, packet.payload, { qos: 1 });
            } catch {
              /* best-effort DLQ */
            }
          } finally {
            done(); // ack + release backpressure for the next message
          }
        })();
      }) as MqttClient["handleMessage"];

      await ready;
      const filters = patterns.map((p) => toFilter(exchange, p));
      await new Promise<void>((resolve, reject) =>
        client.subscribe(filters, { qos: 1 }, (err) => (err ? reject(err) : resolve())),
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
  const server: Server = createServer(aedes.handle);
  await new Promise<void>((resolve) => server.listen(port, () => resolve()));
  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => aedes.close(() => resolve()));
    },
  };
}
