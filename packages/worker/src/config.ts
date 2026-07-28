import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { CapabilityRecord } from "@hive/shared";

export const WorkerConfig = z.object({
  agentId: z.string(),
  site: z.string().default("default"),
  /** customer whose budget pool this worker's leases draw from */
  customerId: z.string().default("default"),
  /** explicit capability records (e.g. a Claude Code seat) */
  capabilities: z.array(CapabilityRecord).default([]),
  /**
   * DEPRECATED and ignored. This used to turn every model installed in local
   * Ollama into an advertised capability, which meant the hive decided for
   * itself what it could do — stamping one configured runtime onto every model,
   * and changing its promises whenever someone ran `ollama pull`. Declare the
   * agents you harnessed under `capabilities:` instead; what the host merely
   * *could* run is now reported to the console's Setup view.
   *
   * Still parsed so an older config keeps loading; the worker warns once.
   */
  autoDiscoverOllama: z
    .object({
      runtime: z.enum(["opencode", "openclaw", "hermes"]).default("opencode"),
      skills: z.array(z.string()).default(["general"]),
      /** Ollama cloud plan seat used for *-cloud models */
      cloudSeatId: z.string().optional(),
      /**
       * Which discovered models to claim. Local models are tier 3, *-cloud
       * models are tier 2, so a bee that wants to own exactly one tier must say
       * so — two bees claiming tier 2 would both receive every tier-2 task on
       * the embedded MQTT broker (see WorkerRegistry's overlap warning).
       */
      include: z.enum(["local", "cloud", "all"]).default("all"),
    })
    .optional(),
  /** tier-4 tool ids this worker serves (from the built-in registry) */
  tools: z.array(z.string()).default([]),
  /**
   * Whether to also bind the per-tier "general" fan-in queue. Bees that own a
   * disjoint skill set on a tier already shared by another bee (e.g. the
   * personal bee alongside the local bee on tier 3) set this false so the
   * embedded MQTT broker, which has no shared subscriptions, does not deliver
   * the same "general" task to both and double-spend.
   */
  bindGeneral: z.boolean().default(true),
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;

export function loadWorkerConfig(path: string): WorkerConfig {
  return WorkerConfig.parse(parse(readFileSync(path, "utf8")));
}
