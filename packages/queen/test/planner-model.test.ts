import { afterEach, describe, expect, it, vi } from "vitest";
import { PlannerModel, checkPlannerModel } from "../src/planner/model.js";

/** Collect the warn/info lines a check emits so we can assert on the text. */
function recorder() {
  const warns: string[] = [];
  const infos: string[] = [];
  return { warns, infos, warn: (m: string) => warns.push(m), info: (m: string) => infos.push(m) };
}

function stubTags(names: string[]) {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ models: names.map((name) => ({ name })) }),
  }) as Response);
}

afterEach(() => vi.unstubAllGlobals());

describe("planner model startup check", () => {
  it("confirms a model that is installed", async () => {
    stubTags(["gemma4:12b", "qwen3.5:4b"]);
    const r = recorder();
    expect(await checkPlannerModel("gemma4:12b", r.warn, r.info)).toBe(true);
    expect(r.warns).toEqual([]);
    expect(r.infos.join("\n")).toContain("gemma4:12b ready");
  });

  it("treats a bare name as :latest, the way Ollama reports it", async () => {
    stubTags(["qwen3.5:latest"]);
    const r = recorder();
    expect(await checkPlannerModel("qwen3.5", r.warn, r.info)).toBe(true);
  });

  it("warns loudly, names the alternatives, and does NOT substitute one", async () => {
    // The whole point of the check: the Queen's plan sets every task's skills,
    // urgency and confidentiality, so an operator must choose the model. A
    // worker may degrade to what exists; the planner may not.
    stubTags(["gpt-oss:20b", "gemma4:12b"]);
    const r = recorder();
    expect(await checkPlannerModel("gemma3:4b", r.warn, r.info)).toBe(false);
    const text = r.warns.join("\n");
    expect(text).toContain("WARNING");
    expect(text).toContain("'gemma3:4b' is NOT installed");
    expect(text).toContain("does not substitute");
    expect(text).toContain("gpt-oss:20b, gemma4:12b"); // what it could have been set to
    expect(text).toContain("HIVE_PLANNER_MODEL");
    expect(r.infos).toEqual([]); // never reports "ready" when it is not
  });

  it("warns about the daemon, not the model, when Ollama is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection refused");
    });
    const r = recorder();
    expect(await checkPlannerModel("gemma4:12b", r.warn, r.info)).toBe(false);
    const text = r.warns.join("\n");
    expect(text).toContain("cannot reach the Ollama daemon");
    expect(text).toContain("OLLAMA_URL");
  });

  it("reports an error status from the daemon as unreachable", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    const r = recorder();
    expect(await checkPlannerModel("gemma4:12b", r.warn, r.info)).toBe(false);
  });
});

describe("planner degradation is announced", () => {
  it("warns on the console when the planning call fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection refused");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const planner = new PlannerModel(() => 0);
    const turn = await planner.plan([{ role: "user", content: "summarize the yield data" }], { skills: [], tools: [] }, false);

    expect(turn.degraded).toBe(true);
    expect(turn.modelUsed).toContain("(unavailable)");
    // A degraded turn is visible to whoever is chatting, but only an operator
    // reading the logs can fix it.
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("WARNING");
    expect(said).toContain("UNPLANNED");
    expect(said).toContain("No substitute model");
    warn.mockRestore();
  });
});
