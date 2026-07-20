import "@hive/shared/env"; // must stay first: loads .env before env-reading modules initialize
import { join, resolve } from "node:path";
import {
  ArtifactStore,
  BudgetGrant,
  connectBus,
  CostEstimator,
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

  async function handleTask(msg: TaskMessage): Promise<void> {
    const started = Date.now();
    const record = msg.matchedToolId
      ? capabilities.find((c) => c.toolId === msg.matchedToolId)
      : pickRecord(msg);

    let result: TaskResult;
    if (!record) {
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
      const prompt = record.tier === 4 ? "" : buildPrompt(msg, (ref) => artifacts.get(ref));
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
