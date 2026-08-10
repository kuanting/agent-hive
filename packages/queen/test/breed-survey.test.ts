import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { CostEstimator, loadCatalog } from "@hive/shared";
import type { EpisodeAttempt, TaskEpisode } from "../src/episode.js";
import { buildCorpus, parseSince } from "../src/breed/corpus.js";
import { assess, survey, DEFAULTS, FRONTIER } from "../src/breed/detect.js";

/**
 * The survey has to be right about two things that pull against each other: it
 * must find real repetition at the fidelity hives actually run at (`metadata`,
 * where there is no task text at all), and it must never claim to have checked
 * something it could not see.
 */

const REPO = resolve(import.meta.dirname, "../../..");
const estimator = new CostEstimator(loadCatalog(join(REPO, "llm_model_api_catalog.yaml")));

const attempt = (over: Partial<EpisodeAttempt> = {}): EpisodeAttempt => ({
  attempt: 1,
  tier: 3,
  runtime: "hermes",
  ok: true,
  degraded: false,
  // Sized so a 20-occurrence shape clears the $1 default at frontier rates
  // ($5/M in, $25/M out): 20 x 12k in + 20 x 2.4k out = $2.40.
  inputTokens: 12_000,
  outputTokens: 2_400,
  costUsd: 0, // local: the whole reason ranking cannot use observed spend
  durationMs: 1500,
  ...over,
});

let seq = 0;
function row(over: Partial<TaskEpisode> = {}): TaskEpisode {
  seq += 1;
  return {
    taskId: `t${seq}`,
    customerId: "aiotlab",
    at: 1_000_000 + seq * 1000,
    mode: "metadata",
    skills: ["reporting"],
    difficulty: "standard",
    toolInputKeys: ["csv"],
    artifactCount: 0,
    attempts: [attempt()],
    ok: true,
    wallMs: 1500,
    ...over,
  };
}

/** The same shape, N times. */
const many = (n: number, over: Partial<TaskEpisode> = {}) => Array.from({ length: n }, () => row(over));

describe("grouping rows into shapes", () => {
  it("groups identical structure together and different structure apart", () => {
    const c = buildCorpus([...many(3), ...many(2, { skills: ["ops"] })]);
    expect(c.shapes).toHaveLength(2);
    expect(c.shapes[0].rows).toHaveLength(3);
    expect(c.shapes[0].skills).toEqual(["reporting"]);
  });

  it("separates shapes that differ only by which toolInput keys were present", () => {
    // This is the distinction that decides whether a task can reach tier 4 at
    // all, so it must not be smoothed away.
    const c = buildCorpus([...many(3), ...many(3, { toolInputKeys: ["pattern"] })]);
    expect(c.shapes).toHaveLength(2);
  });

  it("works with no task text at all, which is the default fidelity", () => {
    const c = buildCorpus(many(5));
    expect(c.basis).toBe("structural");
    expect(c.rowsWithText).toBe(0);
    expect(c.shapes).toHaveLength(1);
  });

  it("uses titles to tell apart work that is structurally identical", () => {
    // "summarize this csv" and "write a paragraph about the trend" are both
    // reporting/standard with no toolInput, and are not the same job.
    const full = { mode: "full" as const, input: "i", output: "o" };
    const c = buildCorpus([
      ...many(3, { ...full, title: "roll up the sales csv" }),
      ...many(3, { ...full, title: "write a paragraph about the trend" }),
    ]);
    expect(c.basis).toBe("structural+title");
    expect(c.shapes).toHaveLength(2);
  });

  it("is not dragged down to the coarse basis by a handful of text-free rows", () => {
    // The bug: the basis required EVERY row to carry text, so one row without a
    // title dropped the whole corpus — however large — to structural. A rule that
    // one row in twenty thousand can veto is not a rule.
    const full = { mode: "full" as const, title: "roll up the sales csv", input: "i", output: "o" };
    const c = buildCorpus([...many(19, full), ...many(1)]);
    expect(c.basis).toBe("structural+title");
    // The row that cannot be placed on this basis is excluded rather than hashed
    // as though its title were empty, which would collide it with every other
    // text-free row in the corpus.
    expect(c.shapes.reduce((n, s) => n + s.rows.length, 0)).toBe(19);
    expect(c.rowsRead).toBe(20);
  });

  it("falls back to the coarse basis when most rows have no text", () => {
    // The other direction, and the original reason the basis is chosen once: a
    // fine basis that describes a minority mis-sorts everyone else.
    const full = { mode: "full" as const, title: "roll up the sales csv", input: "i", output: "o" };
    const c = buildCorpus([...many(3, full), ...many(7)]);
    expect(c.basis).toBe("structural");
    expect(c.shapes.reduce((n, s) => n + s.rows.length, 0)).toBe(10);
  });

  it("never lets confidential work into the corpus, and says how much it withheld", () => {
    // The ratchet already strips the text, but the row still counted — inflating
    // occurrences with work no recommendation may be built from.
    const full = { mode: "full" as const, title: "roll up the sales csv", input: "i", output: "o" };
    const c = buildCorpus([...many(10, full), ...many(4, { ...full, sensitivity: "confidential" })]);
    expect(c.withheldRows).toBe(4);
    expect(c.shapes.reduce((n, s) => n + s.rows.length, 0)).toBe(10);
  });

  it("withholds a row the ratchet downgraded, not just one still labelled confidential", () => {
    // By the time a row reaches disk its `sensitivity` may be gone; the reason
    // the ratchet wrote is what remains.
    const c = buildCorpus(many(4, { downgradedReason: "task was confidential" }));
    expect(c.withheldRows).toBe(4);
    expect(c.shapes).toHaveLength(0);
  });
});

describe("candidate gates", () => {
  const shapeOf = (rows: TaskEpisode[]) => buildCorpus(rows).shapes[0];

  it("rejects a shape that has not recurred often enough", () => {
    const a = assess(shapeOf(many(3)), estimator);
    expect(a.verdict).toBe("rejected");
    expect(a.gates.find((g) => g.name === "frequency")?.result).toBe("fail");
  });

  it("rejects a shape the hive itself gets wrong", () => {
    // You cannot write a spec from work that failed; the corpus would be
    // teaching the bee to reproduce the failure.
    const rows = [...many(12), ...many(6, { ok: false })];
    const a = assess(shapeOf(rows), estimator);
    expect(a.gates.find((g) => g.name === "reliability")?.result).toBe("fail");
    expect(a.verdict).toBe("rejected");
  });

  it("rejects a shape that routinely needs the escalation ladder", () => {
    const rows = many(14, { attempts: [attempt({ ok: false }), attempt({ attempt: 2, tier: 1 })] });
    const a = assess(shapeOf(rows), estimator);
    expect(a.gates.find((g) => g.name === "first-attempt")?.result).toBe("fail");
  });

  it("reports the content gates as unknown rather than passing them, at metadata", () => {
    const a = assess(shapeOf(many(20)), estimator);
    // Everything measurable passes...
    expect(a.gates.find((g) => g.name === "frequency")?.result).toBe("pass");
    expect(a.gates.find((g) => g.name === "reliability")?.result).toBe("pass");
    // ...and the two that need task text say so, instead of quietly counting as
    // checked. A shape nobody could verify must not read as a candidate.
    expect(a.gates.find((g) => g.name === "procedure")?.result).toBe("unknown");
    expect(a.gates.find((g) => g.name === "template-request")?.result).toBe("unknown");
    expect(a.verdict).toBe("unassessable");
  });

  it("passes every gate when the text is recorded and the work is mechanical", () => {
    const rows = many(20, {
      mode: "full",
      title: "roll up the sales csv",
      input: "rows: a,b",
      output: "rows: 12\ncolumns: 2 (a, b)",
    });
    const a = assess(buildCorpus(rows).shapes[0], estimator);
    expect(a.gates.filter((g) => g.result !== "pass")).toEqual([]);
    expect(a.verdict).toBe("candidate");
  });

  it("rejects two different answers to one request seconds apart", () => {
    // Neither the procedure nor the data is stable here. `many()` steps `at` by a
    // second, so these asks are far too close together for "the data moved".
    const base = { mode: "full" as const, title: "t", input: "same input" };
    const rows = [...many(10, { ...base, output: "answer A" }), ...many(10, { ...base, output: "answer B entirely" })];
    const a = assess(buildCorpus(rows).shapes[0], estimator);
    expect(a.gates.find((g) => g.name === "procedure")?.result).toBe("fail");
    expect(a.signals.volatility).toBe("unstable-procedure");
    expect(a.verdict).toBe("rejected");
  });

  it("keeps real prose out — different answers that share no skeleton", () => {
    // English sentences with no part codes or figures in them, so masking has
    // nothing to remove and the answers stay as different as they are.
    const answers = [
      "The trend shows a gradual improvement across the quarter",
      "Yield has been broadly flat with occasional unexplained dips",
      "Throughput improved once the second line came back online",
      "Nothing conclusive; the variance swamps any underlying signal",
    ];
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ mode: "full", title: "t", input: "explain the trend", output: answers[i % answers.length] }),
    );
    const a = assess(buildCorpus(rows).shapes[0], estimator);
    expect(a.gates.find((g) => g.name === "procedure")?.result).toBe("fail");
    expect(a.signals.volatility).toBe("unstable-procedure");
    expect(a.verdict).toBe("rejected");
  });

  it("refuses to call it stable when masking left no words to agree on", () => {
    // Masking can manufacture the very agreement the procedure gate looks for:
    // answers made entirely of part-code-shaped tokens all collapse to the same
    // row of placeholders, however unrelated they were. Found by running the
    // survey on a corpus where it let prose through as a candidate.
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ mode: "full", title: "t", input: `lookup ${i}`, output: `zulu${i} yankee${i} xray${i}` }),
    );
    const a = assess(buildCorpus(rows).shapes[0], estimator);
    expect(a.gates.find((g) => g.name === "procedure")?.result).toBe("unknown");
    expect(a.verdict).toBe("unassessable");
  });

});

describe("the shapes this feature exists to find", () => {
  /** Prices drift over a month; the part number is the only thing the caller changes. */
  const digikey = (i: number) =>
    row({
      mode: "full",
      title: "digikey price lookup",
      input: `get me the digikey price for ${["LM358N", "ATMEGA328P-PU", "NE555P", "RC0402FR-0710KL"][i % 4]}`,
      output: `${["LM358N", "ATMEGA328P-PU", "NE555P", "RC0402FR-0710KL"][i % 4]}: $${(1 + (i % 7) * 0.31).toFixed(2)}, stock ${400 + i * 13}`,
      at: 1_000_000 + i * 6 * 3_600_000, // six hours apart: real traffic, not a retry storm
      skills: ["sourcing"],
    });

  /** A form filed into a database. The answer is an acknowledgement, not data. */
  const dailyReport = (i: number) =>
    row({
      mode: "full",
      title: "file the daily report",
      input: `file today's report: yield 9${i % 10}.2%, scrap ${3 + (i % 5)}, line A`,
      output: "saved",
      at: 2_000_000 + i * 24 * 3_600_000,
      skills: ["reporting"],
    });

  it("finds a live price lookup, whose answer is meant to change", () => {
    const rows = Array.from({ length: 40 }, (_, i) => digikey(i));
    const a = assess(buildCorpus(rows).shapes[0], estimator);

    // The steps are fixed even though the numbers are not.
    expect(a.gates.find((g) => g.name === "procedure")?.result).toBe("pass");
    expect(a.gates.find((g) => g.name === "template-request")?.result).toBe("pass");
    expect(a.signals.volatility).toBe("live");
    // The answer template is expected to be unjudgeable or fail here — it is a
    // signal precisely so that doing its job cannot disqualify the shape.
    expect(a.gates.map((g) => g.name)).not.toContain("template-answer");
    expect(a.verdict).toBe("candidate");
  });

  it("finds a form being filed, whose answer never changes", () => {
    const rows = Array.from({ length: 30 }, (_, i) => dailyReport(i));
    const a = assess(buildCorpus(rows).shapes[0], estimator);

    expect(a.gates.find((g) => g.name === "procedure")?.result).toBe("pass");
    expect(a.gates.find((g) => g.name === "template-request")?.result).toBe("pass");
    expect(a.signals.volatility).toBe("stable");
    // A bare acknowledgement must not trip the mask-ratio ceiling: there is
    // nothing in it to mask.
    expect(a.signals.maskRatio.answer).toBeLessThan(0.35);
    expect(a.signals.answerTemplate.result).toBe("pass");
    expect(a.verdict).toBe("candidate");
  });

  it("tells the two apart by how much the values moved", () => {
    const live = assess(buildCorpus(Array.from({ length: 40 }, (_, i) => digikey(i))).shapes[0], estimator);
    const fixed = assess(buildCorpus(Array.from({ length: 30 }, (_, i) => dailyReport(i))).shapes[0], estimator);
    expect(live.signals.valueVolatility).toBeGreaterThan(fixed.signals.valueVolatility);
    expect(fixed.signals.valueVolatility).toBe(0);
  });
});

describe("valuing a shape", () => {
  it("ranks on the counterfactual, because local work reports zero", () => {
    const a = assess(buildCorpus(many(20)).shapes[0], estimator);
    // Observed spend is genuinely $0 — every attempt ran locally. Ranking on it
    // would find nothing worth breeding anywhere on a solo hive.
    expect(a.stats.observedUsd).toBe(0);
    expect(a.projectedSavingsUsd).toBeGreaterThan(0);
    expect(a.projectedSavingsUsd).toBeCloseTo(estimator.estimate(FRONTIER, 20 * 12_000, 20 * 2_400), 6);
  });

  it("prices every attempt, since a bee replaces the whole escalation ladder", () => {
    const one = assess(buildCorpus(many(12)).shapes[0], estimator).projectedSavingsUsd;
    const two = assess(
      buildCorpus(many(12, { attempts: [attempt({ ok: false }), attempt({ attempt: 2 })] })).shapes[0],
      estimator,
    ).projectedSavingsUsd;
    expect(two).toBeCloseTo(one * 2, 6);
  });

  it("counts a cache hit as a recurrence but not as a saving", () => {
    const rows = [...many(10), ...many(10, { cached: true, attempts: [] })];
    const a = assess(buildCorpus(rows).shapes[0], estimator);
    // The shape recurred twenty times — that is the evidence a program is worth
    // writing, and it is why the row is recorded at all.
    expect(a.stats.occurrences).toBe(20);
    expect(a.stats.cached).toBe(10);
    // But a cached answer already cost nothing, so replacing it saves nothing.
    expect(a.projectedSavingsUsd).toBeCloseTo(estimator.estimate(FRONTIER, 10 * 12_000, 10 * 2_400), 6);
  });

  it("reports a cheap shape rather than rejecting it for being cheap", () => {
    // Savings ranks; it no longer gates. A scraper worth cents in tokens can
    // still be worth writing for the wait and the retries it removes, and that
    // judgement belongs to the person reading the table.
    const cheap = many(20, {
      mode: "full",
      title: "t",
      input: "same ask",
      output: "same answer",
      attempts: [attempt({ inputTokens: 10, outputTokens: 2 })],
    });
    const a = assess(buildCorpus(cheap).shapes[0], estimator);
    expect(a.gates.map((g) => g.name)).not.toContain("savings");
    expect(a.projectedSavingsUsd).toBeLessThan(0.01);
    expect(a.verdict).toBe("candidate");
  });

  it("orders candidates ahead of unassessable ahead of rejected, then by savings", () => {
    const rich = { mode: "full" as const, title: "big csv rollup", input: "i", output: "rows: 12 columns: 2" };
    const rows = [
      ...many(20, rich),
      ...many(20, { skills: ["ops"] }),
      ...many(2, { skills: ["email"] }),
    ];
    const ranked = survey(buildCorpus(rows).shapes, estimator, DEFAULTS);
    expect(ranked.map((r) => r.verdict)).toEqual(["candidate", "unassessable", "rejected"]);
  });
});

describe("--since", () => {
  it("parses the windows the CLI documents, and refuses the ones it does not", () => {
    expect(parseSince("30d", 100_000_000)).toBe(100_000_000 - 30 * 86_400_000);
    expect(parseSince("12h", 100_000_000)).toBe(100_000_000 - 12 * 3_600_000);
    expect(parseSince(undefined, 1)).toBeUndefined();
    expect(() => parseSince("last tuesday", 1)).toThrow(/unrecognized/);
  });
});
