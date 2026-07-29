import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import {
  AgentHeartbeat,
  AgentHello,
  AgentLog,
  BudgetRequest,
  connectBus,
  CostEstimator,
  directQueueKey,
  EXCHANGES,
  loadCatalog,
  TaskMessage,
  TaskProgress,
  TaskResult,
  TaskSpec,
  tierQueueKey,
  UsageReport,
  type Bus,
  type Difficulty,
  type LogLevel,
} from "@hive/shared";
import { matchTool, scoreDifficulty, userImpliedConfidential, type ToolInfo } from "./analyzer.js";
import { BudgetLedger } from "./budget.js";
import { HiveLog } from "./hiveLog.js";
import { decide, DEFAULT_ROUTE_POLICY, type RoutePolicy } from "./tierMapper.js";
import { WorkerRegistry } from "./registry.js";
import { ResultCache } from "./resultCache.js";

export interface CustomerProfile {
  customerId: string;
  name?: string;
  budget: { capUsd: number };
  seats?: Array<{ seatId: string; windowSeconds: number; tokensPerWindow: number }>;
  tools?: ToolInfo[];
  plannerModel?: string;
  /** routing preferences; see RoutePolicy. Absent or malformed falls back to the safe default. */
  policy?: RoutePolicy;
}

/** Coerce a customer's raw policy to a valid RoutePolicy, defaulting unknown values safely. */
function resolvePolicy(profile?: CustomerProfile): RoutePolicy {
  return profile?.policy?.onBudgetBlock === "degrade" ? { onBudgetBlock: "degrade" } : DEFAULT_ROUTE_POLICY;
}

/**
 * Route a task onto a skill the chosen worker actually binds. The planner emits
 * free-form skill tags, so prefer one the capability shares; otherwise fall back
 * to the capability's own first skill (always bound by its worker) rather than
 * "general" — a bee with bindGeneral:false (e.g. the personal bee) does not
 * consume the general queue, so routing there would silently drop the task.
 */
export function pickRouteSkill(specSkills: string[], capSkills: string[]): string {
  return specSkills.find((s) => capSkills.includes(s)) ?? capSkills[0] ?? "general";
}

export interface TaskState {
  taskId: string;
  spec: TaskSpec;
  difficulty: Difficulty;
  status: "dispatched" | "deferred" | "done" | "failed";
  /** executions actually attempted; what MAX_ATTEMPTS bounds */
  attempts: number;
  /** times this task waited for a seat window instead of being dispatched */
  deferrals: number;
  reason: string;
  result?: TaskResult;
  /** when the task entered the hive, so "how long has this been going" needs no second endpoint */
  startedAt: number;
  /** when the current attempt was published; the clock the accept deadline runs against */
  dispatchedAt?: number;
  /** last liveness tick from the bee executing it; absent means it has not started running */
  lastProgressAt?: number;
  /** the bee currently working on it, as reported by its own ticks */
  runningOn?: { agentId: string; tier: number; agent?: string; runtime: string; model?: string };
}

export interface SubmitOutcome {
  taskId: string;
  status: TaskState["status"];
  difficulty: Difficulty;
  reason: string;
  cached?: boolean;
  result?: TaskResult;
}

export type TaskEvent =
  | { kind: "created"; taskId: string; difficulty: Difficulty }
  | { kind: "dispatched"; taskId: string; reason: string; tier: number; degraded: boolean }
  | { kind: "deferred"; taskId: string; reason: string }
  /** a bee saying it is still working; the only signal between dispatch and result */
  | { kind: "progress"; taskId: string; progress: TaskProgress }
  | { kind: "done"; taskId: string; result: TaskResult }
  | { kind: "failed"; taskId: string; result: TaskResult };

const MAX_ATTEMPTS = 3;
/**
 * How long a dispatched task may go without a single progress tick before the
 * Queen concludes the message never landed. Comfortably over the bee's tick
 * interval, since the bee ticks once immediately on receipt.
 */
const ACCEPT_TIMEOUT_MS = Number(process.env.HIVE_ACCEPT_TIMEOUT_MS ?? 15_000);
/** How long a bee that WAS ticking may go silent before it is presumed dead. */
const STALL_TIMEOUT_MS = Number(process.env.HIVE_STALL_TIMEOUT_MS ?? 30_000);
const REAPER_INTERVAL_MS = 5_000;
/** Least time between two rollcalls aimed at the same unregistered bee. */
const ROLLCALL_MIN_INTERVAL_MS = 60_000;
const ESCALATE: Record<Difficulty, Difficulty> = {
  simple: "standard",
  standard: "complex",
  complex: "complex",
};

function loadCustomers(dir: string): CustomerProfile[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => parse(readFileSync(join(dir, f), "utf8")) as CustomerProfile);
  } catch {
    return [];
  }
}

/**
 * The deterministic authority of the hive. Both the HTTP intake and the
 * conversational planner go through submitTask; nothing bypasses it. The
 * planner proposes TaskSpecs, QueenCore disposes: tier and budget are decided
 * here (via the tier mapper and ledger), never by the caller.
 */
export class QueenCore {
  readonly ledger: BudgetLedger;
  readonly registry = new WorkerRegistry();
  readonly cache = new ResultCache();
  readonly customers: CustomerProfile[];
  readonly tools: ToolInfo[];
  /** merged narration — the Queen's decisions and every bee's, for GET /events */
  readonly log = new HiveLog();

  private readonly tasks = new Map<string, TaskState>();
  private readonly cacheKeys = new Map<string, string>();
  private readonly waiters = new Map<string, Array<(r: TaskResult) => void>>();
  private readonly eventCbs: Array<(ev: TaskEvent) => void> = [];
  private readonly statusSections = new Map<string, () => unknown>();
  /** agentIds we have ever had a hello from, so an unknown heartbeat can be answered with a rollcall */
  private readonly known = new Set<string>();
  /** when we last asked each unknown agent to introduce itself; see rollcall() */
  private readonly lastAsked = new Map<string, number>();
  private plannerCostUsd = 0;

  private constructor(
    private readonly bus: Bus,
    private readonly estimator: CostEstimator,
    root: string,
  ) {
    this.ledger = new BudgetLedger(join(root, "data", "ledger.json"));
    this.customers = loadCustomers(join(root, "customers"));
    this.tools = this.customers.flatMap((c) => c.tools ?? []);
    for (const c of this.customers) {
      this.ledger.addCustomer(c.customerId, c.budget.capUsd);
      for (const s of c.seats ?? []) this.ledger.addSeat(s.seatId, s.windowSeconds, s.tokensPerWindow);
    }
    // Prune customers/seats left in a persisted ledger.json by profiles that no
    // longer exist, so a removed customer doesn't reappear in /status.
    this.ledger.reconcile(
      this.customers.map((c) => c.customerId),
      this.customers.flatMap((c) => (c.seats ?? []).map((s) => s.seatId)),
    );
  }

  /**
   * @param bus test seam — inject a fake to drive the consumers directly. Same
   * shape as the `OrchestratorCore` interface the planner tests use: the point is
   * to exercise the real dispatch and ledger logic without a broker.
   */
  static async create(root: string, injectedBus?: Bus): Promise<QueenCore> {
    const bus = injectedBus ?? (await connectBus());
    const estimator = new CostEstimator(loadCatalog(join(root, "llm_model_api_catalog.yaml")));
    const core = new QueenCore(bus, estimator, root);
    await core.wireConsumers();
    // Only now, with the control consumer actually subscribed, is it safe to ask.
    // The ordering is the entire point: this is the race the worker's six-hello
    // burst was trying to out-shout.
    core.rollcall();
    core.startReaper();
    console.log(`[queen] customers: ${core.customers.map((c) => c.customerId).join(", ") || "(none)"}`);
    return core;
  }

  customer(customerId: string): CustomerProfile | undefined {
    return this.customers.find((c) => c.customerId === customerId);
  }

  /** Returns an unsubscribe function. The orchestrator relies on it: a chat turn watches only its own task ids and must let go when the turn ends. */
  onTaskEvent(cb: (ev: TaskEvent) => void): () => void {
    this.eventCbs.push(cb);
    return () => {
      const i = this.eventCbs.indexOf(cb);
      if (i >= 0) this.eventCbs.splice(i, 1);
    };
  }

  private emit(ev: TaskEvent): void {
    for (const cb of this.eventCbs) cb(ev);
  }

  /**
   * Say something once, to both audiences.
   *
   * The Queen's routing lines are the most interesting in the hive — they are
   * where a cost decision becomes visible — and they were reaching only whoever
   * ran the process. This keeps the terminal output identical and adds the same
   * line to the feed the console reads, rather than maintaining two sets of
   * near-identical statements that drift apart.
   */
  private say(level: LogLevel, text: string, taskId?: string): void {
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[queen] ${text}`);
    this.log.push({ at: Date.now(), level, source: "queen", text, taskId });
  }

  /** The single entry point into the hive. Returns immediately after dispatch. */
  submitTask(rawSpec: TaskSpec): SubmitOutcome {
    // Ground confidentiality on the structured path too, the same one-way rule
    // the planner applies: the wording of the request ("summarize my inbox")
    // can only ADD confidentiality, never clear a caller's explicit label.
    const spec: TaskSpec =
      rawSpec.sensitivity !== "confidential" && userImpliedConfidential(`${rawSpec.title} ${rawSpec.input}`)
        ? { ...rawSpec, sensitivity: "confidential" }
        : rawSpec;
    const key = ResultCache.key(spec.customerId, spec.title, spec.input, spec.artifacts);
    const hit = this.cache.get(key);
    if (hit) {
      // The task id, not the title: titles are the user's own words, and the
      // feed is the one surface where a line about a confidential request could
      // outlive the request itself.
      this.say("info", `${hit.taskId} served from cache, zero tokens`, hit.taskId);
      return { taskId: hit.taskId, status: "done", difficulty: "simple", reason: "cache hit", cached: true, result: hit };
    }
    const taskId = randomUUID().slice(0, 8);
    this.cacheKeys.set(taskId, key);
    const difficulty = scoreDifficulty(spec);
    this.emit({ kind: "created", taskId, difficulty });
    this.dispatch(taskId, spec, difficulty);
    const state = this.tasks.get(taskId)!;
    return { taskId, status: state.status, difficulty, reason: state.reason };
  }

  /** Resolves when the task reaches a terminal state (done or failed). */
  awaitResult(taskId: string): Promise<TaskResult> {
    const state = this.tasks.get(taskId);
    if (state?.result && (state.status === "done" || state.status === "failed")) {
      return Promise.resolve(state.result);
    }
    return new Promise((resolve) => {
      const list = this.waiters.get(taskId) ?? [];
      list.push(resolve);
      this.waiters.set(taskId, list);
    });
  }

  getTask(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId);
  }

  /** planner meters its own model spend here so the brain is never a hidden cost center */
  recordPlannerCost(usd: number): void {
    this.plannerCostUsd += usd;
  }

  estimatePlannerCost(modelId: string, inputTokens: number, outputTokens: number): number {
    return this.estimator.estimate(modelId, inputTokens, outputTokens);
  }

  /**
   * Let a component outside the core contribute a read-only section to /status
   * without the core having to know what it is. The planner uses this to
   * publish its memory, which keeps the two halves separate: memory belongs to
   * the brain, and the authority stays unaware of it.
   */
  registerStatusSection(name: string, fn: () => unknown): void {
    this.statusSections.set(name, fn);
  }

  status() {
    const extra: Record<string, unknown> = {};
    for (const [name, fn] of this.statusSections) {
      try {
        extra[name] = fn();
      } catch {
        /* a contributed section must never break /status */
      }
    }
    return {
      workers: this.registry.snapshot(),
      budget: this.ledger.snapshot(),
      plannerCostUsd: this.plannerCostUsd,
      tasks: [...this.tasks.values()].map(({ result, ...t }) => ({ ...t, tierUsed: result?.tierUsed })),
      ...extra,
    };
  }

  /** reference price for the dispatch envelope: sonnet rates on rough tokens */
  private estimateUsd(spec: TaskSpec): number {
    const inTok = CostEstimator.roughTokens(spec.title + spec.input) + 1000;
    const est = this.estimator.estimate("claude-sonnet-4-6", inTok, 2000);
    return Math.max(0.05, est * 2);
  }

  private dispatch(taskId: string, spec: TaskSpec, difficulty: Difficulty, escalation?: TaskMessage["escalation"]) {
    const state =
      this.tasks.get(taskId) ??
      ({ taskId, spec, difficulty, status: "dispatched", attempts: 0, deferrals: 0, reason: "", startedAt: Date.now() } as TaskState);
    // attempts counts EXECUTIONS tried, which is what MAX_ATTEMPTS is about.
    // It used to be incremented on every entry to this method — including the
    // deferral retry below, which re-enters it — so two waits for a seat window
    // left attempts at 3 and the first real failure died permanently without ever
    // escalating. Waiting is not trying.
    state.attempts += 1;
    state.difficulty = difficulty;
    state.dispatchedAt = Date.now();
    state.lastProgressAt = undefined;
    state.runningOn = undefined;
    this.tasks.set(taskId, state);

    // 1. tier-4 tool match beats any LLM
    const tool = escalation ? undefined : matchTool(spec, this.tools);
    if (tool) {
      const msg: TaskMessage = {
        kind: "task",
        taskId,
        attempt: state.attempts,
        spec,
        envelope: { maxUsd: 0, tier: 4, allowEscalation: true, urgency: spec.urgency, degraded: false },
        difficulty,
        matchedToolId: tool.toolId,
      };
      this.bus.publish(EXCHANGES.tasks, tierQueueKey(4, tool.toolId), msg);
      state.status = "dispatched";
      state.reason = `tool match: ${tool.toolId}`;
      this.say("info", `${taskId} -> tier 4 tool ${tool.toolId}`, taskId);
      this.emit({ kind: "dispatched", taskId, reason: state.reason, tier: 4, degraded: false });
      return;
    }

    // 2. cheapest adequate capability among live workers
    const decision = decide(
      spec,
      difficulty,
      this.registry.liveCapabilities(),
      this.ledger,
      this.estimateUsd(spec),
      resolvePolicy(this.customer(spec.customerId)),
    );
    if (decision.action === "defer") {
      state.status = "deferred";
      state.reason = decision.reason;
      // Undo the increment above: this dispatch never reached a bee, so it is a
      // wait, not an attempt. Counted separately so a long quota window cannot
      // silently consume the task's escalation budget.
      state.attempts -= 1;
      state.deferrals += 1;
      // warn, not info: a deferral is the case that looks like nothing happening,
      // so it must survive a threshold set to hide routine traffic.
      this.say("warn", `${taskId} deferred: ${decision.reason}`, taskId);
      this.emit({ kind: "deferred", taskId, reason: decision.reason });
      setTimeout(() => {
        const t = this.tasks.get(taskId);
        if (t && t.status === "deferred") this.dispatch(taskId, spec, difficulty, escalation);
      }, (decision.retryInSeconds ?? 60) * 1000).unref();
      return;
    }

    const msg: TaskMessage = {
      kind: "task",
      taskId,
      attempt: state.attempts,
      spec,
      envelope: {
        maxUsd: decision.maxUsd,
        tier: decision.tier,
        allowEscalation: !escalation,
        urgency: spec.urgency,
        degraded: decision.degraded,
      },
      difficulty,
      escalation,
      capabilityHint: decision.capability,
    };
    const routeSkill = pickRouteSkill(spec.skills, decision.capability?.skills ?? []);
    const key = spec.pinnedAgentId ? directQueueKey(spec.pinnedAgentId) : tierQueueKey(decision.tier, routeSkill);
    this.bus.publish(EXCHANGES.tasks, key, msg);
    state.status = "dispatched";
    state.reason = decision.reason;
    this.say(
      decision.degraded ? "warn" : "info",
      `${taskId} -> ${key} (${decision.reason}${decision.degraded ? ", DEGRADED" : ""})`,
      taskId,
    );
    this.emit({ kind: "dispatched", taskId, reason: decision.reason, tier: decision.tier, degraded: decision.degraded });
  }

  /**
   * Redispatch tasks nobody is working on. **Lightweight mode only.**
   *
   * The gating is not "amqp is fine, skip it" — it is that redispatching would be
   * *wrong* there. On RabbitMQ an undelivered message is still sitting in a
   * durable queue and will be handed to the next consumer that appears, so a
   * redispatch would enqueue a second copy of work the broker is still holding,
   * on two different processes that no worker-local dedup can reconcile. On the
   * embedded broker the message is simply gone, and silence is the only evidence
   * there will ever be.
   *
   * The signal is the progress tick a bee sends for every task it holds. No tick
   * at all means the dispatch never landed; ticks that stop mean the bee died
   * mid-task. Both are the same remedy — try again, on the Queen's budget, bounded
   * by MAX_ATTEMPTS — which is the whole reason retry belongs here rather than in
   * the transport: only the Queen knows what another attempt costs.
   *
   * One interval for the whole hive rather than a timer per task: a timer per task
   * is a leak waiting to happen, and this has to survive a task being retried.
   */
  private startReaper(): void {
    if (process.env.HIVE_BROKER !== "mqtt") return;
    setInterval(() => this.reapOnce(), REAPER_INTERVAL_MS).unref();
  }

  /** Exposed for tests, which drive it directly instead of waiting on the interval. */
  reapOnce(now = Date.now()): void {
    for (const state of this.tasks.values()) {
      if (state.status !== "dispatched" || state.dispatchedAt === undefined) continue;

      const silentFor = now - (state.lastProgressAt ?? state.dispatchedAt);
      const deadline = state.lastProgressAt === undefined ? ACCEPT_TIMEOUT_MS : STALL_TIMEOUT_MS;
      if (silentFor < deadline) continue;

      const why =
        state.lastProgressAt === undefined
          ? `no bee took it within ${Math.round(ACCEPT_TIMEOUT_MS / 1000)}s`
          : `bee ${state.runningOn?.agentId ?? "?"} went silent for ${Math.round(silentFor / 1000)}s`;

      if (state.attempts >= MAX_ATTEMPTS) {
        const result: TaskResult = {
          kind: "task.result",
          taskId: state.taskId,
          attempt: state.attempts,
          agentId: state.runningOn?.agentId ?? "none",
          customerId: state.spec.customerId,
          ok: false,
          output: "",
          error: `abandoned: ${why}, after ${state.attempts} attempts`,
          tierUsed: 4,
          runtime: "none",
          billing: "free",
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          degraded: false,
          durationMs: now - state.startedAt,
        };
        state.status = "failed";
        state.result = result;
        this.say("error", `${state.taskId} abandoned: ${why}`, state.taskId);
        this.emit({ kind: "failed", taskId: state.taskId, result });
        this.settle(state.taskId, result);
        continue;
      }

      this.say("warn", `${state.taskId} redispatching: ${why}`, state.taskId);
      this.dispatch(state.taskId, state.spec, state.difficulty);
    }
  }

  private settle(taskId: string, result: TaskResult): void {
    const list = this.waiters.get(taskId);
    if (list) {
      this.waiters.delete(taskId);
      for (const resolve of list) resolve(result);
    }
  }

  /**
   * Ask the hive — or one bee — to introduce itself.
   *
   * Rate-limited per agent, because the trigger is someone else's message rate.
   * A bee that heartbeats but never answers — running older code, or an orphan
   * whose client flushed a backlog of queued heartbeats on reconnect — would
   * otherwise draw one rollcall per heartbeat, turning their flood into ours.
   * Asking a silent bee more than once a minute buys nothing anyway.
   */
  private rollcall(agentId?: string): void {
    if (agentId) {
      const last = this.lastAsked.get(agentId) ?? 0;
      if (Date.now() - last < ROLLCALL_MIN_INTERVAL_MS) return;
      this.lastAsked.set(agentId, Date.now());
    }
    this.bus.publish(
      EXCHANGES.control,
      agentId ? `queen.rollcall.${agentId}` : "queen.rollcall",
      { kind: "queen.rollcall", agentId, at: Date.now() },
    );
  }

  private async wireConsumers(): Promise<void> {
    const bus = this.bus;

    await bus.consume(EXCHANGES.control, "queen.hello", ["agent.hello"], AgentHello, async (msg) => {
      this.known.add(msg.agentId);
      const news = this.registry.hello(msg);
      this.say(
        news ? "info" : "debug",
        news
          ? `${msg.agentId} registered (${msg.capabilities.length} capabilit${msg.capabilities.length === 1 ? "y" : "ies"})`
          : `hello from ${msg.agentId}, unchanged`,
      );
    });
    await bus.consume(EXCHANGES.control, "queen.heartbeat", ["agent.heartbeat"], AgentHeartbeat, async (msg) => {
      // A heartbeat from a bee we have never met means its hello was lost — which
      // used to be terminal, because `registry.heartbeat` ignores an unknown
      // agentId and nothing ever asked again. The bee sat there consuming its
      // queues, invisible to routing, until someone restarted it. Ask.
      if (!this.known.has(msg.agentId)) {
        this.say("debug", `heartbeat from unregistered ${msg.agentId}, asking it to introduce itself`);
        this.rollcall(msg.agentId);
        return;
      }
      this.registry.heartbeat(msg.agentId);
    });
    await bus.consume(EXCHANGES.control, "queen.budget", ["budget.request.#"], BudgetRequest, async (msg) => {
      const lease = this.ledger.grantLease(Math.min(5, this.ledger.usdRemaining(msg.customerId)), 100_000, 3600);
      bus.publish(EXCHANGES.control, `budget.grant.${msg.agentId}`, { kind: "budget.grant", agentId: msg.agentId, ...lease });
      this.say("info", `lease ${lease.leaseId} -> ${msg.agentId} ($${lease.usdAllowance})`);
    });

    // Ephemeral by design (durable: false). These two carry "what is happening
    // right now"; replaying a backlog of them after a Queen restart would fill
    // the console's feed with a hive state that no longer exists.
    await bus.consume(
      EXCHANGES.telemetry,
      "queen.agentlog",
      ["agent.log.#"],
      AgentLog,
      async (msg) => {
        this.log.push({ at: msg.at, level: msg.level, source: msg.agentId, text: msg.text, taskId: msg.taskId });
      },
      { durable: false, prefetch: 32 },
    );

    await bus.consume(
      EXCHANGES.telemetry,
      "queen.progress",
      ["task.progress.#"],
      TaskProgress,
      async (msg) => {
        const state = this.tasks.get(msg.taskId);
        // A tick for a task we don't know about is not an error worth recording:
        // it is what a restarted Queen hears from a bee still finishing the work
        // the previous process dispatched. Ignore it rather than invent state.
        if (!state) return;
        state.lastProgressAt = msg.at;
        state.runningOn = {
          agentId: msg.agentId,
          tier: msg.tier,
          agent: msg.agent,
          runtime: msg.runtime,
          model: msg.model,
        };
        this.emit({ kind: "progress", taskId: msg.taskId, progress: msg });
      },
      { durable: false, prefetch: 32 },
    );

    await bus.consume(EXCHANGES.telemetry, "queen.results", ["task.result.#"], TaskResult, async (result) => {
      // Everything below spends money, so the guards come first.
      //
      // The ledger writes used to sit above even the task lookup, which meant a
      // duplicate or replayed result double-charged the customer's budget and
      // double-burned seat quota — for a taskId the Queen had never heard of, at
      // that. Whatever the transport does, the books are written exactly once per
      // (taskId, attempt).
      const state = this.tasks.get(result.taskId);
      if (!state) {
        this.say("debug", `${result.taskId} result for an unknown task, ignoring`, result.taskId);
        return;
      }
      if (state.status === "done" || state.status === "failed") {
        this.say("debug", `${result.taskId} result after it was already ${state.status}, ignoring`, result.taskId);
        return;
      }
      // A superseded attempt landing late is expected, not an error: the Queen
      // redispatched, and the old bee finished anyway. Without the attempt number
      // a late `ok: false` would re-escalate a task that has already succeeded.
      if (result.attempt !== state.attempts) {
        this.say(
          "debug",
          `${result.taskId} result from attempt ${result.attempt}, current is ${state.attempts}, ignoring`,
          result.taskId,
        );
        return;
      }

      if (result.usage.costUsd > 0) this.ledger.recordSpend(result.customerId, result.usage.costUsd);
      if (result.billing === "subscription" && result.seatId) {
        this.ledger.recordQuotaUse(result.seatId, result.usage.inputTokens + result.usage.outputTokens);
      }

      if (result.ok) {
        state.status = "done";
        state.result = result;
        const key = this.cacheKeys.get(result.taskId);
        if (key) this.cache.put(key, result);
        this.say(
          "info",
          `${result.taskId} done by ${result.agentId} in ${(result.durationMs / 1000).toFixed(1)}s ` +
            `(tier ${result.tierUsed}, $${result.usage.costUsd.toFixed(4)})`,
          result.taskId,
        );
        this.emit({ kind: "done", taskId: result.taskId, result });
        this.settle(result.taskId, result);
        return;
      }

      if (state.attempts < MAX_ATTEMPTS) {
        const failureSummary =
          `Attempt ${state.attempts} at tier ${result.tierUsed} (${result.runtime}) failed: ` +
          `${(result.error ?? "unknown").slice(0, 300)}. Output head: ${result.output.slice(0, 200)}`;
        const next = ESCALATE[state.difficulty];
        this.say(
          "warn",
          `${result.taskId} failed at tier ${result.tierUsed}, escalating (${state.difficulty} -> ${next})`,
          result.taskId,
        );
        this.dispatch(result.taskId, state.spec, next, { fromTier: result.tierUsed, attempt: state.attempts, failureSummary });
      } else {
        state.status = "failed";
        state.result = result;
        this.say("error", `${result.taskId} failed permanently after ${state.attempts} attempts`, result.taskId);
        this.emit({ kind: "failed", taskId: result.taskId, result });
        this.settle(result.taskId, result);
      }
    });

    await bus.consume(EXCHANGES.telemetry, "queen.usage", ["telemetry.usage.#"], UsageReport, async (msg) => {
      this.say("debug", `usage ${msg.agentId}: ${msg.tasksCompleted} tasks, $${msg.costUsd.toFixed(4)}`);
    });
  }
}
