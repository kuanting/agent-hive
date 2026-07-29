export * from "./types.js";
export { connectAmqpBus } from "./amqp.js";
export { connectMqttBus, startEmbeddedBroker } from "./mqtt.js";

import { connectAmqpBus } from "./amqp.js";
import { connectMqttBus } from "./mqtt.js";
import type { Bus } from "./types.js";

/**
 * Select the broker backend from the environment:
 *   HIVE_BROKER=mqtt  ->  embedded Aedes (lightweight mode)
 *   anything else     ->  amqp (RabbitMQ, the default and the production path)
 *
 * The solo launcher (`npm run solo`) sets HIVE_BROKER=mqtt; everything else keeps
 * RabbitMQ.
 *
 * Lightweight mode is opt-in ONLY, and only by name. This used to fall back to
 * `MQTT_URL ? "mqtt" : "amqp"`, so merely having MQTT_URL in a .env — it is also
 * read by `demo/watch.ts` — silently moved a Queen onto the backend with weaker
 * delivery guarantees. The two backends genuinely differ (amqp acks on
 * completion and redelivers, mqtt acks on receipt and leans on the Queen's
 * reaper), so which one is running has to be a decision, never an inference.
 */
export async function connectBus(): Promise<Bus> {
  return process.env.HIVE_BROKER === "mqtt" ? connectMqttBus() : connectAmqpBus();
}
