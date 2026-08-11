import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import {
  AgentGoodbye,
  AgentHeartbeat,
  AgentHello,
  AgentLog,
  allowedByConfidentiality,
  ArtifactStore,
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
  type Passthrough,
  type Sensitivity,
} from "@hive/shared";
import { matchTool, scoreDifficulty, userImpliedConfidential, type ToolInfo } from "./analyzer.js";
import { BudgetLedger } from "./budget.js";
import {
  EpisodeLog,
  TaskEpisodeLog,
  resolveEpisodeMode,
  loopShapeOf,
  modeAllows,
  toEpisodeAttempt,
  toTaskMetadata,
  type EpisodeAttempt,
  type EpisodeMode,
  type TaskEpisode,
} from "./episode.js";
import { importLegacyJsonl } from "./episodeImport.js";
import { HiveLog } from "./hiveLog.js";
import { decide, DEFAULT_ROUTE_POLICY, type CapabilityRequirement, type RoutePolicy } from "./tierMapper.js";
import { WorkerRegistry } from "./registry.js";
import { ResultCache } from "./resultCache.js";
import { InMemoryJobStore, type CallerContext, type JobStore, type TaskState } from "./store.js";

export type { TaskState };

export interface CustomerProfile {
  customerId: string;
  name?: string;
  budget: { capUsd: number };
  seats?: Array<{ seatId: string; windowSeconds: number; tokensPerWindow: number }>;
  tools?: ToolInfo[];
  plannerModel?: string;
  /**
   * Routing and recording preferences. Absent or malformed falls back to the safe
   * default in every field — a customer profile is hand-edited yaml, so a typo
   * must degrade rather than throw or silently pick the expensive option.
   */
  policy?: RoutePolicy & { recordEpisodes?: EpisodeMode };
}

/** Coerce a customer's raw policy to a valid RoutePolicy, defaulting unknown values safely. */
function resolvePolicy(profile?: CustomerProfile): RoutePolicy {
  const raw = profile?.policy;
  return {
    onBudgetBlock: raw?.onBudgetBlock === "degrade" ? "degrade" : DEFAULT_ROUTE_POLICY.onBudgetBlock,
    // Anything but the exact opt-in stays cost-first. Completion-first spends
    // more per first attempt, so it may only ever be reached deliberately.
    routing: raw?.routing === "completion-first" ? "completion-first" : "cost-first",
  };
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

export interface SubmitOutcome {
  taskId: string;
  status: TaskState["status"];
  difficulty: Difficulty;
  reason: string;
  cached?: boolean;
  result?: TaskResult;
  /**
   * The sensitivity the task actually ran at, after grounding — which is not
   * always the one the caller submitted, since the wording of a request can add
   * confidentiality the caller did not label.
   *
   * Reported because a caller building a DAG has to know: an upgrade the core
   * applied silently is one the caller cannot propagate to the steps that
   * consume this task's output, and confidentiality that stops at the first hop
   * is not confidentiality.
   */
  sensitivity: Sensitivity;
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
 * How many times a task may wait before the hive stops believing the wait will
 * end. Generous on purpose — a five-hour quota window retried every 60s is ~300
 * — because this is a backstop against a wait that can never clear, not a
 * latency budget. Deferring is the right answer to an empty seat; deferring
 * forever is how a caller's `awaitResult` hangs with nothing to show for it.
 */
const MAX_DEFERRALS = Number(process.env.HIVE_MAX_DEFERRALS ?? 400);
/**
 * How long a dispatched task may go without a single progress tick before the
 * Queen concludes the message never landed. Comfortably over the bee's tick
 * interval, since the bee ticks once immediately on receipt.
 */
const ACCEPT_TIMEOUT_MS = Number(process.env.HIVE_ACCEPT_TIMEOUT_MS ?? 15_000);
/** How long a bee that WAS ticking may go silent before it is presumed dead. */
const STALL_TIMEOUT_MS = Number(process.env.HIVE_STALL_TIMEOUT_MS ?? 30_000);
const REAPER_INTERVAL_MS = 5_000;
/** How often finished work is swept out of the job store. Cheap, so it can be lazy. */
const EVICT_INTERVAL_MS = 60_000;
/** Least time between two rollcalls aimed at the same unregistered bee. */
const ROLLCALL_MIN_INTERVAL_MS = 60_000;
/**
 * How long the Queen waits for the fleet to drain before giving up on stragglers.
 * Above a bee's own drain cap, so the usual case is that everyone reports in and
 * the Queen never has to guess.
 */
const SHUTDOWN_GRACE_MS = Number(process.env.HIVE_SHUTDOWN_WAIT_MS ?? 75_000);
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
  /** merged narration — the Queen's decisions and every bee's, for GET /events */
  readonly log = new HiveLog();

  /**
   * Task state and result-cache keys live behind `JobStore` (see store.ts).
   *
   * The three maps below deliberately do NOT. They hold live in-process handles,
   * not data: `waiters` holds promise resolvers a chat turn is blocked on,
   * `eventCbs` holds the SSE callbacks of currently-open connections, and
   * `statusSections` holds closures contributed by other components. None of
   * them can be serialized into any store, so moving them would be a lie about
   * what the boundary buys. A second Queen process needs a messaging change
   * (a reply-to, or a resumable turn), not a storage one.
   */
  private readonly waiters = new Map<string, Array<(r: TaskResult) => void>>();
  private readonly eventCbs: Array<(ev: TaskEvent) => void> = [];
  private readonly statusSections = new Map<string, () => unknown>();
  /** agentIds we have ever had a hello from, so an unknown heartbeat can be answered with a rollcall */
  private readonly known = new Set<string>();
  /** when we last asked each unknown agent to introduce itself; see rollcall() */
  private readonly lastAsked = new Map<string, number>();
  /** bees that said goodbye, so a shutdown can tell "stopped as asked" from "vanished" */
  private readonly farewells = new Map<string, AgentGoodbye>();
  private plannerCostUsd = 0;

  /**
   * Where a failed attempt's output is parked so the retry can read it.
   *
   * Rooted at `<root>/artifacts` to match what the worker reads
   * (`packages/worker/src/index.ts`) — the default `ArtifactStore()` resolves
   * against cwd, which is the same directory only by luck, and a ref the bee
   * cannot resolve would silently turn the retry's evidence back into nothing.
   */
  private readonly artifacts: ArtifactStore;
  /** the turn-level training record; see episode.ts */
  readonly episodes: EpisodeLog;
  /**
   * The task-level training record.
   *
   * Written from `settle()` rather than by a caller, so every intake path — the
   * planner, `POST /tasks`, `/v1/chat/completions` — contributes without
   * knowing it exists. Only the planner ever wrote an episode, which meant the
   * stateless surface the hive is moving toward produced no corpus at all.
   */
  readonly taskEpisodes: TaskEpisodeLog;

  private constructor(
    private readonly bus: Bus,
    private readonly estimator: CostEstimator,
    root: string,
    private readonly store: JobStore,
  ) {
    this.ledger = new BudgetLedger(join(root, "data", "ledger.json"));
    this.artifacts = new ArtifactStore(join(root, "artifacts"));
    this.episodes = new EpisodeLog(root);
    this.taskEpisodes = new TaskEpisodeLog(root);
    this.customers = loadCustomers(join(root, "customers"));
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
   * @param injectedBus test seam — inject a fake to drive the consumers directly.
   * Same shape as the `OrchestratorCore` interface the planner tests use: the
   * point is to exercise the real dispatch and ledger logic without a broker.
   * @param store where job state lives; defaults to the in-memory one, so no
   * existing call site changes.
   */
  static async create(root: string, injectedBus?: Bus, store: JobStore = new InMemoryJobStore()): Promise<QueenCore> {
    const bus = injectedBus ?? (await connectBus());
    const estimator = new CostEstimator(loadCatalog(join(root, "llm_model_api_catalog.yaml")));
    const core = new QueenCore(bus, estimator, root, store);
    // Before anything can be recorded, so a hive upgraded from the JSONL corpus
    // starts with its history rather than beside it. No-op once done, and the
    // source files are left alone.
    importLegacyJsonl(root, (msg) => console.log(`[queen] ${msg}`));
    await core.wireConsumers();
    // Only now, with the control consumer actually subscribed, is it safe to ask.
    // The ordering is the entire point: this is the race the worker's six-hello
    // burst was trying to out-shout.
    core.rollcall();
    core.startReaper();
    core.startEviction();
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

  /**
   * The single entry point into the hive. Returns immediately after dispatch.
   *
   * `require` is how a caller names the capability it wants instead of letting
   * the router choose the cheapest adequate one. It is deliberately a parameter
   * rather than a field on `TaskSpec`: the spec is what the planner produces,
   * and a planner that could name its own executor would be choosing tiers and
   * spending money, which is the one thing the split between planner and router
   * exists to prevent. Only a caller on the structured intake can set it.
   */
  submitTask(
    rawSpec: TaskSpec,
    require?: CapabilityRequirement,
    passthrough?: Passthrough,
    caller?: CallerContext,
  ): SubmitOutcome {
    // Ground confidentiality on the structured path too, the same one-way rule
    // the planner applies: the wording of the request ("summarize my inbox")
    // can only ADD confidentiality, never clear a caller's explicit label.
    const spec: TaskSpec =
      rawSpec.sensitivity !== "confidential" && userImpliedConfidential(`${rawSpec.title} ${rawSpec.input}`)
        ? { ...rawSpec, sensitivity: "confidential" }
        : rawSpec;
    // Keyed on the grounded spec, not the raw one: the confidentiality upgrade
    // above has to be part of the key, or the upgrade is undone by the lookup.
    const key = ResultCache.key(spec, require?.selector, passthrough);
    const hit = this.cache.get(key);
    if (hit) {
      // The task id, not the title: titles are the user's own words, and the
      // feed is the one surface where a line about a confidential request could
      // outlive the request itself.
      this.say("info", `${hit.taskId} served from cache, zero tokens`, hit.taskId);
      this.recordCacheHit(spec, hit, caller, passthrough);
      return {
        taskId: hit.taskId,
        status: "done",
        difficulty: "simple",
        reason: "cache hit",
        cached: true,
        result: hit,
        sensitivity: spec.sensitivity,
      };
    }
    const taskId = randomUUID().slice(0, 8);
    this.store.setCacheKey(taskId, key);
    const difficulty = scoreDifficulty(spec);
    this.emit({ kind: "created", taskId, difficulty });
    this.dispatch(taskId, spec, difficulty, undefined, require, passthrough);
    const state = this.store.get(taskId)!;
    // After dispatch, because dispatch is what creates the state. Attribution is
    // recording context, so it never has to be in hand before the work is routed.
    if (caller) {
      state.caller = caller;
      this.store.put(state);
    }
    return { taskId, status: state.status, difficulty, reason: state.reason, sensitivity: spec.sensitivity };
  }

  /** Resolves when the task reaches a terminal state (done or failed). */
  awaitResult(taskId: string): Promise<TaskResult> {
    const state = this.store.get(taskId);
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
    return this.store.get(taskId);
  }

  /** planner meters its own model spend here so the brain is never a hidden cost center */
  /**
   * Store a failed attempt's output for the retry to read, returning its ref.
   *
   * Best-effort by design: a task that failed once must not fail a second time
   * because the disk was full. No output means nothing to park — an empty
   * artifact would only tell the retry that its predecessor said nothing, which
   * the failure summary already says.
   */
  private parkFailedOutput(result: TaskResult): string | undefined {
    if (!result.output.trim()) return undefined;
    try {
      return this.artifacts.put(result.output, `${result.taskId}-attempt${result.attempt}.txt`);
    } catch (err) {
      this.say("warn", `could not park failed output of ${result.taskId}: ${String(err).slice(0, 120)}`, result.taskId);
      return undefined;
    }
  }

  /**
   * The tier-4 tools this customer has enabled.
   *
   * Scoped, where it used to be one flat list built from every profile the hive
   * had loaded. Both demo customers happen to declare the same two tools, so a
   * cross-customer match was invisible — but a tool is a *program*, declared per
   * customer precisely because it encodes that customer's data shapes, and
   * `matchTool` needs only a skill overlap and the right key names to route
   * somebody else's task straight into it. Now that an API key maps to a
   * customerId (`auth.ts`), that is a live path rather than a latent one.
   */
  toolsFor(customerId: string): ToolInfo[] {
    return this.customer(customerId)?.tools ?? [];
  }

  /** How much of a turn this customer has opted to have written down. */
  episodeMode(customerId: string): EpisodeMode {
    return resolveEpisodeMode(this.customer(customerId)?.policy?.recordEpisodes);
  }

  /** Which routing preference is in force, so an episode can record what produced its outcome. */
  routingPolicy(customerId: string): string {
    return resolvePolicy(this.customer(customerId)).routing ?? "cost-first";
  }

  /**
   * The attempt chain for a task, oldest first — the labelled part of an episode.
   *
   * Read from the job store rather than reconstructed by the caller: a chat turn
   * only ever sees the final TaskResult, so "failed at tier 3, then succeeded at
   * tier 1" is invisible from there, and that transition is precisely the row
   * worth training on.
   */
  attemptHistory(taskId: string): TaskResult[] {
    return this.store.get(taskId)?.history ?? [];
  }

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
      tasks: this.store.list().map(({ result, ...t }) => ({ ...t, tierUsed: result?.tierUsed })),
      ...extra,
    };
  }

  /**
   * Resolve `spec.continues` to the bee that still holds its session — or to
   * nothing, which is always a valid answer.
   *
   * Four conditions, and every one of them is a reason to run cold rather than a
   * reason to fail: the predecessor must be known, must have finished
   * successfully, must have reported a `sessionRef`, and its bee must still be
   * live. A follow-up that cannot be warmed is just a normal task.
   */
  private affinity(spec: TaskSpec): { agentId: string; sessionRef: string } | undefined {
    if (!spec.continues) return undefined;
    const previous = this.store.get(spec.continues);
    const result = previous?.result;
    if (!previous || previous.status !== "done" || !result?.ok || !result.sessionRef) return undefined;
    if (!this.registry.isLive(result.agentId)) return undefined;
    // The gate that makes this safe. A pin becomes a direct queue key below,
    // which bypasses the tier queues — and the tier queues are where
    // `allowedByConfidentiality` is enforced, via `decide`. So a confidential
    // task pinned to a subscription-billed bee would run on a cloud seat and
    // leave the machine, with the routing decision that forbade it still sitting
    // correctly in the log. Ask the same question `decide` asks, about the one
    // worker we are about to name.
    const allowed = this.registry
      .liveCapabilitiesOf(result.agentId)
      .some((cap) => allowedByConfidentiality(cap, spec.sensitivity));
    if (!allowed) {
      this.say(
        "warn",
        `${spec.continues} affinity refused: ${result.agentId} may not run ${spec.sensitivity} work, running cold`,
        spec.continues,
      );
      return undefined;
    }
    return { agentId: result.agentId, sessionRef: result.sessionRef };
  }

  /** reference price for the dispatch envelope: sonnet rates on rough tokens */
  private estimateUsd(spec: TaskSpec): number {
    const inTok = CostEstimator.roughTokens(spec.title + spec.input) + 1000;
    const est = this.estimator.estimate("claude-sonnet-4-6", inTok, 2000);
    return Math.max(0.05, est * 2);
  }

  private dispatch(
    taskId: string,
    spec: TaskSpec,
    difficulty: Difficulty,
    escalation?: TaskMessage["escalation"],
    require?: CapabilityRequirement,
    passthrough?: Passthrough,
  ) {
    const state =
      this.store.get(taskId) ??
      ({ taskId, spec, difficulty, status: "dispatched", attempts: 0, deferrals: 0, reason: "", startedAt: Date.now() } as TaskState);
    // Recorded on first dispatch and read back on every re-entry, so a defer
    // retry, a reaper redispatch and an escalation all stay inside the
    // constraint the caller set.
    if (require) state.requirement = require.selector;
    // Same reasoning as the requirement: a retry that dropped the caller's own
    // conversation would re-run the turn as a bare hive task and answer a
    // different question than the one that failed.
    if (passthrough) state.passthrough = passthrough;
    const turn = passthrough ?? state.passthrough;
    const requirement = require ?? (state.requirement ? { selector: state.requirement } : undefined);
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
    this.store.put(state);

    // 1. tier-4 tool match beats any LLM
    const tool = escalation ? undefined : matchTool(spec, this.toolsFor(spec.customerId));
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
      this.store.put(state);
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
      requirement,
    );
    if (decision.action === "refuse") {
      // Structural, not transient: no bee can serve this however long we wait,
      // so answering now beats a defer loop that would hold the caller's
      // `awaitResult` open forever. The reason names what is missing and the
      // remedy names what would fix it — both go to the caller, because the
      // person who can install a bee is usually the person who just asked.
      this.refuseTask(state, decision.reason, decision.remedy);
      return;
    }
    if (decision.action === "defer") {
      // A window that resets and a cap that frees up are worth waiting for; a
      // wait that never ends is not. Bounded so a defer cannot outlive the
      // caller — the one failure mode a deferral has that an attempt does not.
      if (state.deferrals >= MAX_DEFERRALS) {
        this.refuseTask(
          state,
          `gave up after waiting ${state.deferrals} times: ${decision.reason}`,
          "raise the customer's USD cap, add capacity, or retry when a seat window has reset",
        );
        return;
      }
      state.status = "deferred";
      state.reason = decision.reason;
      // Undo the increment above: this dispatch never reached a bee, so it is a
      // wait, not an attempt. Counted separately so a long quota window cannot
      // silently consume the task's escalation budget.
      state.attempts -= 1;
      state.deferrals += 1;
      this.store.put(state);
      // warn, not info: a deferral is the case that looks like nothing happening,
      // so it must survive a threshold set to hide routine traffic.
      this.say("warn", `${taskId} deferred: ${decision.reason}`, taskId);
      this.emit({ kind: "deferred", taskId, reason: decision.reason });
      setTimeout(() => {
        const t = this.store.get(taskId);
        if (t && t.status === "deferred") this.dispatch(taskId, spec, difficulty, escalation, requirement, turn);
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
      requirement: requirement?.selector,
      passthrough: turn,
    };

    // Affinity picks the bee; it never picks the budget. Everything above —
    // tier, cap, degraded flag — was already computed by `decide` against the
    // whole live fleet, and stays exactly as decided. All this changes is which
    // queue the message lands on, and whether the bee starts cold.
    const warm = escalation ? undefined : this.affinity(spec);
    if (warm) msg.resumeSession = warm.sessionRef;
    const pinned = warm?.agentId ?? spec.pinnedAgentId;

    const routeSkill = pickRouteSkill(spec.skills, decision.capability?.skills ?? []);
    // A pin — from affinity above, or from a caller with a site-bound task —
    // routes direct, which is the one path `decide`'s confidentiality filter
    // cannot see. `affinity` checks the target itself; a caller-supplied pin gets
    // the same check here, since the hole is in the mechanism rather than in
    // either caller.
    const pinAllowed =
      pinned === undefined ||
      pinned === warm?.agentId ||
      this.registry.liveCapabilitiesOf(pinned).some((cap) => allowedByConfidentiality(cap, spec.sensitivity));
    if (pinned !== undefined && !pinAllowed) {
      this.say(
        "warn",
        `${taskId} pin to ${pinned} refused: it may not run ${spec.sensitivity} work, routing by tier`,
        taskId,
      );
    }
    const key =
      pinned !== undefined && pinAllowed ? directQueueKey(pinned) : tierQueueKey(decision.tier, routeSkill);
    this.bus.publish(EXCHANGES.tasks, key, msg);
    state.status = "dispatched";
    state.reason = decision.reason;
    this.store.put(state);
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

  /**
   * Sweep finished work out of the job store.
   *
   * Its own interval rather than a ride along `reapOnce`, on purpose: the reaper
   * runs on the lightweight broker only, and its tests drive it with fabricated
   * future clocks. Retention must not inherit either property — a Queen on
   * RabbitMQ leaks just as fast as one on MQTT.
   */
  private startEviction(): void {
    const store = this.store;
    if (!(store instanceof InMemoryJobStore)) return;
    setInterval(() => {
      const dropped = store.evictOnce();
      if (dropped > 0) this.say("debug", `evicted ${dropped} finished task${dropped === 1 ? "" : "s"}`);
    }, EVICT_INTERVAL_MS).unref();
  }

  /** Exposed for tests, which drive it directly instead of waiting on the interval. */
  reapOnce(now = Date.now()): void {
    for (const state of this.store.dispatched()) {
      if (state.dispatchedAt === undefined) continue;

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
        this.store.put(state);
        this.say("error", `${state.taskId} abandoned: ${why}`, state.taskId);
        this.emit({ kind: "failed", taskId: state.taskId, result });
        this.settle(state.taskId, result);
        continue;
      }

      this.say("warn", `${state.taskId} redispatching: ${why}`, state.taskId);
      this.dispatch(state.taskId, state.spec, state.difficulty);
    }
  }

  /**
   * End a task the hive cannot run, now, with the reason it cannot.
   *
   * Deliberately shaped like the reaper's abandonment rather than like a bee's
   * failure: no bee was involved, so there is no agent, no tier and no usage to
   * report, and inventing any of the three would put a fiction in the ledger.
   * The `error` string is the whole product here — it is what the caller reads.
   */
  private refuseTask(state: TaskState, reason: string, remedy?: string): void {
    const result: TaskResult = {
      kind: "task.result",
      taskId: state.taskId,
      attempt: state.attempts,
      agentId: "none",
      customerId: state.spec.customerId,
      ok: false,
      output: "",
      error: remedy ? `${reason} — ${remedy}` : reason,
      tierUsed: 4,
      runtime: "none",
      billing: "free",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      degraded: false,
      durationMs: Date.now() - state.startedAt,
    };
    // This dispatch never reached a bee, so it was not an attempt — the same
    // correction a deferral makes, for the same reason.
    state.attempts = Math.max(0, state.attempts - 1);
    state.status = "failed";
    state.reason = reason;
    state.result = result;
    this.store.put(state);
    this.say("warn", `${state.taskId} refused: ${reason}`, state.taskId);
    this.emit({ kind: "failed", taskId: state.taskId, result });
    this.settle(state.taskId, result);
  }

  private settle(taskId: string, result: TaskResult): void {
    const list = this.waiters.get(taskId);
    if (list) {
      this.waiters.delete(taskId);
      for (const resolve of list) resolve(result);
    }
    // After the waiters, never before: a caller must not wait on bookkeeping.
    this.recordTaskEpisode(taskId, result);
  }

  /**
   * Write the settled task down, at whatever fidelity the customer allowed.
   *
   * Here rather than at the four terminal call sites for the same reason the
   * planner decides confidentiality in one place: a rule applied at four call
   * sites is a rule three of them will eventually forget.
   *
   * Best-effort throughout. A task that finished has finished; failing to record
   * it costs a training row, and there is no version of that trade where losing
   * the answer is better.
   */
  private recordTaskEpisode(taskId: string, result: TaskResult): void {
    const state = this.store.get(taskId);
    if (!state) return;
    // The refusal and reaper paths synthesize a result no bee produced, so it is
    // never in `history`. Falling back to it keeps "the hive gave up" in the
    // corpus, which is a label worth having.
    const history = state.history?.length ? state.history : [result];
    this.writeTaskEpisode(taskId, state.spec, {
      attempts: history.map(toEpisodeAttempt),
      ok: result.ok,
      wallMs: Date.now() - state.startedAt,
      output: result.output,
      caller: state.caller,
      passthrough: state.passthrough,
    });
  }

  /**
   * A shape that recurred, answered without running anything.
   *
   * `submitTask` returns straight out of the cache without creating a task, so
   * `settle` never fires and this occurrence would otherwise leave no trace —
   * which is backwards for anything reading the corpus to find repetition.
   */
  private recordCacheHit(
    spec: TaskSpec,
    hit: TaskResult,
    caller?: CallerContext,
    passthrough?: Passthrough,
  ): void {
    this.writeTaskEpisode(hit.taskId, spec, {
      attempts: [],
      ok: hit.ok,
      wallMs: 0,
      output: hit.output,
      cached: true,
      // The caller and conversation of THIS request, not of the one whose answer
      // is being reused: the recurrence being recorded is this one. Without the
      // passthrough here a hot loop would split into an executed half and a
      // cached half under different loop ids — and the cached half is the part
      // that proves it recurs.
      caller,
      passthrough,
    });
  }

  /**
   * Write the task down, at whatever fidelity the customer allowed.
   *
   * One place rather than at every terminal call site, for the same reason the
   * planner decides confidentiality in one place: a rule applied at four call
   * sites is a rule three of them will eventually forget.
   *
   * Best-effort throughout. A task that finished has finished; failing to record
   * it costs a training row, and there is no version of that trade where losing
   * the answer is better.
   */
  private writeTaskEpisode(
    taskId: string,
    spec: TaskSpec,
    outcome: {
      attempts: EpisodeAttempt[];
      ok: boolean;
      wallMs: number;
      output: string;
      cached?: boolean;
      caller?: CallerContext;
      passthrough?: Passthrough;
    },
  ): void {
    const mode = this.episodeMode(spec.customerId);
    if (mode === "off") return;
    try {
      let rec: TaskEpisode = {
        taskId,
        customerId: spec.customerId,
        at: Date.now(),
        mode,
        skills: spec.skills,
        // Re-scored rather than read from `state.difficulty`, which escalation
        // has already overwritten by now. What a training row needs is what the
        // scorer said *first*; where it ended up is visible in the attempt chain.
        difficulty: scoreDifficulty(spec),
        sensitivity: spec.sensitivity,
        toolInputKeys: spec.toolInput ? Object.keys(spec.toolInput).sort() : undefined,
        artifactCount: spec.artifacts.length,
        attempts: outcome.attempts,
        ok: outcome.ok,
        wallMs: outcome.wallMs,
        cached: outcome.cached,
        userId: outcome.caller?.userId,
        endUserHash: outcome.caller?.endUserHash,
        ...(outcome.passthrough ? loopShapeOf(outcome.passthrough, outcome.caller?.endUserHash) : {}),
        title: spec.title,
        input: spec.input,
        output: outcome.output,
        toolInput: spec.toolInput,
      };
      // A task row carries no conversation, so `tasks` and `full` are the same
      // thing at this grain — which is exactly what the rung exists for: a
      // customer can feed the corpus without putting their transcripts on disk.
      if (!modeAllows(mode, "tasks")) {
        rec = toTaskMetadata(rec, "customer profile does not opt into recording task text");
      } else if (spec.sensitivity === "confidential") {
        rec = toTaskMetadata(rec, "task was confidential");
      }
      this.taskEpisodes.append(rec, (msg) => this.say("warn", msg, taskId));
    } catch (err) {
      this.say("warn", `task episode not recorded: ${String(err).slice(0, 120)}`, taskId);
    }
  }

  /**
   * Order the hive to stop, and wait until it actually has.
   *
   * Deliberately NOT wired to the Queen's own SIGINT. A Queen that dies,
   * restarts or is redeployed leaves its bees running — they are autonomous
   * consumers, very often on other machines, and losing a fleet because the
   * control plane bounced would be a far worse failure than a moment without a
   * Queen. Stopping the hive is a decision somebody makes, so it has to be said
   * out loud rather than inferred from the Queen's absence.
   *
   * @returns which bees confirmed and which never answered.
   */
  async shutdownHive(reason?: string, graceMs = SHUTDOWN_GRACE_MS) {
    const expected = new Set(
      this.registry.snapshot().filter((w) => Date.now() - w.lastSeen < 60_000).map((w) => w.agentId),
    );
    this.say("warn", `stopping the hive${reason ? `: ${reason}` : ""} — ${expected.size} bee(s) to drain`);
    this.bus.publish(EXCHANGES.control, "queen.shutdown", { kind: "queen.shutdown", at: Date.now(), reason });

    const deadline = Date.now() + graceMs;
    while ([...expected].some((id) => !this.farewells.has(id)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    const confirmed = [...expected].filter((id) => this.farewells.has(id));
    const silent = [...expected].filter((id) => !this.farewells.has(id));
    const drained = [...this.farewells.values()].reduce((n, g) => n + g.drained, 0);
    if (silent.length > 0) {
      this.say("error", `no goodbye from ${silent.join(", ")} after ${Math.round(graceMs / 1000)}s`);
    }
    this.say("info", `hive stopped: ${confirmed.length} confirmed, ${drained} task(s) finished while draining`);
    return { confirmed, silent, drained };
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
    await bus.consume(EXCHANGES.control, "queen.goodbye", ["agent.goodbye"], AgentGoodbye, async (msg) => {
      this.farewells.set(msg.agentId, msg);
      this.registry.forget(msg.agentId);
      this.say(
        "info",
        `${msg.agentId} stopped` +
          (msg.drained ? `, finishing ${msg.drained} task(s) first` : "") +
          (msg.abandoned ? `, abandoning ${msg.abandoned}` : ""),
      );
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
        const state = this.store.get(msg.taskId);
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
        this.store.put(state);
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
      const state = this.store.get(result.taskId);
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

      // Keep every accepted attempt, not just the last. Recorded here, past the
      // dedup guards above, so a replayed or superseded result cannot inflate the
      // history any more than it can double-charge the ledger.
      state.history = [...(state.history ?? []), result];

      if (result.ok) {
        state.status = "done";
        state.result = result;
        this.store.put(state);
        const key = this.store.cacheKey(result.taskId);
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
        // Park what the failed attempt produced so the retry can read it in full.
        // A summary alone let attempt 2 rediscover attempt 1's dead end and spend
        // the escalation ladder doing it. By reference, so the broker message
        // stays small — the same trade the orchestrator makes for step results.
        const priorOutputRef = this.parkFailedOutput(result);
        const next = ESCALATE[state.difficulty];
        this.say(
          "warn",
          `${result.taskId} failed at tier ${result.tierUsed}, escalating (${state.difficulty} -> ${next})`,
          result.taskId,
        );
        this.dispatch(result.taskId, state.spec, next, {
          fromTier: result.tierUsed,
          attempt: state.attempts,
          failureSummary,
          priorOutputRef,
        });
      } else {
        state.status = "failed";
        state.result = result;
        this.store.put(state);
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
