import { describe, expect, it } from "vitest";
import { PlannedTask } from "../src/planner/types.js";
import { clarifyInsteadOfSpending } from "../src/planner/index.js";

/**
 * The third deterministic check on the planner, beside urgency and sensitivity.
 *
 * `clarify` rested entirely on the planner model's own judgment, which is the one
 * instruction a small local model is least reliable about — it would rather emit
 * a plan than admit the request was too thin to plan. That asymmetry is not
 * symmetric in cost: a vague request that scores `complex` routes to tier 1 or 2,
 * so the failure mode is a frontier seat spent on a sentence fragment.
 */

function task(over: Partial<PlannedTask> = {}): PlannedTask {
  return PlannedTask.parse({ key: "t1", title: "do the thing", input: "do the thing", ...over });
}

/** Long and involved enough that scoreDifficulty calls it complex. */
const COMPLEX_TITLE =
  "design and implement a multi-stage refactor of the ingest pipeline, then migrate the historical archive";

describe("a thin brief is not worth a frontier seat", () => {
  it("asks instead of spending when the work is expensive AND the brief is thin", () => {
    const question = clarifyInsteadOfSpending([task({ title: COMPLEX_TITLE, input: COMPLEX_TITLE })], "aiotlab");
    expect(question).toBeDefined();
    // The question has to name what is missing, or it just costs the user a turn.
    expect(question).toContain(COMPLEX_TITLE);
  });

  it("proceeds when an expensive task actually has a brief", () => {
    const detailed = task({
      title: COMPLEX_TITLE,
      input:
        "Split ingest into fetch/normalize/load stages. Keep the existing CSV contract for downstream " +
        "consumers, migrate the 2019-2024 archive in batches of 10k rows, and verify row counts per batch.",
    });
    expect(clarifyInsteadOfSpending([detailed], "aiotlab")).toBeUndefined();
  });

  it("proceeds on a short but cheap task, which is the common case", () => {
    // "restart the pump logger" is thin and perfectly actionable — this is a spend
    // guard, not a quality filter, so it must not fire here.
    expect(clarifyInsteadOfSpending([task({ title: "restart logger", input: "restart the pump logger" })], "aiotlab"))
      .toBeUndefined();
  });

  it("catches the case where input is just the title again", () => {
    // What a planner emits when it had nothing to work with.
    const echo = task({ title: COMPLEX_TITLE, input: `  ${COMPLEX_TITLE.toUpperCase()}  ` });
    expect(clarifyInsteadOfSpending([echo], "aiotlab")).toBeDefined();
  });

  it("fires on the thin task in a mixed plan, and names only that one", () => {
    const fine = task({
      key: "t1",
      title: COMPLEX_TITLE,
      input: "Rewrite the loader against the new schema, keeping the CSV contract and verifying counts per batch.",
    });
    const thin = task({ key: "t2", title: `${COMPLEX_TITLE} again`, input: "and the rest" });
    const question = clarifyInsteadOfSpending([fine, thin], "aiotlab");
    expect(question).toBeDefined();
    expect(question).toContain(`${COMPLEX_TITLE} again`);
    expect(question).not.toContain(`"${COMPLEX_TITLE}"`);
  });

  it("says nothing about an empty plan", () => {
    expect(clarifyInsteadOfSpending([], "aiotlab")).toBeUndefined();
  });
});
