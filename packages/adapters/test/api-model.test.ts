import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityRecord, TaskMessage } from "@hive/shared";
import { ApiModelAdapter, apiCapabilityReady, resolveProvider } from "../src/index.js";

const TASK = {} as TaskMessage;

function cap(model: string): CapabilityRecord {
  return { runtime: "api", tier: 2, billing: "per-token", model, skills: ["general"] };
}

/** Stub global fetch, capturing the request the adapter made. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  return calls;
}

const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "HIVE_API_DRYRUN"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe("provider resolution", () => {
  it("maps model ids to providers", () => {
    expect(resolveProvider("gpt-5-mini")).toBe("openai");
    expect(resolveProvider("gpt-5.5-pro")).toBe("openai");
    expect(resolveProvider("o3")).toBe("openai");
    expect(resolveProvider("claude-opus-4-6")).toBe("anthropic");
    expect(resolveProvider("gemini-3-flash-preview")).toBe("google");
    expect(resolveProvider("llama3")).toBeUndefined();
  });

  it("reports an api capability unready when its key is missing", () => {
    expect(apiCapabilityReady("gpt-5-mini")).toEqual({ ok: false, reason: "OPENAI_API_KEY not set" });
    process.env.OPENAI_API_KEY = "sk-test";
    expect(apiCapabilityReady("gpt-5-mini")).toEqual({ ok: true });
  });

  it("accepts GOOGLE_API_KEY as an alias for GEMINI_API_KEY", () => {
    process.env.GOOGLE_API_KEY = "g-test";
    expect(apiCapabilityReady("gemini-3-flash-preview")).toEqual({ ok: true });
  });

  it("refuses a model no provider claims", () => {
    const res = apiCapabilityReady("mystery-model-9");
    expect(res.ok).toBe(false);
  });
});

describe("execution", () => {
  it("calls OpenAI and parses usage", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const calls = stubFetch({
      choices: [{ message: { content: "openai says hi" } }],
      usage: { prompt_tokens: 120, completion_tokens: 34 },
    });

    const res = await new ApiModelAdapter().execute(TASK, cap("gpt-5-mini"), "a prompt");

    expect(res.ok).toBe(true);
    expect(res.output).toBe("openai says hi");
    expect(res.inputTokens).toBe(120);
    expect(res.outputTokens).toBe(34);
    expect(res.runtimeUsed).toBe("api:openai");
    // The worker prices this from the catalog; the adapter must not claim a cost.
    expect(res.reportedUsd).toBeUndefined();

    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    const sent = JSON.parse(String(calls[0].init.body));
    // gpt-5 family rejects max_tokens
    expect(sent.max_completion_tokens).toBeDefined();
    expect(sent.max_tokens).toBeUndefined();
  });

  it("uses max_tokens for older OpenAI models", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const calls = stubFetch({ choices: [{ message: { content: "x" } }], usage: {} });
    await new ApiModelAdapter().execute(TASK, cap("gpt-4o-mini"), "p");
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.max_tokens).toBeDefined();
    expect(sent.max_completion_tokens).toBeUndefined();
  });

  it("calls Anthropic and joins text blocks", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const calls = stubFetch({
      content: [
        { type: "text", text: "part one " },
        { type: "text", text: "part two" },
      ],
      usage: { input_tokens: 200, output_tokens: 50 },
    });

    const res = await new ApiModelAdapter().execute(TASK, cap("claude-opus-4-6"), "a prompt");

    expect(res.output).toBe("part one part two");
    expect(res.inputTokens).toBe(200);
    expect(res.outputTokens).toBe(50);
    expect(res.runtimeUsed).toBe("api:anthropic");
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("calls Google and parses usageMetadata", async () => {
    process.env.GEMINI_API_KEY = "g-test";
    const calls = stubFetch({
      candidates: [{ content: { parts: [{ text: "gemini says hi" }] } }],
      usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 12 },
    });

    const res = await new ApiModelAdapter().execute(TASK, cap("gemini-3-flash-preview"), "a prompt");

    expect(res.output).toBe("gemini says hi");
    expect(res.inputTokens).toBe(90);
    expect(res.outputTokens).toBe(12);
    expect(res.runtimeUsed).toBe("api:google");
    expect(calls[0].url).toContain("/models/gemini-3-flash-preview:generateContent");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-test");
  });

  it("fails cleanly when the key is missing, without calling out", async () => {
    const calls = stubFetch({});
    const res = await new ApiModelAdapter().execute(TASK, cap("gpt-5-mini"), "p");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("OPENAI_API_KEY not set");
    expect(calls).toHaveLength(0);
  });

  it("surfaces an API error as a failed result rather than throwing", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stubFetch({ error: "rate limited" }, false, 429);
    const res = await new ApiModelAdapter().execute(TASK, cap("gpt-5-mini"), "p");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("429");
    expect(res.inputTokens).toBe(0);
  });

  it("dry-run skips the network but still reports usable token counts", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.HIVE_API_DRYRUN = "1";
    const calls = stubFetch({});

    const res = await new ApiModelAdapter().execute(TASK, cap("gpt-5-mini"), "x".repeat(400));

    expect(calls).toHaveLength(0);
    expect(res.ok).toBe(true);
    expect(res.runtimeUsed).toBe("api:dry-run");
    expect(res.output).toContain("dry-run");
    // Realistic counts are the point: the ledger and budget guard must still move.
    expect(res.inputTokens).toBe(100); // 400 chars / 4
    expect(res.outputTokens).toBeGreaterThan(0);
  });
});
