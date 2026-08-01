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
  const consumerTags: string[] = [];

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
      const { consumerTag } = await channel.consume(queue, (raw: ConsumeMessage | null) => {
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
      consumerTags.push(consumerTag);
    },
    async pause() {
      // Cancel the subscriptions, keep the channel open so results and the
      // goodbye can still be published. Anything already delivered is still
      // ours to finish and ack; anything not yet delivered stays queued for the
      // next consumer, which is precisely what makes a drain safe here.
      await Promise.all(
        consumerTags.splice(0).map((tag) => channel.cancel(tag).catch(() => {})),
      );
    },
    async close() {
      await channel.close();
      await conn.close();
    },
  };
}
