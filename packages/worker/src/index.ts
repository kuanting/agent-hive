import "@hive/shared/env"; // must stay first: loads .env before env-reading modules initialize
import { join, resolve } from "node:path";
import {
  agentLabel,
  agentName,
  allowedByConfidentiality,
  ArtifactStore,
  BudgetGrant,
  connectBus,
  CostEstimator,
  costRank,
  directQueueKey,
  EXCHANGES,
  describeCapability,
  isRuntimeFallback,
  loadCatalog,
  QueenRollcall,
  TaskMessage,
  tierQueueKey,
  type Bus,
  type CapabilityRecord,
  type HostInventory,
  type TaskResult,
} from "@hive/shared";
import {
  ApiModelAdapter,
  BUILTIN_TOOLS,
  buildPrompt,
  OfficialAgentAdapter,
  OllamaAgentAdapter,
  PersonalAgentAdapter,
  ToolAdapter,
  type RuntimeAdapter,
} from "@hive/adapters";
import { loadWorkerConfig } from "./config.js";
import { probeHost } from "./discovery.js";
import { TaskGate } from "./gate.js";
import { createBeeLog } from "./log.js";
import { viableCapabilities } from "./preflight.js";
import { LeaseWallet } from "./wallet.js";

const ROOT = resolve(process.env.HIVE_ROOT ?? ".");
const DISCOVERY_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * How often a bee says "still here" while a task runs. 0 disables it.
 *
 * Five seconds is chosen against what it is competing with: adapters allow a
 * task up to five MINUTES, so the console needs a signal roughly two orders of
 * magnitude finer than the job to feel live, and one tiny JSON message per five
 * seconds per in-flight task is nothing next to what the task itself costs.
 */
const PROGRESS_INTERVAL_MS = Number(process.env.HIVE_PROGRESS_MS ?? 5_000);
/**
 * How many tasks this bee runs at once.
 *
 * Explicit because it used to be a side effect: the MQTT backend withheld its ack
 * until the handler finished, which serialized delivery and quietly meant "one at
 * a time". That ack now fires on receipt (it had to — see the keepalive comment
 * in bus/mqtt.ts), so the limit has to be stated rather than inherited from
 * transport behavior that was never meant to express it.
 *
 * Default 1 keeps today's behavior. Clamped to at least 1: a bee that accepts
 * work and can never start it is worse than a slow one.
 */
const MAX_CONCURRENT_TASKS = Math.max(1, Number(process.env.HIVE_MAX_CONCURRENT_TASKS ?? 1) || 1);
/** How long a finished result stays answerable from memory, for duplicate deliveries. */
const RECENT_RESULT_TTL_MS = 10 * 60_000;
const RECENT_RESULT_MAX = 200;

/** A task this bee is holding: queued behind the concurrency cap, or running. */
interface Held {
  msg: TaskMessage;
  started: number;
  state: "queued" | "running";
  tier: 1 | 2 | 3 | 4;
  agent?: string;
  runtime: string;
  model?: string;
}
/** output-token guess for pre-execution per-token cost projection; matches the Queen's estimateUsd assumption */
const PROJECTED_OUTPUT_TOKENS = 2000;
/** opening-lease retry budget for a per-token worker before it takes work anyway */
const LEASE_RETRY_MS = 2_000;
const LEASE_ATTEMPTS = 5;

async function main() {
  const configPath = process.argv[2] ?? process.env.WORKER_CONFIG;
  if (!configPath) {
    console.error("usage: npm run worker -- <worker-config.yaml>");
    process.exit(1);
  }
  const cfg = loadWorkerConfig(configPath);
  const bus: Bus = await connectBus();
  const log = createBeeLog(cfg.agentId, bus);
  const artifacts = new ArtifactStore(join(ROOT, "artifacts"));
  const estimator = new CostEstimator(loadCatalog(join(ROOT, "llm_model_api_catalog.yaml")));
  const wallet = new LeaseWallet();

  const toolAdapter = new ToolAdapter(
    BUILTIN_TOOLS.filter((t) => cfg.tools.includes(t.toolId)),
    (ref) => artifacts.get(ref),
  );
  const adapters: RuntimeAdapter[] = [
    toolAdapter,
    new OllamaAgentAdapter(),
    new OfficialAgentAdapter(),
    new ApiModelAdapter(),
    new PersonalAgentAdapter({
      dataDir: resolve(ROOT, process.env.PERSONAL_DATA_DIR ?? "demo/personal-data"),
    }),
  ];

  let capabilities: CapabilityRecord[] = [];
  let host: HostInventory | undefined;

  const gate = new TaskGate<TaskResult>({
    maxConcurrent: MAX_CONCURRENT_TASKS,
    recentTtlMs: RECENT_RESULT_TTL_MS,
    recentMax: RECENT_RESULT_MAX,
  });

  async function refreshCapabilities(): Promise<boolean> {
    const probed = await probeHost();
    const toolCaps: CapabilityRecord[] = toolAdapter.registeredTools().map((t) => ({
      runtime: "tool",
      tier: 4,
      billing: "free",
      skills: t.skills,
      toolId: t.toolId,
    }));
    // Only what the operator configured is advertised. Drop the records this
    // host can't actually execute (missing CLI, API key, or model), so we never
    // promise a capability that would fail on dispatch.
    const report = viableCapabilities(cfg.capabilities, probed, (msg) => log("info", msg));
    const next = [...report.kept, ...toolCaps];
    // Carry the refusals with the inventory: the console's Setup view answers
    // "what could this machine run, and why isn't it registered?", and the
    // second half of that lives in preflight.
    const nextHost = { ...probed, drops: report.drops, notes: report.notes };
    const changed =
      JSON.stringify(next) !== JSON.stringify(capabilities) || JSON.stringify(nextHost) !== JSON.stringify(host);
    capabilities = next;
    host = nextHost;
    return changed;
  }

  function sayHello() {
    bus.publish(EXCHANGES.control, "agent.hello", {
      kind: "agent.hello",
      agentId: cfg.agentId,
      site: cfg.site,
      capabilities,
      bindsGeneral: cfg.bindGeneral,
      host,
    });
  }

  /**
   * The worker's own per-call decision: honor the hint if we have it, else our
   * cheapest record on that tier.
   *
   * The seat is part of a record's identity, not decoration. The same runtime
   * and model can appear twice against different quota windows (one seat for
   * general work, another with a tighter budget), and those are different
   * capabilities with different costs — so match the seat before falling back to
   * runtime+model, or the Queen meters the wrong window and its quota
   * accounting silently drifts from reality.
   */
  function pickRecord(msg: TaskMessage): CapabilityRecord | undefined {
    const hint = msg.capabilityHint;
    if (hint) {
      const sameModel = (c: CapabilityRecord) => c.runtime === hint.runtime && c.model === hint.model;
      const exact = capabilities.find(
        (c) => sameModel(c) && c.quotaWindow?.seatId === hint.quotaWindow?.seatId,
      );
      if (exact) return exact;
      const sameRuntimeAndModel = capabilities.find(sameModel);
      if (sameRuntimeAndModel) return sameRuntimeAndModel;
      const sameClass = capabilities.find((c) => c.tier === hint.tier && c.billing === hint.billing);
      if (sameClass) return sameClass;
    }
    return capabilities
      .filter((c) => c.tier === msg.envelope.tier)
      .sort((a, b) => (a.billing === "local" || a.billing === "free" ? -1 : 1) - (b.billing === "local" || b.billing === "free" ? -1 : 1))[0];
  }

  /**
   * Budget guard, run before spending real dollars. Only per-token records spend
   * USD; free/local/subscription pass through untouched (marginal cost ~0). For a
   * per-token record we project the call cost and check it against both the Queen's
   * per-task cap (envelope.maxUsd) and our own lease. Over budget, we honor "quota
   * before dollars": swap in the cheapest adequate same-tier record if we have one,
   * otherwise return null to refuse so the Queen re-routes toward a subscription seat.
   * Returns the record to execute, or null to refuse.
   */
  function guardBudget(record: CapabilityRecord, prompt: string, msg: TaskMessage): CapabilityRecord | null {
    if (record.billing !== "per-token" || !record.model) return record;
    const projectedUsd = estimator.estimate(record.model, CostEstimator.roughTokens(prompt), PROJECTED_OUTPUT_TOKENS);
    const overCap = projectedUsd > msg.envelope.maxUsd;
    const overLease = !wallet.canSpendUsd(projectedUsd);
    if (!overCap && !overLease) return record;

    // Name the actual blocker. These are different failures: over the Queen's
    // per-task cap means the model is too expensive for this task, while over
    // the lease just means we need a top-up.
    const blocker = overCap
      ? `$${projectedUsd.toFixed(4)} over per-task cap $${msg.envelope.maxUsd.toFixed(4)}`
      : `$${projectedUsd.toFixed(4)} over remaining lease $${wallet.snapshot().usdRemaining.toFixed(4)}`;

    const cheaper = capabilities
      .filter((c) => c.tier === record.tier && c.billing !== "per-token")
      .filter((c) => allowedByConfidentiality(c, msg.spec.sensitivity))
      .sort((a, b) => costRank(a) - costRank(b))[0];
    if (cheaper) {
      log(
        "warn",
        `budget guard: ${blocker}, ` +
          `swapping ${describeCapability(record)} -> ${describeCapability(cheaper)} (${cheaper.billing})`,
        msg.taskId,
      );
      return cheaper;
    }
    log("warn", `budget guard: refusing ${msg.taskId}, ${blocker} and no cheaper record`, msg.taskId);
    return null;
  }

  /**
   * Publish a liveness tick for as long as `run` is pending.
   *
   * This is the only signal that exists between dispatch and result. An adapter
   * is one buffered `execFile` or `fetch` — there is no percentage to report and
   * no partial output to stream, so this reports the two facts it actually has:
   * the task is still running, and it has been running this long. That is enough
   * for the console to tell a slow task from a dead bee, which is the question
   * someone staring at a spinner is really asking.
   *
   * unref'd so a tick can never hold the process open, and always cleared in the
   * finally — a leaked interval would announce a task that finished minutes ago.
   */
  function publishProgress(held: Held): void {
    try {
      bus.publish(EXCHANGES.telemetry, `task.progress.${held.msg.taskId}`, {
        kind: "task.progress",
        taskId: held.msg.taskId,
        agentId: cfg.agentId,
        at: Date.now(),
        elapsedMs: Date.now() - held.started,
        attempt: held.msg.attempt,
        state: held.state,
        tier: held.tier,
        agent: held.agent,
        runtime: held.runtime,
        model: held.model,
      });
    } catch {
      /* same rule as the log: reporting must never break the work */
    }
  }

  /** Tick for as long as this bee holds the task. Returns the stop function. */
  function startTicking(held: Held): () => void {
    if (PROGRESS_INTERVAL_MS <= 0) return () => {};
    // One immediately, so acceptance is observable without waiting a full
    // interval — on the lightweight backend this first tick is what tells the
    // Queen the dispatch landed rather than vanishing.
    publishProgress(held);
    const timer = setInterval(() => publishProgress(held), PROGRESS_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  /**
   * Front door for a delivered task: dedup, then hold it (ticking) until a result
   * is published.
   *
   * Dedup is keyed on `(taskId, attempt)`, and the pair is the point. A duplicate
   * carrying the SAME attempt is the transport delivering twice — it must never
   * re-run work that costs real tokens, so it re-publishes the stored result
   * instead. A NEW attempt is the Queen deliberately paying for a retry, and does
   * run. Without this, every delivery-layer bug is a bill; with it, one is a no-op.
   */
  async function handleTask(msg: TaskMessage): Promise<void> {
    const held: Held = {
      msg,
      started: Date.now(),
      state: "queued",
      tier: msg.envelope.tier,
      runtime: "pending",
    };
    let stopTicking = () => {};

    const outcome = await gate.run(
      `${msg.taskId}:${msg.attempt}`,
      async () => {
        try {
          return await executeTask(msg, held);
        } catch (err) {
          // The transport acks on receipt now, so a throw here would otherwise be
          // silent and the Queen would wait out its stall deadline for nothing.
          // Whoever owns the work owns reporting that it failed.
          log("error", `task ${msg.taskId} failed unexpectedly: ${String(err).slice(0, 200)}`, msg.taskId);
          return baseResult(msg, held.started, {
            ok: false,
            error: `worker error: ${String(err).slice(0, 300)}`,
            output: "",
            runtime: held.runtime,
            billing: "free",
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          });
        }
      },
      {
        onQueued: () => {
          stopTicking = startTicking(held);
        },
        onStart: () => {
          held.state = "running";
        },
        onSettle: () => stopTicking(),
      },
    );

    if (outcome.status === "duplicate") {
      log("debug", `task ${msg.taskId} attempt ${msg.attempt} already in flight, ignoring duplicate`, msg.taskId);
      return;
    }
    if (outcome.status === "replayed") {
      log("debug", `task ${msg.taskId} attempt ${msg.attempt} already done, re-publishing result`, msg.taskId);
    }
    bus.publish(EXCHANGES.telemetry, `task.result.${msg.taskId}`, outcome.result);

    if (outcome.status === "ran" && wallet.shouldRequestTopUp()) {
      bus.publish(EXCHANGES.control, `budget.request.${cfg.agentId}`, {
        kind: "budget.request",
        agentId: cfg.agentId,
        customerId: msg.spec.customerId,
        reason: "lease running low",
      });
    }
  }

  async function executeTask(msg: TaskMessage, held: Held): Promise<TaskResult> {
    const started = held.started;
    let record = msg.matchedToolId
      ? capabilities.find((c) => c.toolId === msg.matchedToolId)
      : pickRecord(msg);
    const prompt = record && record.tier !== 4 ? buildPrompt(msg, (ref) => artifacts.get(ref)) : "";

    // guard real-dollar spend before executing; may swap to a cheaper record or refuse
    let refusedRecord: CapabilityRecord | undefined;
    if (record) {
      const guarded = guardBudget(record, prompt, msg);
      if (guarded) {
        record = guarded;
      } else {
        refusedRecord = record;
        record = undefined;
      }
    }

    let result: TaskResult;
    if (refusedRecord) {
      result = baseResult(msg, started, {
        ok: false,
        error: `budget guard: projected per-token cost over per-task cap $${msg.envelope.maxUsd.toFixed(4)} and lease, no cheaper capability`,
        output: "",
        agent: agentName(refusedRecord),
        runtime: refusedRecord.runtime,
        billing: refusedRecord.billing,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      });
    } else if (!record) {
      result = baseResult(msg, started, {
        ok: false,
        error: `no capability for tier ${msg.envelope.tier}`,
        output: "",
        runtime: "none",
        billing: "free",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      });
    } else {
      const chosen = record;
      const adapter = adapters.find((a) => a.runtimes.includes(chosen.runtime))!;
      const owner = agentName(chosen);
      // Now that a record is chosen, the ticks can name it — the console shows
      // which bee and which model is holding the task while it runs.
      held.agent = owner;
      held.runtime = chosen.runtime;
      held.model = chosen.model;
      held.tier = chosen.tier;
      log("info", `task ${msg.taskId} via ${owner}${chosen.model ? `/${chosen.model}` : ""} (tier ${chosen.tier})`, msg.taskId);
      const exec = await adapter.execute(msg, chosen, prompt);
      // The configured agent is what this bee promised; runtimeUsed is what it
      // delivered. When they differ the bee substituted a backend, which the
      // operator reading the log is the one who can fix — so say it here, not
      // only in the task result nobody tails.
      if (isRuntimeFallback(owner, exec.runtimeUsed) && isRuntimeFallback(chosen.runtime, exec.runtimeUsed)) {
        log("warn", `${owner} unavailable — task ${msg.taskId} executed via ${exec.runtimeUsed}`, msg.taskId);
      }

      const costUsd =
        exec.reportedUsd ??
        (record.billing === "per-token" && exec.modelUsed
          ? estimator.estimate(exec.modelUsed, exec.inputTokens, exec.outputTokens)
          : 0);
      wallet.spend(costUsd, record.billing === "subscription" ? exec.inputTokens + exec.outputTokens : 0);

      result = baseResult(msg, started, {
        ok: exec.ok,
        error: exec.error,
        output: exec.output,
        agent: owner,
        runtime: exec.runtimeUsed,
        model: exec.modelUsed,
        billing: record.billing,
        seatId: record.quotaWindow?.seatId,
        usage: { inputTokens: exec.inputTokens, outputTokens: exec.outputTokens, costUsd },
      });
    }

    return result;
  }

  function baseResult(
    msg: TaskMessage,
    started: number,
    partial: Pick<TaskResult, "ok" | "output" | "billing" | "runtime" | "usage"> &
      Partial<Pick<TaskResult, "error" | "model" | "seatId" | "agent">>,
  ): TaskResult {
    return {
      kind: "task.result",
      taskId: msg.taskId,
      attempt: msg.attempt,
      agentId: cfg.agentId,
      customerId: msg.spec.customerId,
      tierUsed: msg.envelope.tier,
      degraded: msg.envelope.degraded,
      durationMs: Date.now() - started,
      ...partial,
    };
  }

  // ---- wire up ----
  await refreshCapabilities();

  // Answer the Queen when it asks. This is what replaced announcing six times and
  // hoping: a hello published before the Queen's control consumer exists is
  // dropped silently, so the bee used to shout on a timer to raise the odds one
  // landed. Now the Queen asks — on its own boot, and specifically at any bee it
  // hears a heartbeat from but does not know — which turns "probably registered"
  // into "registered, or registered one heartbeat later".
  await bus.consume(EXCHANGES.control, `rollcall.${cfg.agentId}`, ["queen.rollcall", `queen.rollcall.${cfg.agentId}`], QueenRollcall, async () => {
    log("debug", "rollcall — introducing myself");
    sayHello();
  });

  // Still say hello unprompted: the common case is the Queen already listening,
  // and this saves a round trip.
  sayHello();
  if (cfg.autoDiscoverOllama) {
    log(
      "warn",
      `autoDiscoverOllama is ignored: the hive advertises the agents you configure, ` +
        `not every model it finds. Declare them under 'capabilities:' — the models this host has are ` +
        `reported to the console's Setup view instead.`,
    );
  }
  // The roster stays a plain console block: it is a multi-line startup banner for
  // whoever launched the process, and the console reads the same facts from
  // /status. Only the one-line summary goes on the wire.
  console.log(`[${cfg.agentId}] capabilities:`);
  for (const c of capabilities) {
    console.log(`  tier ${c.tier} ${c.billing.padEnd(12)} ${describeCapability(c)}`);
  }
  if (capabilities.length === 0) {
    // Stay up and registered rather than exiting: /status then shows this bee
    // present but offering nothing, which is more honest than a missing process.
    log(
      "warn",
      `no viable capabilities on this host — nothing configured here can run. ` +
        `Idle but registered; the Queen will route around it.`,
    );
  } else {
    log("info", `registered ${capabilities.length} capabilit${capabilities.length === 1 ? "y" : "ies"}`);
  }

  // Grants first, then the opening lease request, and only then task queues.
  // The wallet starts empty, so a per-token task that arrives before the first
  // grant would be refused by the budget guard for lack of a lease — burning an
  // escalation attempt and pushing the task up a difficulty level for a reason
  // that has nothing to do with the task. Take no work until we can pay for it.
  let leaseArrived: () => void = () => {};
  const firstLease = new Promise<void>((resolve) => {
    leaseArrived = resolve;
  });
  await bus.consume(
    EXCHANGES.control,
    `grants.${cfg.agentId}`,
    [`budget.grant.${cfg.agentId}`],
    BudgetGrant,
    async (grant) => {
      wallet.applyGrant(grant);
      log("info", `lease ${grant.leaseId}: $${grant.usdAllowance}, ${grant.quotaTokens} quota tokens`);
      leaseArrived();
    },
  );

  const requestLease = (reason: string) =>
    bus.publish(EXCHANGES.control, `budget.request.${cfg.agentId}`, {
      kind: "budget.request",
      agentId: cfg.agentId,
      customerId: cfg.customerId,
      reason,
    });

  // Retried like the hello burst, and for the same reason: workers and the Queen
  // start concurrently, so a one-shot request can be published before the Queen's
  // control consumer has subscribed — and an unsubscribed MQTT topic drops it
  // silently. A lost request leaves the wallet empty, which the budget guard
  // reads as "can't afford this" and refuses per-token work over.
  requestLease("startup");
  if (capabilities.some((c) => c.billing === "per-token")) {
    for (let attempt = 1; attempt <= LEASE_ATTEMPTS; attempt++) {
      await Promise.race([
        firstLease,
        new Promise<void>((resolve) => setTimeout(resolve, LEASE_RETRY_MS).unref()),
      ]);
      if (wallet.snapshot().usdRemaining > 0) break;
      if (attempt < LEASE_ATTEMPTS) requestLease("startup retry");
    }
    if (wallet.snapshot().usdRemaining === 0) {
      log(
        "warn",
        `no lease after ${LEASE_ATTEMPTS} attempts — starting anyway; ` +
          `per-token work will be refused until one arrives`,
      );
    }
  }

  // shared tier queues (competing consumers) + this worker's direct queue
  const patterns = new Set<string>();
  for (const c of capabilities) {
    if (c.tier === 4 && c.toolId) {
      patterns.add(tierQueueKey(4, c.toolId));
    } else {
      for (const skill of [...c.skills, ...(cfg.bindGeneral ? ["general"] : [])])
        patterns.add(tierQueueKey(c.tier, skill));
    }
  }
  for (const key of patterns) {
    await bus.consume(EXCHANGES.tasks, key, [key], TaskMessage, handleTask);
  }
  await bus.consume(EXCHANGES.tasks, directQueueKey(cfg.agentId), [directQueueKey(cfg.agentId)], TaskMessage, handleTask);

  setInterval(() => {
    bus.publish(EXCHANGES.control, "agent.heartbeat", {
      kind: "agent.heartbeat",
      agentId: cfg.agentId,
      at: Date.now(),
    });
  }, HEARTBEAT_INTERVAL_MS).unref();

  setInterval(async () => {
    if (await refreshCapabilities()) {
      log("info", `capability set changed (Ollama models updated), re-registering`);
      sayHello();
    }
  }, DISCOVERY_INTERVAL_MS).unref();

  log("info", `consuming: ${[...patterns].join(", ") || "(direct only)"}`);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
