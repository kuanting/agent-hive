/**
 * Transport-agnostic message bus contract. Both the RabbitMQ (amqp) and the
 * embedded MQTT (Aedes) backends implement `Bus`, so the queen and workers are
 * written against this interface and never touch a concrete broker.
 */

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
  publish(exchange: string, routingKey: string, payload: unknown): void;
  /** durable queue bound to routing patterns; handler acks on success, dead-letters on parse/handler failure */
  consume<T>(
    exchange: string,
    queue: string,
    patterns: string[],
    schema: ParseSchema<T>,
    handler: (msg: T, routingKey: string) => Promise<void>,
    opts?: { prefetch?: number; durable?: boolean },
  ): Promise<void>;
  /**
   * Stop delivering new messages to handlers, while publishing keeps working.
   *
   * This is what draining needs and what neither backend could express before.
   * A bee that is shutting down must stop *receiving* — not merely decline to
   * act — because declining is not free: on the embedded broker a message is
   * acked on receipt, so ignoring it drops the task, and on amqp the ack fires
   * when the handler resolves, so returning early acks a task nobody ran and it
   * is gone for good. Cancelling the subscription instead leaves the work where
   * the next consumer, or the Queen's own recovery, can still find it.
   *
   * Publishing must survive the pause: a draining bee still has results to
   * report and a goodbye to say.
   */
  pause(): Promise<void>;
  close(): Promise<void>;
}

export function tierQueueKey(tier: number, skill: string): string {
  return `tasks.t${tier}.${skill}`;
}

export function directQueueKey(agentId: string): string {
  return `tasks.direct.${agentId}`;
}
