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
  /** auto-build tier 2/3 records from models installed in local Ollama */
  autoDiscoverOllama: z
    .object({
      runtime: z.enum(["opencode", "openclaw", "hermes"]).default("opencode"),
      skills: z.array(z.string()).default(["general"]),
      /** Ollama cloud plan seat used for *-cloud models */
      cloudSeatId: z.string().optional(),
    })
    .optional(),
  /** tier-4 tool ids this worker serves (from the built-in registry) */
  tools: z.array(z.string()).default([]),
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;

export function loadWorkerConfig(path: string): WorkerConfig {
  return WorkerConfig.parse(parse(readFileSync(path, "utf8")));
}
