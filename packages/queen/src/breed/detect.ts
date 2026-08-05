import type { CostEstimator } from "@hive/shared";
import { tokenize } from "../planner/memory/recall.js";
import type { TaskEpisode } from "../episode.js";
import type { Shape } from "./corpus.js";

/**
 * Which shapes are worth replacing with a program, and in what order.
 *
 * Every gate here is arithmetic over rows that already exist: no model call, no
 * token, no network. That is deliberate and not merely thrifty — a survey that
 * cost money would be run once and then trusted for months, and the whole point
 * is that it is cheap enough to re-run whenever the traffic changes.
 *
 * The gates are conjunctive and each one is a claim about *feasibility*, not
 * about value. Value is the ranking, and it is separate on purpose: a shape can
 * be enormously expensive and still be a terrible candidate because its output
 * is prose.
 */

/**
 * Reference frontier model for the counterfactual.
 *
 * Same device, and the same reasoning, as `demo/scoreboard.ts`: on a solo hive
 * local work reports `costUsd: 0`, so ranking on observed spend finds nothing
 * worth breeding anywhere. Re-pricing the *observed token counts* at frontier
 * rates asks the question that actually matters — "what would this work cost if
 * the hive had no cheap route for it?" — which is exactly what a tier-4 bee
 * makes permanent. Computed, therefore an estimate, and labelled as one.
 */
export const FRONTIER = "claude-opus-4-6";

export const DEFAULTS = {
  minSamples: Number(process.env.HIVE_BREED_MIN_SAMPLES ?? 12),
  minOkRate: Number(process.env.HIVE_BREED_MIN_OK_RATE ?? 0.9),
  minFirstAttemptOkRate: Number(process.env.HIVE_BREED_MIN_FIRST_OK ?? 0.8),
  minTemplateSimilarity: Number(process.env.HIVE_BREED_MIN_SIMILARITY ?? 0.5),
  minSavingsUsd: Number(process.env.HIVE_BREED_MIN_SAVINGS_USD ?? 1.0),
};
export type Thresholds = typeof DEFAULTS;

/**
 * `unknown` is a first-class answer, not a soft pass.
 *
 * Determinism and template similarity are claims about task *output*, which the
 * default `metadata` fidelity does not record. Scoring those as passes would
 * promote shapes nobody has checked; scoring them as failures would mean the
 * survey finds nothing at the fidelity almost every hive is actually at. So they
 * report that they could not be evaluated, and the shape is held apart from both
 * the candidates and the rejects.
 */
export type GateResult = "pass" | "fail" | "unknown";

export interface Gate {
  name: string;
  result: GateResult;
  /** what was measured, for the operator to read — never the content itself */
  detail: string;
}

export interface ShapeStats {
  occurrences: number;
  executed: number;
  cached: number;
  okRate: number;
  /** undefined when nothing in this shape actually ran */
  firstAttemptOkRate?: number;
  inputTokens: number;
  outputTokens: number;
  observedUsd: number;
  counterfactualUsd: number;
  wallMsExecuted: number;
  attemptsTotal: number;
}

export type Verdict = "candidate" | "unassessable" | "rejected";

export interface Assessment {
  shape: Shape;
  stats: ShapeStats;
  gates: Gate[];
  verdict: Verdict;
  /** counterfactual USD this shape would stop costing, if a bee served it for free */
  projectedSavingsUsd: number;
}

/** A row that actually ran, as opposed to one served from cache. */
const executedRows = (rows: TaskEpisode[]): TaskEpisode[] => rows.filter((r) => !r.cached);

export function statsOf(shape: Shape, estimator: CostEstimator): ShapeStats {
  const executed = executedRows(shape.rows);
  let inputTokens = 0;
  let outputTokens = 0;
  let observedUsd = 0;
  let attemptsTotal = 0;
  let wallMsExecuted = 0;
  let firstOk = 0;

  for (const row of executed) {
    wallMsExecuted += row.wallMs;
    attemptsTotal += row.attempts.length;
    if (row.attempts[0]?.ok) firstOk += 1;
    for (const a of row.attempts) {
      inputTokens += a.inputTokens;
      outputTokens += a.outputTokens;
      observedUsd += a.costUsd;
    }
  }

  return {
    occurrences: shape.rows.length,
    executed: executed.length,
    cached: shape.rows.length - executed.length,
    okRate: shape.rows.length ? shape.rows.filter((r) => r.ok).length / shape.rows.length : 0,
    firstAttemptOkRate: executed.length ? firstOk / executed.length : undefined,
    inputTokens,
    outputTokens,
    observedUsd,
    // Every attempt, not just the successful one: a bee that serves the shape
    // replaces the whole escalation ladder, including the retries it took.
    counterfactualUsd: estimator.estimate(FRONTIER, inputTokens, outputTokens),
    wallMsExecuted,
    attemptsTotal,
  };
}

/** Collapse incidental whitespace so "the same input" means what a person means by it. */
const normalize = (s: string): string => s.trim().replace(/\s+/g, " ");

/**
 * Does the same input reliably produce the same output?
 *
 * The premise of the whole feature. A shape whose answer varies between two
 * identical asks is not a function, and no deterministic program can stand in
 * for it. This is also the assumption `ResultCache` already makes when it serves
 * a stored answer for a repeated spec — so a shape that fails here is arguably
 * telling you the cache is wrong about it too.
 */
function determinismGate(rows: TaskEpisode[]): Gate {
  const byInput = new Map<string, Set<string>>();
  let comparable = 0;
  for (const r of rows) {
    if (r.input === undefined || r.output === undefined) continue;
    const key = normalize(r.input);
    const outs = byInput.get(key) ?? new Set<string>();
    if (outs.size > 0) comparable += 1;
    outs.add(normalize(r.output));
    byInput.set(key, outs);
  }
  if (comparable === 0) {
    return {
      name: "determinism",
      result: "unknown",
      detail: rows.some((r) => r.input !== undefined)
        ? "no input was seen twice, so nothing could be compared"
        : "task text not recorded at this fidelity",
    };
  }
  const divergent = [...byInput.values()].filter((outs) => outs.size > 1).length;
  return {
    name: "determinism",
    result: divergent === 0 ? "pass" : "fail",
    detail:
      divergent === 0
        ? `${comparable} repeat input(s), all agreed`
        : `${divergent} input(s) produced more than one distinct output`,
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Is the output mechanical enough that agreement can be judged without a model?
 *
 * This is the gate that keeps prose out, and it earns its place by making
 * everything downstream possible: fitness scoring, shadow comparison and drift
 * detection all rest on being able to say "these two answers are the same" for
 * free. An LLM judge could rule on prose, at the cost of reintroducing both
 * spend and non-determinism into the one place that must have neither.
 */
function templateGate(rows: TaskEpisode[], min: number): Gate {
  const outputs = rows.map((r) => r.output).filter((o): o is string => o !== undefined);
  if (outputs.length < 2) {
    return {
      name: "template",
      result: "unknown",
      detail: outputs.length === 0 ? "task text not recorded at this fidelity" : "only one output recorded",
    };
  }
  // Bounded: pairwise is quadratic and a hot shape can have thousands of rows.
  // The newest are the ones a bee would have to reproduce.
  const sample = outputs.slice(-40).map((o) => tokenize(o));
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      sum += jaccard(sample[i], sample[j]);
      pairs += 1;
    }
  }
  const mean = pairs ? sum / pairs : 0;
  return {
    name: "template",
    result: mean >= min ? "pass" : "fail",
    detail: `mean pairwise similarity ${mean.toFixed(2)} over ${sample.length} output(s), need ${min.toFixed(2)}`,
  };
}

export function assess(shape: Shape, estimator: CostEstimator, t: Thresholds = DEFAULTS): Assessment {
  const stats = statsOf(shape, estimator);
  const executed = executedRows(shape.rows);

  const gates: Gate[] = [
    {
      name: "frequency",
      result: stats.occurrences >= t.minSamples ? "pass" : "fail",
      detail: `${stats.occurrences} occurrence(s), need ${t.minSamples}`,
    },
    {
      name: "reliability",
      result: stats.okRate >= t.minOkRate ? "pass" : "fail",
      // You cannot write a spec for work the hive gets wrong: the corpus would be
      // teaching the bee to reproduce the failure.
      detail: `${(stats.okRate * 100).toFixed(0)}% succeeded, need ${(t.minOkRate * 100).toFixed(0)}%`,
    },
    {
      name: "first-attempt",
      result:
        stats.firstAttemptOkRate === undefined
          ? "unknown"
          : stats.firstAttemptOkRate >= t.minFirstAttemptOkRate
            ? "pass"
            : "fail",
      // A shape that routinely needs the escalation ladder is one the hive finds
      // hard, and "hard for a frontier model" is a poor bet for a fixed program.
      detail:
        stats.firstAttemptOkRate === undefined
          ? "every occurrence was served from cache; nothing ran"
          : `${(stats.firstAttemptOkRate * 100).toFixed(0)}% succeeded first try, need ${(t.minFirstAttemptOkRate * 100).toFixed(0)}%`,
    },
    determinismGate(executed),
    templateGate(executed, t.minTemplateSimilarity),
    {
      name: "savings",
      result: stats.counterfactualUsd >= t.minSavingsUsd ? "pass" : "fail",
      detail: `$${stats.counterfactualUsd.toFixed(2)} counterfactual, need $${t.minSavingsUsd.toFixed(2)}`,
    },
  ];

  const verdict: Verdict = gates.some((g) => g.result === "fail")
    ? "rejected"
    : gates.some((g) => g.result === "unknown")
      ? "unassessable"
      : "candidate";

  return { shape, stats, gates, verdict, projectedSavingsUsd: stats.counterfactualUsd };
}

/**
 * Assess every shape, best first.
 *
 * Ranked on projected savings rather than on frequency, because the two diverge
 * exactly where it matters: a hundred cheap tier-3 calls and three expensive
 * frontier ones are not the same prize, and only one of them repays the cost of
 * breeding a bee.
 */
export function survey(shapes: Shape[], estimator: CostEstimator, t: Thresholds = DEFAULTS): Assessment[] {
  const order: Record<Verdict, number> = { candidate: 0, unassessable: 1, rejected: 2 };
  return shapes
    .map((s) => assess(s, estimator, t))
    .sort(
      (a, b) =>
        order[a.verdict] - order[b.verdict] ||
        b.projectedSavingsUsd - a.projectedSavingsUsd ||
        b.stats.occurrences - a.stats.occurrences,
    );
}
