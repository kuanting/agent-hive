import amqplib, { type ChannelModel, type ConsumeMessage } from "amqplib";
import { DEAD_LETTER, EXCHANGES, type Bus } from "./types.js";

/**
 * RabbitMQ backend. Three durable topic exchanges + a dead-letter queue;
 * competing consumers on shared queue names, prefetch-bounded, manual ack.
 * This is the "large-scale / multi-node" path.
 */
export async function connectAmqpBus(url = process.env.AMQP_URL ?? "amqp://localhost:5672"): Promise<Bus> {
  const conn: ChannelModel = await amqplib.connect(url);
  const channel = await conn.createChannel();
  for (const ex of Object.values(EXCHANGES)) {
    await channel.assertExchange(ex, "topic", { durable: true });
  }
  await channel.assertQueue(DEAD_LETTER, { durable: true });

  return {
    publish(exchange, routingKey, payload) {
      channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)), {
        persistent: true,
        contentType: "application/json",
      });
    },
    async consume(exchange, queue, patterns, schema, handler, opts = {}) {
      const { prefetch = 1, durable = true } = opts;
      await channel.assertQueue(queue, {
        durable,
        deadLetterExchange: "",
        deadLetterRoutingKey: DEAD_LETTER,
      });
      for (const p of patterns) await channel.bindQueue(queue, exchange, p);
      await channel.prefetch(prefetch);
      await channel.consume(queue, (raw: ConsumeMessage | null) => {
        if (!raw) return;
        void (async () => {
          try {
            const parsed = schema.parse(JSON.parse(raw.content.toString()));
            await handler(parsed, raw.fields.routingKey);
            channel.ack(raw);
          } catch (err) {
            console.error(`[amqp] ${queue} handler failed, dead-lettering:`, err);
            channel.nack(raw, false, false);
          }
        })();
      });
    },
    async close() {
      await channel.close();
      await conn.close();
    },
  };
}
