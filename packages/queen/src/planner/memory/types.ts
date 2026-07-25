import { z } from "zod";

/** coerce a possibly-stringy list into a string array, as planner/types.ts does */
const stringList = z.preprocess(
  (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
  z.array(z.string()),
);

export const MEMORY_BODY_CHARS = 400;
export const MEMORY_NAME_CHARS = 160;
export const MAX_TRIGGERS = 12;
export const MAX_EVIDENCE = 5;

/**
 * What the Queen remembers, one fact per file.
 *
 *   pitfall  a planning mistake and its fix. Written by detectors, templated
 *            from customers/*.yaml values — the workhorse, and free.
 *   playbook a decomposition shape that worked. The only Queen-written type
 *            whose sentence comes from a model.
 *   fact     durable domain knowledge. Operator-written only: it is the widest
 *            injection surface (free text, no structural cause), so keeping it
 *            human-authored closes that surface at no cost.
 */
export const MemoryType = z.enum(["pitfall", "playbook", "fact"]);
export type MemoryType = z.infer<typeof MemoryType>;

/**
 * Frontmatter of a memory file. Validated strictly — unlike the bare
 * `as CustomerProfile` cast in core.ts, which is fine there because customer
 * profiles are hand-written and reviewed. Memory files are machine-written and
 * unreviewed, so every field is checked and anything unknown is dropped.
 */
export const MemoryRecord = z.object({
  id: z.string(),
  type: MemoryType.catch("pitfall"),
  customerId: z.string(),
  /** which detector minted this, or "operator" for a hand-written fact */
  source: z.string().default("operator"),
  /** the one line injected into the planner prompt */
  name: z.string().max(MEMORY_NAME_CHARS),
  description: z.string().default(""),
  /** deterministically derived content words; recall gates on overlap with these */
  triggers: stringList.default([]),
  skills: stringList.default([]),
  /**
   * How many times this structural cause has occurred. A FACT, not a
   * confidence score — the two used to be the same number, which meant a
   * memory that was recalled and then failed ranked higher afterwards. The
   * counters below carry confidence instead; this one is never rewritten by a
   * judgement about whether the lesson worked.
   */
  observed: z.number().int().min(1).catch(1),
  firstSeen: z.string().default(""),
  lastSeen: z.string().default(""),
  /** hive task ids only, never content — an 8-char uuid is inherently non-confidential */
  evidence: stringList.default([]),
  body: z.string().default(""),

  // --- confidence axis. .catch() supplies these for files written before they
  // --- existed, so an older corpus keeps parsing and starts at neutral trust.
  /** times injected into a planner prompt */
  recalled: z.number().int().min(0).catch(0),
  /** times it was recalled and appeared to work */
  helped: z.number().int().min(0).catch(0),
  /** times it was recalled and demonstrably did not work */
  misfired: z.number().int().min(0).catch(0),
  /** excluded from recall, but kept on disk so a detector cannot re-mint it */
  retired: z.boolean().catch(false),
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;

/**
 * Laplace-smoothed success rate. An unproven memory sits at exactly 0.5, so a
 * new lesson is neither promoted nor punished until there is evidence.
 */
export function trustOf(m: Pick<MemoryRecord, "helped" | "misfired">): number {
  return (m.helped + 1) / (m.helped + m.misfired + 2);
}

/** A memory has to be this bad, this many times, before it stops being paid for. */
export const RETIRE_MISFIRES = 3;
export const RETIRE_TRUST = 0.3;

export type FeedbackKind = "helped" | "misfired";

/** What a detector produces, before dedupe and before any model is asked to phrase it. */
export interface Observation {
  /** dedupe key: the structural *cause*, not the words. See store.upsert. */
  id: string;
  type: MemoryType;
  source: string;
  /** deterministic fallback sentence, always present — the model only ever improves on it */
  name: string;
  description: string;
  triggers: string[];
  skills: string[];
  evidence: string[];
  body: string;
  /** when set, reflect() may spend one local call phrasing a better `name` */
  phrasePrompt?: string;
}
