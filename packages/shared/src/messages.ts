import { z } from "zod";
import { CapabilityRecord, CapabilitySelector, Difficulty, Sensitivity, Tier, Urgency } from "./capability.js";
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

// ---------- serving a caller's own agent loop ----------
//
// Everything in this block is OpenAI-shaped on purpose. It is the format the
// callers already speak, and translating at the edge — once, in the adapter that
// talks to each provider — is cheaper than inventing a hive dialect that every
// client would then have to be taught.

/** A tool the CALLER owns. The hive decides one should be used; the caller runs it. */
export const ToolDefinition = z.object({
  type: z.literal("function").default("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    /** JSON Schema, passed through untouched — the hive never validates a caller's tool */
    parameters: z.record(z.unknown()).optional(),
  }),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const ToolCall = z.object({
  id: z.string(),
  type: z.literal("function").default("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ChatTurn = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().default(""),
  /** on an assistant turn: what it decided to call */
  tool_calls: z.array(ToolCall).optional(),
  /** on a tool turn: which call this answers */
  tool_call_id: z.string().optional(),
});
export type ChatTurn = z.infer<typeof ChatTurn>;

/**
 * A turn in someone else's agent loop, forwarded verbatim.
 *
 * This is the mode where the hive is a *model* rather than a worker, and the two
 * cannot share a prompt. A task gets `STABLE_PROMPT_PREFIX` — "you are a worker
 * bee, return the result itself" — which is precisely the wrong instruction for
 * a turn whose caller has its own system prompt, its own tools and its own idea
 * of what the assistant is. So passthrough replaces the hive's prompt assembly
 * rather than adding to it: the caller owns every message, and the hive owns
 * only which bee answers.
 *
 * Artifacts, escalation summaries and the task title have no place here, which
 * is why they are absent rather than merged in.
 */
export const Passthrough = z.object({
  messages: z.array(ChatTurn).min(1),
  tools: z.array(ToolDefinition).default([]),
  /** "auto" | "none" | "required" | {type:"function",...}; forwarded, never interpreted */
  toolChoice: z.unknown().optional(),
  temperature: z.number().optional(),
  maxOutputTokens: z.number().optional(),
});
export type Passthrough = z.infer<typeof Passthrough>;

/**
 * Who a task is FOR, when the hive serves an organisation's members.
 *
 * Stamped by the Queen from the caller it authenticated, never by a planner or a
 * caller's spec: a field the requester could write would let one employee name
 * another and borrow their agent. A member-owned bee checks it as a second line
 * of defence, because the Queen's routing is the first and a single check is a
 * single bug away from a leak.
 *
 * Opaque ids only (`mbr_…`, `dep_…`). The hive never learns a name or an email.
 */
export const Principal = z.object({
  memberId: z.string(),
  departmentIds: z.array(z.string()).default([]),
});
export type Principal = z.infer<typeof Principal>;

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
   * A hard constraint the bee must honour when it picks its own record —
   * unlike `capabilityHint`, which it is free to reinterpret.
   *
   * Both exist because the two answer different questions. The hint says "this
   * is what the Queen priced the dispatch against", and a bee holding several
   * records on one tier is expected to substitute its own. The requirement says
   * "the caller asked for this specifically", and substituting is exactly what
   * must not happen: a request for grounded search answered by a bee without it
   * does not fail, it returns something plausible and wrong.
   *
   * Absent on almost every dispatch. Present when a caller named a capability.
   */
  requirement: CapabilitySelector.optional(),
  /**
   * Present when this dispatch is a turn in the caller's own agent loop rather
   * than a task the hive was asked to complete. See `Passthrough`.
   */
  passthrough: Passthrough.optional(),
  /**
   * A runtime-owned session id to resume instead of starting cold — the Queen's
   * resolution of `spec.continues` into something the bee can act on.
   *
   * Present only when the Queen confirmed the predecessor ran on *this* bee and
   * that resuming is permitted at this task's sensitivity. The bee treats it as
   * an optimization: if the session is gone, it runs cold rather than failing.
   */
  resumeSession: z.string().optional(),
  /** the member this task runs for; absent on ordinary hive work. See `Principal`. */
  principal: Principal.optional(),
  /**
   * The bee must ask its person before running this. Set when someone other
   * than the member assigned the work and the member's policy asks for consent.
   * A headless bee with nobody to ask approves on its own.
   */
  requireApproval: z.boolean().optional(),
});
export type TaskMessage = z.infer<typeof TaskMessage>;

/**
 * Why a task ended without anyone retrying it.
 *
 * A failed attempt normally escalates, which is right when the model was not
 * good enough and wrong in all three of these cases: a cancelled task should
 * stop, a person who declined should not be overruled by a bigger model, and a
 * bee that refused work outside its scope will refuse again at any tier.
 */
export const TerminalReason = z.enum(["cancelled", "declined", "out-of-scope"]);
export type TerminalReason = z.infer<typeof TerminalReason>;
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
  /**
   * What the model decided to call, when the caller supplied tools. The hive
   * never executes these: a caller's `read_file` reads the caller's disk, and a
   * hive that ran them would be answering from the wrong machine.
   */
  toolCalls: z.array(ToolCall).optional(),
  /**
   * Why generation stopped, in OpenAI's vocabulary, when the runtime says.
   *
   * Carried because the difference between "finished" and "hit the output cap"
   * is invisible in the text itself — a survey truncated at max_tokens reads
   * like a survey — and a caller looping on tool calls has to know which one it
   * got.
   */
  finishReason: z.enum(["stop", "length", "tool_calls", "content_filter"]).optional(),
  /** set when the task must not be retried; see `TerminalReason` */
  terminal: TerminalReason.optional(),
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
  state: z.enum(["queued", "awaiting-approval", "running"]).default("running"),
  tier: Tier,
  /** the configured agent that owns this dispatch; see TaskResult.agent */
  agent: z.string().optional(),
  runtime: z.string(),
  model: z.string().optional(),
  /**
   * What the bee is doing right now, in a fixed vocabulary, when its runtime can
   * say ("reading-files", "thinking", "writing"). A label, never content: the
   * same rule as AgentLog.text applies, so this is capped and enum-like by
   * convention.
   */
  phase: z.string().max(40).optional(),
  /** step n of an optional total, for runtimes that work in rounds */
  step: z.object({ n: z.number().int().min(0), of: z.number().int().min(1).optional() }).optional(),
});
export type TaskProgress = z.infer<typeof TaskProgress>;

/**
 * "Stop working on this task" — aimed at one bee, or at every bee when the
 * Queen does not know who holds it.
 *
 * A bee that holds the task drops it if it is still queued and aborts it if it
 * is running. A bee that does not hold it ignores the message, which is what
 * makes the broadcast form safe.
 */
export const QueenCancel = z.object({
  kind: z.literal("queen.cancel"),
  taskId: z.string(),
  /** absent cancels every attempt this bee holds */
  attempt: z.number().int().min(1).optional(),
  reason: z.string().max(200).optional(),
  at: z.number(),
});
export type QueenCancel = z.infer<typeof QueenCancel>;
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
  /**
   * Whom this bee works for. Absent means a shared bee that takes anyone's work
   * from the tier queues, which is every bee from before this field.
   *
   * A bee with an owner is SCOPED: it binds only its direct queue, and the Queen
   * routes to it only work for that member (or for a member of that department).
   * Its data, a person's folders or a department's share, never serves anyone
   * else's request.
   */
  owner: z
    .object({
      memberId: z.string().optional(),
      departmentId: z.string().optional(),
    })
    .optional(),
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
