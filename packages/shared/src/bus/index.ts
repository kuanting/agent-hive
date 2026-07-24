export * from "./types.js";
export { connectAmqpBus } from "./amqp.js";
export { connectMqttBus, startEmbeddedBroker } from "./mqtt.js";

import { connectAmqpBus } from "./amqp.js";
import { connectMqttBus } from "./mqtt.js";
import type { Bus } from "./types.js";

/**
 * Select the broker backend from the environment:
 *   HIVE_BROKER=mqtt|amqp  (explicit)  ->  that backend
 *   else MQTT_URL set                  ->  mqtt (embedded Aedes)
 *   else                               ->  amqp (RabbitMQ, default)
 *
 * The solo launcher (`npm run solo`) sets HIVE_BROKER=mqtt; everything else keeps
 * the RabbitMQ default so existing flows and tests are unaffected.
 */
export async function connectBus(): Promise<Bus> {
  const broker = process.env.HIVE_BROKER ?? (process.env.MQTT_URL ? "mqtt" : "amqp");
  return broker === "mqtt" ? connectMqttBus() : connectAmqpBus();
}
