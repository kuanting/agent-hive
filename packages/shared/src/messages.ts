import { z } from "zod";
import { CapabilityRecord, Difficulty, Sensitivity, Tier, Urgency } from "./capability.js";

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
