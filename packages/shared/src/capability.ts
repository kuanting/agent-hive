import { z } from "zod";

/**
 * Capability tiers describe composition, NOT cost.
 *  1: official agent + paid frontier model (Claude Code, Codex)  — "honey bee"
 *  2: open-source agent + paid model (per-token API or Ollama cloud) — "metered bee"
 *  3: open-source agent + local model (local Ollama)              — "local bee"
 *  4: hardcoded tool, no LLM                                      — "worker bee"
 */
export const Tier = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Tier = z.infer<typeof Tier>;

/** Billing type determines real marginal cost, independent of tier. */
export const BillingType = z.enum(["subscription", "per-token", "local", "free"]);
export type BillingType = z.infer<typeof BillingType>;

export const Difficulty = z.enum(["simple", "standard", "complex"]);
export type Difficulty = z.infer<typeof Difficulty>;

export const Sensitivity = z.enum(["normal", "confidential"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const Urgency = z.enum(["normal", "urgent"]);
export type Urgency = z.infer<typeof Urgency>;

export const QuotaWindow = z.object({
  seatId: z.string(),
  windowSeconds: z.number(),
  /** estimated tokens the seat allows per window */
  tokensPerWindow: z.number(),
});
export type QuotaWindow = z.infer<typeof QuotaWindow>;

export const CapabilityRecord = z.object({
  runtime: z.enum(["claude-code", "codex", "opencode", "openclaw", "hermes", "personal", "api", "tool"]),
  tier: Tier,
  billing: BillingType,
  model: z.string().optional(),
  skills: z.array(z.string()).default([]),
  toolId: z.string().optional(),
  quotaWindow: QuotaWindow.optional(),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecord>;

/**
 * Marginal-cost rank used by the Queen's "cheapest adequate capability" routing.
 * Lower rank = dispatch first. Per-token API is the true last resort:
 * subscription seats are prepaid, so their marginal token cost is ~0
 * inside the quota window.
 */
export function costRank(cap: CapabilityRecord): number {
  switch (cap.billing) {
    case "free":
      return 0;
    case "local":
      return 1;
    case "subscription":
      return cap.tier === 1 ? 3 : 2; // Ollama cloud seat before frontier seat
    case "per-token":
      return 4;
  }
}

/** Which tiers may serve a given difficulty. */
export function adequateTiers(difficulty: Difficulty): Tier[] {
  switch (difficulty) {
    case "simple":
      return [4, 3, 2, 1];
    case "standard":
      return [3, 2, 1];
    case "complex":
      return [1, 2];
  }
}

/** Confidential work never leaves the premises. */
export function allowedByConfidentiality(cap: CapabilityRecord, sensitivity: Sensitivity): boolean {
  if (sensitivity !== "confidential") return true;
  return cap.billing === "local" || cap.billing === "free";
}
