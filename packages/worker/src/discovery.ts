import type { CapabilityRecord } from "@hive/shared";
import type { WorkerConfig } from "./config.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

/**
 * Ollama-close integration: ask the local Ollama daemon what models are
 * installed and build capability records from them. Local models become tier 3
 * (billing: local); models on Ollama's cloud plan (the *-cloud tags) become
 * tier 2 on the plan's subscription seat. Re-run periodically so pulls and
 * removals update the worker's registration.
 */
export async function discoverOllamaCapabilities(
  cfg: NonNullable<WorkerConfig["autoDiscoverOllama"]>,
): Promise<CapabilityRecord[]> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => {
      const isCloud = /cloud/.test(m.name);
      return {
        runtime: cfg.runtime,
        model: m.name,
        tier: isCloud ? 2 : 3,
        billing: isCloud ? "subscription" : "local",
        skills: cfg.skills,
        quotaWindow:
          isCloud && cfg.cloudSeatId
            ? { seatId: cfg.cloudSeatId, windowSeconds: 3600, tokensPerWindow: 1_000_000 }
            : undefined,
      } satisfies CapabilityRecord;
    });
  } catch {
    return []; // no Ollama on this host; explicit capabilities still apply
  }
}
