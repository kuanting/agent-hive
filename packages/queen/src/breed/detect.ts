import type { CostEstimator } from "@hive/shared";
import { tokenize } from "../planner/memory/recall.js";
import type { TaskEpisode } from "../episode.js";
import type { Shape } from "./corpus.js";
import { maskCluster, maskText, normalize } from "./mask.js";

/**
 * Which shapes are worth replacing with a program, and in what order.
 *
 * Every gate here is arithmetic over rows that already exist: no model call, no
 * token, no network. That is deliberate and not merely thrifty — a survey that
 * cost money would be run once and then trusted for months, and the whole point
 * is that it is cheap enough to re-run whenever the traffic changes.
 *
 * The gates ask whether a shape *could* be a program. What kind of program, and
 * whether it is worth writing, are separate questions on purpose: a shape can be
 * enormously expensive and still be a terrible candidate because its output is
 * prose, and a cheap one can be an excellent candidate because it runs forty
 * times a week and never varies.
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
  /** masking inflates similarity, so the bar rises with it */
  minTemplateSimilarity: Number(process.env.HIVE_BREED_MIN_SIMILARITY ?? 0.6),
  /** how far a cluster must out-resemble itself compared with everything else */
  minTemplateMargin: Number(process.env.HIVE_BREED_MIN_MARGIN ?? 0.25),
  /** above this, masking has eaten the text and similarity measures the mask */
  maxMaskRatio: Number(process.env.HIVE_BREED_MAX_MASK ?? 0.35),
  /** a word in this fraction of a cluster's rows is procedure, not value */
  minInvariantDf: Number(process.env.HIVE_BREED_MIN_DF ?? 0.9),
  /** below this gap, two different answers to one request are not "the data moved" */
  liveGapMs: Number(process.env.HIVE_BREED_LIVE_GAP_MS ?? 60_000),
};
export type Thresholds = typeof DEFAULTS;

/**
 * `unknown` is a first-class answer, not a soft pass.
 *
 * The content gates are claims about task text, which the default `metadata`
 * fidelity does not record. Scoring those as passes would promote shapes nobody
 * has checked; scoring them as failures would mean the survey finds nothing at
 * the fidelity almost every hive is actually at. So they report that they could
 * not be evaluated, and the shape is held apart from both the candidates and the
 * rejects.
 */
export type GateResult = "pass" | "fail" | "unknown";

export interface Gate {
  name: string;
  result: GateResult;
  /** what was measured, for the operator to read — never the content itself */
  detail: string;
}

/**
 * How much the *values* moved, as opposed to the procedure.
 *
 * The distinction this whole file turns on. A price lookup returns a different
 * number tomorrow and is still a fixed procedure; the same request answered two
 * ways inside a minute is not.
 */
export type Volatility = "stable" | "mixed" | "live" | "nondeterministic" | "unstable-procedure" | "unknown";

export interface Signals {
  volatility: Volatility;
  /** fraction of repeat-request groups whose raw answers were not all identical */
  valueVolatility: number;
  /** the demoted output template check: failing it is evidence of live data, not a defect */
  answerTemplate: Gate;
  maskRatio: { request: number; answer: number };
  templateMargin: { request: number | "uncontrolled"; answer: number | "uncontrolled" };
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
  signals: Signals;
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

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const meanPairwise = (sets: Set<string>[]): number => {
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      sum += jaccard(sets[i], sets[j]);
      pairs += 1;
    }
  }
  return pairs ? sum / pairs : 0;
};

const meanCross = (a: Set<string>[], b: Set<string>[]): number => {
  let sum = 0;
  let pairs = 0;
  for (const x of a) {
    for (const y of b) {
      sum += jaccard(x, y);
      pairs += 1;
    }
  }
  return pairs ? sum / pairs : 0;
};

/**
 * How much of a masked text is still real words.
 *
 * Agreement between two masked strings only means something if there is
 * something other than placeholders to agree about. An answer that masks down to
 * `mask-code mask-code mask-code` matches every other answer that does the same,
 * however unrelated they were — masking can manufacture the very stability the
 * procedure gate is looking for, which would let prose in through the one door
 * built to keep it out.
 */
const contentTokens = (maskedText: string): number => {
  let n = 0;
  for (const tok of tokenize(maskedText)) if (!tok.startsWith("mask-")) n += 1;
  return n;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Pairwise comparison is quadratic, and the newest rows are what a bee must reproduce. */
const SAMPLE = 40;

export interface TemplateOutcome {
  gate: Gate;
  maskRatio: number;
  margin: number | "uncontrolled";
}

/**
 * Is this side of the exchange a form with blanks filled in?
 *
 * Measured on masked text, so two answers differing only in their numbers read as
 * one template. Two guards keep that from being circular:
 *
 * The mask ratio ceiling catches a side where masking removed so much that what
 * is left is mostly placeholder — similarity there measures the mask, not the
 * template, so it reports `unknown` rather than a confident pass.
 *
 * The control margin catches the subtler version. Similarity alone cannot tell
 * "these rows share a template" from "masking flattened everything into the same
 * soup", so the cluster is also compared against rows from *other* shapes, masked
 * with this cluster's own exemption set. Over-masking raises both numbers and
 * collapses the difference between them, which makes the failure measurable
 * instead of something to be assumed away.
 */
export function templateOutcome(
  name: string,
  texts: string[],
  control: string[],
  t: Thresholds,
): TemplateOutcome {
  if (texts.length < 2) {
    return {
      gate: {
        name,
        result: "unknown",
        detail: texts.length === 0 ? "task text not recorded at this fidelity" : "only one example recorded",
      },
      maskRatio: 0,
      margin: "uncontrolled",
    };
  }

  const sample = texts.slice(-SAMPLE);
  const { masked, exempt, meanMaskRatio } = maskCluster(sample, t.minInvariantDf);
  if (meanMaskRatio > t.maxMaskRatio) {
    return {
      gate: {
        name,
        result: "unknown",
        detail:
          `masking removed ${(meanMaskRatio * 100).toFixed(0)}% of the text; ` +
          `similarity here would be measuring the mask, not the template`,
      },
      maskRatio: meanMaskRatio,
      margin: "uncontrolled",
    };
  }

  const mine = masked.map((m) => tokenize(m.text));
  const simIn = meanPairwise(mine);

  // The control is masked with THIS cluster's exemptions, so any flattening the
  // exemption set causes shows up on both sides.
  const controlSample = control.slice(0, SAMPLE);
  const theirs = controlSample.map((c) => tokenize(maskText(c, exempt).text));
  const margin: number | "uncontrolled" = theirs.length ? simIn - meanCross(mine, theirs) : "uncontrolled";

  const similar = simIn >= t.minTemplateSimilarity;
  const distinct = margin === "uncontrolled" || margin >= t.minTemplateMargin;
  const detail =
    `similarity ${simIn.toFixed(2)} over ${mine.length} example(s), need ${t.minTemplateSimilarity.toFixed(2)}` +
    (margin === "uncontrolled"
      ? " (no other shape to compare against)"
      : `; ${margin.toFixed(2)} above other shapes, need ${t.minTemplateMargin.toFixed(2)}`);

  return {
    gate: { name, result: similar && distinct ? "pass" : "fail", detail },
    maskRatio: meanMaskRatio,
    margin,
  };
}

export interface ProcedureOutcome {
  gate: Gate;
  volatility: Volatility;
  valueVolatility: number;
}

/**
 * Are the steps fixed, even when the data is not?
 *
 * This replaces a determinism check that grouped on the raw request, which meant
 * forty lookups of forty different part numbers produced zero comparable pairs
 * and the gate simply shrugged. Grouping on the *masked* request is what creates
 * the groups: every "price for <part>" lands together, and then the answers can
 * actually be compared.
 *
 * What a disagreement means depends on how far apart the two asks were, and that
 * is the whole reframe. Different answers days apart with the same shape is live
 * data — a scraper, and a candidate. The same request answered two ways inside a
 * minute is neither the procedure nor the data being stable, and no program can
 * stand in for it.
 *
 * Cached rows are excluded: a cache hit trivially agrees with itself and would
 * launder volatility into stability.
 */
export function procedureOutcome(rows: TaskEpisode[], t: Thresholds): ProcedureOutcome {
  const usable = rows.filter((r) => r.input !== undefined && r.output !== undefined);
  if (usable.length === 0) {
    return {
      gate: { name: "procedure", result: "unknown", detail: "task text not recorded at this fidelity" },
      volatility: "unknown",
      valueVolatility: 0,
    };
  }

  const inputs = maskCluster(
    usable.map((r) => r.input!),
    t.minInvariantDf,
  ).masked;
  const outputs = maskCluster(
    usable.map((r) => r.output!),
    t.minInvariantDf,
  ).masked;

  const groups = new Map<string, number[]>();
  usable.forEach((_, i) => {
    const key = normalize(inputs[i].text);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });

  let comparable = 0;
  let differing = 0;
  let unstable = 0;
  const gaps: number[] = [];

  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    comparable += 1;
    const maskedSet = new Set(idx.map((i) => normalize(outputs[i].text)));
    if (maskedSet.size > 1) {
      unstable += 1;
      continue;
    }
    const ordered = [...idx].sort((a, b) => usable[a].at - usable[b].at);
    let groupDiffers = false;
    for (let k = 1; k < ordered.length; k++) {
      const prev = ordered[k - 1];
      const cur = ordered[k];
      if (normalize(usable[prev].output!) !== normalize(usable[cur].output!)) {
        groupDiffers = true;
        gaps.push(Math.abs(usable[cur].at - usable[prev].at));
      }
    }
    if (groupDiffers) differing += 1;
  }

  if (comparable === 0) {
    return {
      gate: {
        name: "procedure",
        result: "unknown",
        detail: "no request repeated, even after masking away its values",
      },
      volatility: "unknown",
      valueVolatility: 0,
    };
  }

  // Agreement reached on nothing but placeholders is not agreement. Checked here
  // rather than by a mask-ratio ceiling because a heavily-masked answer can still
  // be perfectly good evidence — a price line is mostly values and keeps `stock`,
  // `lead`, `time` — while an answer that keeps *no* word at all has been
  // flattened into a shape it never had.
  const meanContent = outputs.reduce((n, m) => n + contentTokens(m.text), 0) / outputs.length;
  if (meanContent < 1) {
    return {
      gate: {
        name: "procedure",
        result: "unknown",
        detail: "masking left no words in the answers, so their agreement says nothing",
      },
      volatility: "unknown",
      valueVolatility: 0,
    };
  }

  const valueVolatility = differing / comparable;

  if (unstable > 0) {
    return {
      gate: {
        name: "procedure",
        result: "fail",
        detail: `${unstable} of ${comparable} repeat request(s) produced answers of different shape`,
      },
      volatility: "unstable-procedure",
      valueVolatility,
    };
  }

  const medianGap = median(gaps);
  if (differing > 0 && medianGap < t.liveGapMs) {
    return {
      gate: {
        name: "procedure",
        result: "fail",
        detail:
          `the same request gave different answers ${Math.round(medianGap / 1000)}s apart — ` +
          `too close together to be the data moving`,
      },
      volatility: "nondeterministic",
      valueVolatility,
    };
  }

  const volatility: Volatility =
    valueVolatility > 0.6 ? "live" : valueVolatility > 0.1 ? "mixed" : "stable";
  const detail =
    volatility === "stable"
      ? `${comparable} repeat request(s), all answered identically`
      : `${comparable} repeat request(s); the answer shape held, values moved ` +
        `over a median of ${Math.round(medianGap / 3_600_000)}h`;

  return { gate: { name: "procedure", result: "pass", detail }, volatility, valueVolatility };
}

/**
 * @param control rows from the customer's OTHER shapes, for the template margin.
 */
export function assess(
  shape: Shape,
  estimator: CostEstimator,
  t: Thresholds = DEFAULTS,
  control: TaskEpisode[] = [],
): Assessment {
  const stats = statsOf(shape, estimator);
  const executed = executedRows(shape.rows);
  const text = (rows: TaskEpisode[], side: "input" | "output") =>
    rows.map((r) => r[side]).filter((s): s is string => s !== undefined);

  const request = templateOutcome("template-request", text(executed, "input"), text(control, "input"), t);
  const answer = templateOutcome("template-answer", text(executed, "output"), text(control, "output"), t);
  const procedure = procedureOutcome(executed, t);

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
      // describing the failure.
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
    procedure.gate,
    // Only the request side gates. The invariance that makes work replaceable
    // lives in the ask: a price lookup has a rigid request and an answer that is
    // *supposed* to vary, and gating on the answer rejected it for doing its job.
    request.gate,
  ];

  const verdict: Verdict = gates.some((g) => g.result === "fail")
    ? "rejected"
    : gates.some((g) => g.result === "unknown")
      ? "unassessable"
      : "candidate";

  return {
    shape,
    stats,
    gates,
    signals: {
      volatility: procedure.volatility,
      valueVolatility: procedure.valueVolatility,
      answerTemplate: answer.gate,
      maskRatio: { request: request.maskRatio, answer: answer.maskRatio },
      templateMargin: { request: request.margin, answer: answer.margin },
    },
    verdict,
    projectedSavingsUsd: stats.counterfactualUsd,
  };
}

/**
 * Assess every shape, best first.
 *
 * Savings ranks but no longer gates. The point of the exercise is to find work a
 * program could do, and a scraper worth only cents in tokens can still be worth
 * writing for the reliability and the wait it removes — so a cheap candidate is
 * reported and sorted last, rather than rejected for being cheap. What it costs
 * is a fact about the shape; whether that is enough is a judgement, and the
 * person reading the table is the one making it.
 */
export function survey(shapes: Shape[], estimator: CostEstimator, t: Thresholds = DEFAULTS): Assessment[] {
  const order: Record<Verdict, number> = { candidate: 0, unassessable: 1, rejected: 2 };
  return shapes
    .map((s) => {
      // Every other shape of this customer, as the negative control.
      const control = shapes.filter((o) => o !== s && o.customerId === s.customerId).flatMap((o) => o.rows);
      return assess(s, estimator, t, control);
    })
    .sort(
      (a, b) =>
        order[a.verdict] - order[b.verdict] ||
        b.projectedSavingsUsd - a.projectedSavingsUsd ||
        b.stats.occurrences - a.stats.occurrences,
    );
}
