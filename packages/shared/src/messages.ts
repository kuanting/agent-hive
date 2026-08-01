import { z } from "zod";
import { CapabilityRecord, Difficulty, Sensitivity, Tier, Urgency } from "./capability.js";
import { HostInventory } from "./host.js";

// ---------- tasks ----------
//
// The `#region` markers below are read by the docs site, which embeds these
// schemas verbatim rather than paraphrasing them (docs/reference/messages.md).
// They are comments: `tsc` and the bundlers ignore them entirely.

// #region taskspec
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
  /**
   * A hive `taskId` this task continues — distinct from `dependsOn`, which holds
   * planner-local keys within one plan and passes results by artifact. This says
   * "the same conversation, one turn later", and it is a *request*, not an
   * instruction: the Queen honors it only if the predecessor's bee is still live,
   * still holds a session, and is allowed to run work at this sensitivity.
   * Nothing fails when it is refused; the task just runs cold.
   */
  continues: z.string().optional(),
});
export type TaskSpec = z.infer<typeof TaskSpec>;
// #endregion taskspec

// #region taskenvelope
export const TaskEnvelope = z.object({
  maxUsd: z.number(),
  tier: Tier,
  allowEscalation: z.boolean(),
  urgency: Urgency,
  /** set when the Queen had to route below the capability the task deserved */
  degraded: z.boolean().default(false),
});
export type TaskEnvelope = z.infer<typeof TaskEnvelope>;
// #endregion taskenvelope

// #region taskmessage
export const TaskMessage = z.object({
  kind: z.literal("task"),
  taskId: z.string(),
  /**
   * Which dispatch of this task this is. `(taskId, attempt)` — not taskId alone —
   * identifies one execution, and every dedup in the hive keys on the pair.
   *
   * The distinction is the whole point: a duplicate carrying the SAME attempt is
   * the transport delivering twice and must never re-run the work, while a NEW
   * attempt is the Queen deliberately paying for a retry. Without it a late
   * result from a superseded attempt is indistinguishable from the live one, and
   * the Queen would re-dispatch a task that has already finished.
   */
  attempt: z.number().int().min(1).default(1),
  spec: TaskSpec,
  envelope: TaskEnvelope,
  difficulty: Difficulty,
  /** present when this dispatch is a retry escalated from a failed lower tier */
  escalation: z
    .object({
      fromTier: Tier,
      attempt: z.number(),
      /** one-line summary of how the previous attempt failed */
      failureSummary: z.string(),
      /**
       * Artifact ref holding what the failed attempt actually produced.
       *
       * A summary alone made attempt 2 start nearly cold, so it could repeat
       * attempt 1's mistake and burn the escalation ladder converging on
       * nothing. Passing the prior output *by reference* is the same move the
       * orchestrator already makes for step dependencies: the retry gets real
       * evidence, and the broker message stays small. Absent when the failed
       * attempt produced no output worth keeping.
       */
      priorOutputRef: z.string().optional(),
    })
    .optional(),
  matchedToolId: z.string().optional(),
  /**
   * The capability record the Queen priced the dispatch against. A hint, not a
   * command: tier queues are shared, so the consuming worker honors the tier
   * and billing class but picks its own matching record (its model, its seat).
   */
  capabilityHint: CapabilityRecord.optional(),
  /**
   * A runtime-owned session id to resume instead of starting cold — the Queen's
   * resolution of `spec.continues` into something the bee can act on.
   *
   * Present only when the Queen confirmed the predecessor ran on *this* bee and
   * that resuming is permitted at this task's sensitivity. The bee treats it as
   * an optimization: if the session is gone, it runs cold rather than failing.
   */
  resumeSession: z.string().optional(),
});
export type TaskMessage = z.infer<typeof TaskMessage>;
// #endregion taskmessage

// #region taskresult
export const TaskResult = z.object({
  kind: z.literal("task.result"),
  taskId: z.string(),
  /** echoes TaskMessage.attempt, so the Queen can tell a live result from a superseded one */
  attempt: z.number().int().min(1).default(1),
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
  /**
   * The runtime's own session id for this execution, when it has one, so a later
   * task can ask to continue the same conversation on the same bee.
   *
   * An identifier, not content — which is what makes it safe to put on the wire
   * and in a log line at all. The transcript it points at never leaves the
   * machine that ran it; see the note on AgentLog.text.
   */
  sessionRef: z.string().optional(),
  usage: z.object({
    inputTokens: z.number().default(0),
    outputTokens: z.number().default(0),
    costUsd: z.number().default(0),
  }),
  degraded: z.boolean().default(false),
  durationMs: z.number(),
});
export type TaskResult = z.infer<typeof TaskResult>;
// #endregion taskresult

// #region taskprogress
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
  /**
   * A bee ticks for every task it HOLDS, not only the one it is running, so this
   * says which. `queued` means received and waiting on the concurrency cap —
   * which matters because on the lightweight backend the first tick is also the
   * acceptance signal, and "no tick at all" is how the Queen learns a dispatch
   * was lost. Defaulted for a worker that predates the field.
   */
  state: z.enum(["queued", "running"]).default("running"),
  tier: Tier,
  /** the configured agent that owns this dispatch; see TaskResult.agent */
  agent: z.string().optional(),
  runtime: z.string(),
  model: z.string().optional(),
});
export type TaskProgress = z.infer<typeof TaskProgress>;
// #endregion taskprogress

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
// #region agentlog
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
// #endregion agentlog

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

/**
 * "Who is out there?" — the Queen asking bees to introduce themselves.
 *
 * Registration used to be push-only and lossy: a bee published `agent.hello` and
 * hoped. A publish to a topic nobody has subscribed to yet is dropped silently,
 * so if the Queen's control consumer was not up the hello vanished — and since
 * `WorkerRegistry.heartbeat` ignores an unknown agentId, heartbeats never healed
 * it either. The bee idled forever, invisible, and the workaround was to shout
 * six times and hope one landed.
 *
 * A question closes the race that repetition only made less likely. The Queen
 * broadcasts once its consumer is ready, and sends a targeted one to any agentId
 * it hears a heartbeat from but does not know — which makes a lost hello
 * self-healing within one heartbeat instead of never.
 *
 * `agentId` absent means everyone; present means just that bee.
 */
export const QueenRollcall = z.object({
  kind: z.literal("queen.rollcall"),
  agentId: z.string().optional(),
  at: z.number(),
});
export type QueenRollcall = z.infer<typeof QueenRollcall>;

/**
 * "Stop the hive" — an ORDER, not an observation.
 *
 * The distinction is the whole reason this message exists. A Queen that dies,
 * restarts or is redeployed must leave its bees running: they are autonomous
 * consumers, often on other machines, and an operator restarting the control
 * plane should not lose a fleet. So the Queen's own SIGINT deliberately does NOT
 * publish this, and nothing infers a shutdown from the Queen's absence.
 *
 * Only an explicit request does — which is exactly the case that had no way to
 * be expressed before: stopping the hive meant finding and killing every worker
 * process on every host by hand.
 */
export const QueenShutdown = z.object({
  kind: z.literal("queen.shutdown"),
  at: z.number(),
  /** shown in each bee's log, so the reason survives into the terminal that outlives the hive */
  reason: z.string().optional(),
});
export type QueenShutdown = z.infer<typeof QueenShutdown>;

/**
 * A bee's last word: it has drained and is exiting on purpose.
 *
 * Lets the Queen tell "shut down as asked" from "vanished", and lets it wait for
 * the fleet before stopping itself rather than guessing at a timeout. `drained`
 * is how many tasks it finished after being told to stop, which is the number
 * that says whether draining was worth doing.
 */
export const AgentGoodbye = z.object({
  kind: z.literal("agent.goodbye"),
  agentId: z.string(),
  at: z.number(),
  drained: z.number().default(0),
  /** in-flight work abandoned because the drain cap expired first */
  abandoned: z.number().default(0),
});
export type AgentGoodbye = z.infer<typeof AgentGoodbye>;

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
