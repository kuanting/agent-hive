import amqplib, { type Channel, type ChannelModel, type ConsumeMessage } from "amqplib";

/** structural schema type so consume<T> infers the parsed (output) type */
export interface ParseSchema<T> {
  parse(data: unknown): T;
}

export const EXCHANGES = {
  tasks: "hive.tasks",
  control: "hive.control",
  telemetry: "hive.telemetry",
} as const;

export const DEAD_LETTER = "hive.tasks.dlq";

export interface Bus {
  channel: Channel;
  publish(exchange: string, routingKey: string, payload: unknown): void;
  /** durable queue bound to routing patterns; handler acks on success, nacks to DLQ on parse/handler failure */
  consume<T>(
    exchange: string,
    queue: string,
    patterns: string[],
    schema: ParseSchema<T>,
    handler: (msg: T, routingKey: string) => Promise<void>,
    opts?: { prefetch?: number; durable?: boolean },
  ): Promise<void>;
  close(): Promise<void>;
}

export async function connectBus(url = process.env.AMQP_URL ?? "amqp://localhost:5672"): Promise<Bus> {
  const conn: ChannelModel = await amqplib.connect(url);
  const channel = await conn.createChannel();
  for (const ex of Object.values(EXCHANGES)) {
    await channel.assertExchange(ex, "topic", { durable: true });
  }
  await channel.assertQueue(DEAD_LETTER, { durable: true });

  return {
    channel,
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

export function tierQueueKey(tier: number, skill: string): string {
  return `tasks.t${tier}.${skill}`;
}

export function directQueueKey(agentId: string): string {
  return `tasks.direct.${agentId}`;
}
