import { z } from "zod";
import { CapabilityRecord, Difficulty, Sensitivity, Tier, Urgency } from "./capability.js";
import { HostInventory } from "./host.js";

// ---------- tasks ----------

export const TaskSpec = z.object({
  customerId: z.string(),
  title: z.string(),
  /** short brief; large inputs go to the artifact store and are referenced */
  input: z.string(),
  /** artifact store paths, passed by reference to keep broker messages and prompts small */
  artifacts: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  sensitivity: Sensitivity.default("normal"),
  urgency: Urgency.default("normal"),
  /** pin to a specific worker (site-bound tasks); bypasses tier queues */
  pinnedAgentId: z.string().optional(),
  /** structured payload; lets the Queen match tier-4 tools by input schema */
  toolInput: z.record(z.unknown()).optional(),
  /**
   * DAG edges for planner-decomposed work: local keys of tasks whose results
   * this task depends on. Ignored by the single-task intake path, so adding it
   * is backward compatible. Tier and budget stay Queen-computed regardless.
   */
  dependsOn: z.array(z.string()).default([]),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

export const TaskEnvelope = z.object({
  maxUsd: z.number(),
  tier: Tier,
  allowEscalation: z.boolean(),
  urgency: Urgency,
  /** set when the Queen had to route below the capability the task deserved */
  degraded: z.boolean().default(false),
});
export type TaskEnvelope = z.infer<typeof TaskEnvelope>;

export const TaskMessage = z.object({
  kind: z.literal("task"),
  taskId: z.string(),
  spec: TaskSpec,
  envelope: TaskEnvelope,
  difficulty: Difficulty,
  /** present when this dispatch is a retry escalated from a failed lower tier */
  escalation: z
    .object({
      fromTier: Tier,
      attempt: z.number(),
      /** failure summary only, never the full lower-tier transcript */
      failureSummary: z.string(),
    })
    .optional(),
  matchedToolId: z.string().optional(),
  /**
   * The capability record the Queen priced the dispatch against. A hint, not a
   * command: tier queues are shared, so the consuming worker honors the tier
   * and billing class but picks its own matching record (its model, its seat).
   */
  capabilityHint: CapabilityRecord.optional(),
});
export type TaskMessage = z.infer<typeof TaskMessage>;

export const TaskResult = z.object({
  kind: z.literal("task.result"),
  taskId: z.string(),
  agentId: z.string(),
  customerId: z.string(),
  ok: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
  tierUsed: Tier,
  /**
   * The configured agent that OWNED this dispatch (the capability's `agent`,
   * else its runtime). `runtime` below keeps reporting what actually executed,
   * so `agent !== runtime` is precisely a fallback — the bee reached for one
   * thing and ran another. Keeping both means the console can say so instead of
   * quietly showing whichever one happens to be handy.
   */
  agent: z.string().optional(),
  runtime: z.string(),
  model: z.string().optional(),
  billing: z.string(),
  /** subscription seat the tokens were metered against, when billing = subscription */
  seatId: z.string().optional(),
  usage: z.object({
    inputTokens: z.number().default(0),
    outputTokens: z.number().default(0),
    costUsd: z.number().default(0),
  }),
  degraded: z.boolean().default(false),
  durationMs: z.number(),
});
export type TaskResult = z.infer<typeof TaskResult>;

/**
 * A bee is still working on a task.
 *
 * Adapters run one buffered `execFile`/`fetch` per task, so there is no
 * intra-task progress to report and this deliberately does not pretend
 * otherwise: no percentage, no step count, no partial output. What it does
 * carry is liveness and elapsed time, which is the one thing the console cannot
 * infer — a bee chewing on a five-minute `claude -p` run and a bee that died
 * mid-task look identical from the Queen's side otherwise.
 *
 * Nothing here is derived from the prompt or the output. See the note on
 * AgentLog.text: a task the hive promised to keep on the machine must not have
 * its content published to the broker by the thing reporting on it.
 */
export const TaskProgress = z.object({
  kind: z.literal("task.progress"),
  taskId: z.string(),
  agentId: z.string(),
  at: z.number(),
  elapsedMs: z.number(),
  attempt: z.number().default(1),
  tier: Tier,
  /** the configured agent that owns this dispatch; see TaskResult.agent */
  agent: z.string().optional(),
  runtime: z.string(),
  model: z.string().optional(),
});
export type TaskProgress = z.infer<typeof TaskProgress>;

/**
 * Ordered cheapest-to-loudest, so a threshold is a simple index comparison.
 * Deliberately the four everyone already knows rather than a hive-flavored
 * vocabulary — this one is plumbing, not part of the metaphor.
 */
export const LogLevel = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevel>;

const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];

/** True when `level` is at or above `threshold`. The only ranking rule; shared so the bee's gate and the Queen's filter cannot disagree. */
export function atLeast(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(threshold);
}

/**
 * One narration line from a bee, so the console can answer "what is that worker
 * doing" without an operator having to find its terminal.
 *
 * `text` carries identifiers and decisions ONLY — never `spec.input`, never
 * `result.output`, never prompt text. This is not a style preference. The hive's
 * confidentiality promise is that work marked confidential stays on the machine
 * that ran it; a log line echoing the prompt would publish exactly that content
 * to the broker and on into a browser tab, defeating the guarantee from the
 * side no one is watching. Log what happened and to which task, not what it said.
 */
export const AgentLog = z.object({
  kind: z.literal("agent.log"),
  agentId: z.string(),
  level: LogLevel,
  at: z.number(),
  text: z.string().max(500),
  /** present when the line belongs to one task, so a card can show its own lines */
  taskId: z.string().optional(),
});
export type AgentLog = z.infer<typeof AgentLog>;

// ---------- control ----------

export const AgentHello = z.object({
  kind: z.literal("agent.hello"),
  agentId: z.string(),
  site: z.string(),
  capabilities: z.array(CapabilityRecord),
  /**
   * Whether this worker also binds the "general" fan-in queue for each of its
   * capability tiers. Bees that own disjoint skill sets on a shared tier opt out
   * (bindGeneral: false) so the embedded MQTT broker does not double-deliver.
   * Defaulted for backward compatibility with pre-personal-bee workers.
   */
  bindsGeneral: z.boolean().default(true),
  /**
   * What this worker's machine could run, for the console's Setup view. Rides
   * the hello rather than a second message: it changes on exactly the same
   * events, and the registry already stores and dates whatever arrives here.
   * Optional, so a worker from before this field still registers.
   */
  host: HostInventory.optional(),
});
export type AgentHello = z.infer<typeof AgentHello>;

export const AgentHeartbeat = z.object({
  kind: z.literal("agent.heartbeat"),
  agentId: z.string(),
  at: z.number(),
});
export type AgentHeartbeat = z.infer<typeof AgentHeartbeat>;

export const BudgetRequest = z.object({
  kind: z.literal("budget.request"),
  agentId: z.string(),
  customerId: z.string(),
  reason: z.string(),
});
export type BudgetRequest = z.infer<typeof BudgetRequest>;

export const BudgetGrant = z.object({
  kind: z.literal("budget.grant"),
  agentId: z.string(),
  leaseId: z.string(),
  usdAllowance: z.number(),
  /** token share on a subscription seat, 0 for API-only workers */
  quotaTokens: z.number().default(0),
  periodSeconds: z.number(),
});
export type BudgetGrant = z.infer<typeof BudgetGrant>;

// ---------- telemetry ----------

export const UsageReport = z.object({
  kind: z.literal("telemetry.usage"),
  agentId: z.string(),
  customerId: z.string(),
  tasksCompleted: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  windowStart: z.number(),
  windowEnd: z.number(),
});
export type UsageReport = z.infer<typeof UsageReport>;
