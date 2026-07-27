import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import {
  AgentHeartbeat,
  AgentHello,
  BudgetRequest,
  connectBus,
  CostEstimator,
  directQueueKey,
  EXCHANGES,
  loadCatalog,
  TaskMessage,
  TaskResult,
  TaskSpec,
  tierQueueKey,
  UsageReport,
  type Bus,
  type Difficulty,
} from "@hive/shared";
import { matchTool, scoreDifficulty, userImpliedConfidential, type ToolInfo } from "./analyzer.js";
import { BudgetLedger } from "./budget.js";
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
  attempts: number;
  reason: string;
  result?: TaskResult;
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
  | { kind: "done"; taskId: string; result: TaskResult }
  | { kind: "failed"; taskId: string; result: TaskResult };

const MAX_ATTEMPTS = 3;
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

  private readonly tasks = new Map<string, TaskState>();
  private readonly cacheKeys = new Map<string, string>();
  private readonly waiters = new Map<string, Array<(r: TaskResult) => void>>();
  private readonly eventCbs: Array<(ev: TaskEvent) => void> = [];
  private readonly statusSections = new Map<string, () => unknown>();
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

  static async create(root: string): Promise<QueenCore> {
    const bus = await connectBus();
    const estimator = new CostEstimator(loadCatalog(join(root, "llm_model_api_catalog.yaml")));
    const core = new QueenCore(bus, estimator, root);
    await core.wireConsumers();
    console.log(`[queen] customers: ${core.customers.map((c) => c.customerId).join(", ") || "(none)"}`);
    return core;
  }

  customer(customerId: string): CustomerProfile | undefined {
    return this.customers.find((c) => c.customerId === customerId);
  }

  onTaskEvent(cb: (ev: TaskEvent) => void): void {
    this.eventCbs.push(cb);
  }

  private emit(ev: TaskEvent): void {
    for (const cb of this.eventCbs) cb(ev);
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
      console.log(`[queen] cache hit for "${spec.title}"`);
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
      ({ taskId, spec, difficulty, status: "dispatched", attempts: 0, reason: "" } as TaskState);
    state.attempts += 1;
    state.difficulty = difficulty;
    this.tasks.set(taskId, state);

    // 1. tier-4 tool match beats any LLM
    const tool = escalation ? undefined : matchTool(spec, this.tools);
    if (tool) {
      const msg: TaskMessage = {
        kind: "task",
        taskId,
        spec,
        envelope: { maxUsd: 0, tier: 4, allowEscalation: true, urgency: spec.urgency, degraded: false },
        difficulty,
        matchedToolId: tool.toolId,
      };
      this.bus.publish(EXCHANGES.tasks, tierQueueKey(4, tool.toolId), msg);
      state.status = "dispatched";
      state.reason = `tool match: ${tool.toolId}`;
      console.log(`[queen] ${taskId} -> tier 4 tool ${tool.toolId}`);
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
      console.log(`[queen] ${taskId} deferred: ${decision.reason}`);
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
    console.log(`[queen] ${taskId} -> ${key} (${decision.reason}${decision.degraded ? ", DEGRADED" : ""})`);
    this.emit({ kind: "dispatched", taskId, reason: decision.reason, tier: decision.tier, degraded: decision.degraded });
  }

  private settle(taskId: string, result: TaskResult): void {
    const list = this.waiters.get(taskId);
    if (list) {
      this.waiters.delete(taskId);
      for (const resolve of list) resolve(result);
    }
  }

  private async wireConsumers(): Promise<void> {
    const bus = this.bus;

    await bus.consume(EXCHANGES.control, "queen.hello", ["agent.hello"], AgentHello, async (msg) => {
      this.registry.hello(msg);
      console.log(`[queen] hello from ${msg.agentId} (${msg.capabilities.length} capabilities)`);
    });
    await bus.consume(EXCHANGES.control, "queen.heartbeat", ["agent.heartbeat"], AgentHeartbeat, async (msg) => {
      this.registry.heartbeat(msg.agentId);
    });
    await bus.consume(EXCHANGES.control, "queen.budget", ["budget.request.#"], BudgetRequest, async (msg) => {
      const lease = this.ledger.grantLease(Math.min(5, this.ledger.usdRemaining(msg.customerId)), 100_000, 3600);
      bus.publish(EXCHANGES.control, `budget.grant.${msg.agentId}`, { kind: "budget.grant", agentId: msg.agentId, ...lease });
      console.log(`[queen] lease ${lease.leaseId} -> ${msg.agentId} ($${lease.usdAllowance})`);
    });

    await bus.consume(EXCHANGES.telemetry, "queen.results", ["task.result.#"], TaskResult, async (result) => {
      if (result.usage.costUsd > 0) this.ledger.recordSpend(result.customerId, result.usage.costUsd);
      if (result.billing === "subscription" && result.seatId) {
        this.ledger.recordQuotaUse(result.seatId, result.usage.inputTokens + result.usage.outputTokens);
      }
      const state = this.tasks.get(result.taskId);
      if (!state) return;

      if (result.ok) {
        state.status = "done";
        state.result = result;
        const key = this.cacheKeys.get(result.taskId);
        if (key) this.cache.put(key, result);
        console.log(`[queen] ${result.taskId} done by ${result.agentId} (tier ${result.tierUsed}, $${result.usage.costUsd.toFixed(4)})`);
        this.emit({ kind: "done", taskId: result.taskId, result });
        this.settle(result.taskId, result);
        return;
      }

      if (state.attempts < MAX_ATTEMPTS) {
        const failureSummary =
          `Attempt ${state.attempts} at tier ${result.tierUsed} (${result.runtime}) failed: ` +
          `${(result.error ?? "unknown").slice(0, 300)}. Output head: ${result.output.slice(0, 200)}`;
        const next = ESCALATE[state.difficulty];
        console.log(`[queen] ${result.taskId} failed at tier ${result.tierUsed}, escalating (${state.difficulty} -> ${next})`);
        this.dispatch(result.taskId, state.spec, next, { fromTier: result.tierUsed, attempt: state.attempts, failureSummary });
      } else {
        state.status = "failed";
        state.result = result;
        console.log(`[queen] ${result.taskId} failed permanently after ${state.attempts} attempts`);
        this.emit({ kind: "failed", taskId: result.taskId, result });
        this.settle(result.taskId, result);
      }
    });

    await bus.consume(EXCHANGES.telemetry, "queen.usage", ["telemetry.usage.#"], UsageReport, async (msg) => {
      console.log(`[queen] usage ${msg.agentId}: ${msg.tasksCompleted} tasks, $${msg.costUsd.toFixed(4)}`);
    });
  }
}
