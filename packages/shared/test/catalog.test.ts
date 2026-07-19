import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { CostEstimator, loadCatalog } from "../src/index.js";

const catalogPath = join(__dirname, "..", "..", "..", "llm_model_api_catalog.yaml");

describe("catalog cost estimator", () => {
  const estimator = new CostEstimator(loadCatalog(catalogPath));

  it("loads anthropic, openai, and google models", () => {
    expect(estimator.has("claude-sonnet-4-6")).toBe(true);
    expect(estimator.has("gpt-5-nano")).toBe(true);
    expect(estimator.has("gemini-2.5-flash")).toBe(true);
  });

  it("prices claude-sonnet-4-6 at 3 in / 15 out per 1M", () => {
    expect(estimator.estimate("claude-sonnet-4-6", 1_000_000, 0)).toBeCloseTo(3.0);
    expect(estimator.estimate("claude-sonnet-4-6", 0, 1_000_000)).toBeCloseTo(15.0);
  });

  it("applies cached-input discount when the catalog has one", () => {
    // gpt-5: input 1.25, cached 0.125
    const fresh = estimator.estimate("gpt-5", 1_000_000, 0);
    const cached = estimator.estimate("gpt-5", 1_000_000, 0, 1_000_000);
    expect(fresh).toBeCloseTo(1.25);
    expect(cached).toBeCloseTo(0.125);
  });

  it("prices unknown (local) models at zero marginal USD", () => {
    expect(estimator.estimate("qwen3.5:32b", 500_000, 500_000)).toBe(0);
  });

  it("roughTokens approximates chars/4", () => {
    expect(CostEstimator.roughTokens("a".repeat(400))).toBe(100);
  });
});
