import "@hive/shared/env"; // must stay first: loads .env before env-reading modules initialize
import { join, resolve } from "node:path";
import {
  allowedByConfidentiality,
  ArtifactStore,
  BudgetGrant,
  connectBus,
  CostEstimator,
  costRank,
  directQueueKey,
  EXCHANGES,
  loadCatalog,
  TaskMessage,
  tierQueueKey,
  type Bus,
  type CapabilityRecord,
  type TaskResult,
} from "@hive/shared";
import {
  BUILTIN_TOOLS,
  buildPrompt,
  OfficialAgentAdapter,
  OllamaAgentAdapter,
  ToolAdapter,
  type RuntimeAdapter,
} from "@hive/adapters";
import { loadWorkerConfig } from "./config.js";
import { discoverOllamaCapabilities } from "./discovery.js";
import { LeaseWallet } from "./wallet.js";

const ROOT = resolve(process.env.HIVE_ROOT ?? ".");
const DISCOVERY_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
/** output-token guess for pre-execution per-token cost projection; matches the Queen's estimateUsd assumption */
const PROJECTED_OUTPUT_TOKENS = 2000;

async function main() {
  const configPath = process.argv[2] ?? process.env.WORKER_CONFIG;
  if (!configPath) {
    console.error("usage: npm run worker -- <worker-config.yaml>");
    process.exit(1);
  }
  const cfg = loadWorkerConfig(configPath);
  const bus: Bus = await connectBus();
  const artifacts = new ArtifactStore(join(ROOT, "artifacts"));
  const estimator = new CostEstimator(loadCatalog(join(ROOT, "llm_model_api_catalog.yaml")));
  const wallet = new LeaseWallet();

  const toolAdapter = new ToolAdapter(
    BUILTIN_TOOLS.filter((t) => cfg.tools.includes(t.toolId)),
    (ref) => artifacts.get(ref),
  );
  const adapters: RuntimeAdapter[] = [toolAdapter, new OllamaAgentAdapter(), new OfficialAgentAdapter()];

  let capabilities: CapabilityRecord[] = [];

  async function refreshCapabilities(): Promise<boolean> {
    const discovered = cfg.autoDiscoverOllama
      ? await discoverOllamaCapabilities(cfg.autoDiscoverOllama)
      : [];
    const toolCaps: CapabilityRecord[] = toolAdapter.registeredTools().map((t) => ({
      runtime: "tool",
      tier: 4,
      billing: "free",
      skills: t.skills,
      toolId: t.toolId,
    }));
    const next = [...cfg.capabilities, ...discovered, ...toolCaps];
    const changed = JSON.stringify(next) !== JSON.stringify(capabilities);
    capabilities = next;
    return changed;
  }

  function sayHello() {
    bus.publish(EXCHANGES.control, "agent.hello", {
      kind: "agent.hello",
      agentId: cfg.agentId,
      site: cfg.site,
      capabilities,
    });
  }

  /** the worker's own per-call decision: honor the hint if we have it, else our cheapest record on that tier */
  function pickRecord(msg: TaskMessage): CapabilityRecord | undefined {
    const hint = msg.capabilityHint;
    if (hint) {
      const exact = capabilities.find((c) => c.runtime === hint.runtime && c.model === hint.model);
      if (exact) return exact;
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
    if (projectedUsd <= msg.envelope.maxUsd && wallet.canSpendUsd(projectedUsd)) return record;

    const cheaper = capabilities
      .filter((c) => c.tier === record.tier && c.billing !== "per-token")
      .filter((c) => allowedByConfidentiality(c, msg.spec.sensitivity))
      .sort((a, b) => costRank(a) - costRank(b))[0];
    if (cheaper) {
      console.log(
        `[${cfg.agentId}] budget guard: $${projectedUsd.toFixed(4)} over cap $${msg.envelope.maxUsd.toFixed(4)}, ` +
          `swapping ${record.runtime}/${record.model} -> ${cheaper.runtime}${cheaper.model ? `/${cheaper.model}` : ""} (${cheaper.billing})`,
      );
      return cheaper;
    }
    console.log(
      `[${cfg.agentId}] budget guard: refusing ${msg.taskId}, $${projectedUsd.toFixed(4)} over cap $${msg.envelope.maxUsd.toFixed(4)} / lease and no cheaper record`,
    );
    return null;
  }

  async function handleTask(msg: TaskMessage): Promise<void> {
    const started = Date.now();
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
      const adapter = adapters.find((a) => a.runtimes.includes(record.runtime))!;
      console.log(`[${cfg.agentId}] task ${msg.taskId} via ${record.runtime}${record.model ? `/${record.model}` : ""} (tier ${record.tier})`);
      const exec = await adapter.execute(msg, record, prompt);

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
        runtime: exec.runtimeUsed,
        model: exec.modelUsed,
        billing: record.billing,
        seatId: record.quotaWindow?.seatId,
        usage: { inputTokens: exec.inputTokens, outputTokens: exec.outputTokens, costUsd },
      });
    }

    bus.publish(EXCHANGES.telemetry, `task.result.${msg.taskId}`, result);

    if (wallet.shouldRequestTopUp()) {
      bus.publish(EXCHANGES.control, `budget.request.${cfg.agentId}`, {
        kind: "budget.request",
        agentId: cfg.agentId,
        customerId: msg.spec.customerId,
        reason: "lease running low",
      });
    }
  }

  function baseResult(
    msg: TaskMessage,
    started: number,
    partial: Pick<TaskResult, "ok" | "output" | "billing" | "runtime" | "usage"> &
      Partial<Pick<TaskResult, "error" | "model" | "seatId">>,
  ): TaskResult {
    return {
      kind: "task.result",
      taskId: msg.taskId,
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
  sayHello();
  // Re-announce a few times during startup. The one-shot hello can race the
  // queen's control consumer coming up — especially under the concurrent
  // `npm run solo` launch — and a missed hello means the worker never registers
  // (heartbeats from an unknown worker are ignored). Cheap and idempotent.
  let helloBurst = 0;
  const helloTimer = setInterval(() => {
    sayHello();
    if (++helloBurst >= 5) clearInterval(helloTimer);
  }, 2000);
  helloTimer.unref();
  console.log(`[${cfg.agentId}] capabilities:`);
  for (const c of capabilities) {
    console.log(`  tier ${c.tier} ${c.billing.padEnd(12)} ${c.runtime}${c.model ? `/${c.model}` : ""}${c.toolId ? ` [${c.toolId}]` : ""}`);
  }

  // shared tier queues (competing consumers) + this worker's direct queue
  const patterns = new Set<string>();
  for (const c of capabilities) {
    if (c.tier === 4 && c.toolId) {
      patterns.add(tierQueueKey(4, c.toolId));
    } else {
      for (const skill of [...c.skills, "general"]) patterns.add(tierQueueKey(c.tier, skill));
    }
  }
  for (const key of patterns) {
    await bus.consume(EXCHANGES.tasks, key, [key], TaskMessage, handleTask);
  }
  await bus.consume(EXCHANGES.tasks, directQueueKey(cfg.agentId), [directQueueKey(cfg.agentId)], TaskMessage, handleTask);
  await bus.consume(
    EXCHANGES.control,
    `grants.${cfg.agentId}`,
    [`budget.grant.${cfg.agentId}`],
    BudgetGrant,
    async (grant) => {
      wallet.applyGrant(grant);
      console.log(`[${cfg.agentId}] lease ${grant.leaseId}: $${grant.usdAllowance}, ${grant.quotaTokens} quota tokens`);
    },
  );

  setInterval(() => {
    bus.publish(EXCHANGES.control, "agent.heartbeat", {
      kind: "agent.heartbeat",
      agentId: cfg.agentId,
      at: Date.now(),
    });
  }, HEARTBEAT_INTERVAL_MS).unref();

  setInterval(async () => {
    if (await refreshCapabilities()) {
      console.log(`[${cfg.agentId}] capability set changed (Ollama models updated), re-registering`);
      sayHello();
    }
  }, DISCOVERY_INTERVAL_MS).unref();

  // initial lease
  bus.publish(EXCHANGES.control, `budget.request.${cfg.agentId}`, {
    kind: "budget.request",
    agentId: cfg.agentId,
    customerId: cfg.customerId,
    reason: "startup",
  });

  console.log(`[${cfg.agentId}] consuming: ${[...patterns].join(", ") || "(direct only)"}`);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
