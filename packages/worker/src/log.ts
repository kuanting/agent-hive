import { atLeast, EXCHANGES, LogLevel, type Bus } from "@hive/shared";

/**
 * A bee's narration, sent to two places at once.
 *
 * Every bee already tells its own terminal what it is doing — which record it
 * picked, when it substituted a runtime, when the budget guard refused a call.
 * That narration is the best debugging surface the hive has and it was reaching
 * exactly one audience: whoever happened to be tailing that process. Under
 * `npm run solo` four bees share a terminal; under the amqp backend they are on
 * different hosts. Either way the person watching the console could not see it.
 *
 * So the same call does both: it prints as before, and it publishes an AgentLog
 * so the Queen can merge it into one feed. The console gains the bee's own voice
 * without the bee gaining a second, divergent set of log statements to maintain.
 *
 * Publishing is best-effort by design. A log line that throws — a closed bus
 * mid-shutdown, a broker hiccup — must never fail the task it was describing.
 */
export type BeeLog = (level: LogLevel, text: string, taskId?: string) => void;

/**
 * Threshold for both the terminal and the wire, so what an operator reads in the
 * console and what they read in the bee's stdout can never disagree. `info` keeps
 * today's output byte-for-byte; `debug` adds the per-task detail that would
 * otherwise drown it.
 */
export function configuredLevel(raw = process.env.HIVE_LOG_LEVEL): LogLevel {
  const parsed = LogLevel.safeParse(raw);
  return parsed.success ? parsed.data : "info";
}

/** Truncated to the schema's limit here rather than at parse time, so an over-long line is trimmed instead of dead-lettered. */
const MAX_TEXT = 500;

export function createBeeLog(agentId: string, bus?: Pick<Bus, "publish">, threshold: LogLevel = configuredLevel()): BeeLog {
  const sink: Record<LogLevel, (msg: string) => void> = {
    debug: (m) => console.log(m),
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };

  return (level, text, taskId) => {
    if (!atLeast(level, threshold)) return;
    const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
    sink[level](`[${agentId}] ${clipped}`);
    if (!bus) return;
    try {
      bus.publish(EXCHANGES.telemetry, `agent.log.${agentId}`, {
        kind: "agent.log",
        agentId,
        level,
        at: Date.now(),
        text: clipped,
        taskId,
      });
    } catch {
      /* narration must never break the work it narrates */
    }
  };
}
