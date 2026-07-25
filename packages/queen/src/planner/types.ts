import { z } from "zod";

/** coerce a possibly-stringy list into a string array (small models sometimes emit a scalar) */
const stringList = z.preprocess(
  (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
  z.array(z.string()),
);

/**
 * What the planner LLM emits per turn. Enum fields use .catch so an
 * out-of-vocabulary value from a small model (e.g. urgency "high") falls back
 * to a safe default instead of discarding the whole plan. confidential still
 * only comes from the exact word, so the safety gate never loosens by accident.
 */
export const PlannedTask = z.object({
  key: z.string(),
  title: z.string(),
  input: z.string(),
  skills: stringList.default([]),
  sensitivity: z.enum(["normal", "confidential"]).catch("normal"),
  urgency: z.enum(["normal", "urgent"]).catch("normal"),
  dependsOn: stringList.default([]),
  toolInput: z.record(z.unknown()).optional(),
});
export type PlannedTask = z.infer<typeof PlannedTask>;

export const PlannerDecision = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clarify"), question: z.string() }),
  z.object({ kind: z.literal("plan"), rationale: z.string().default(""), tasks: z.array(PlannedTask).min(1) }),
  z.object({ kind: z.literal("answer"), text: z.string() }),
]);
export type PlannerDecision = z.infer<typeof PlannerDecision>;

export interface PlannerTurn {
  decision: PlannerDecision;
  modelUsed: string;
  tier: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /**
   * True when this "plan" was fabricated because the planner model was
   * unreachable, not decomposed by it. Nothing may learn from a fabricated
   * plan: it is always a single task carrying the raw user message, which
   * would otherwise look to reflection like a chronically under-decomposed
   * plan and mint the same bogus lesson on every offline turn.
   */
  degraded?: boolean;
}
