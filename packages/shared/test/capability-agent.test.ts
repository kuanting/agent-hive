import { describe, expect, it } from "vitest";
import {
  AgentHello,
  CapabilityRecord,
  TaskResult,
  agentLabel,
  agentName,
  describeCapability,
  isRuntimeFallback,
} from "../src/index.js";

const BASE = { runtime: "personal", tier: 3, billing: "local", skills: ["email"] } as const;

const cap = (over: Partial<CapabilityRecord>): CapabilityRecord =>
  CapabilityRecord.parse({ runtime: "opencode", tier: 3, billing: "local", ...over });

describe("agentName", () => {
  it("prefers the configured agent", () => {
    expect(agentName({ agent: "hermes", runtime: "personal" })).toBe("hermes");
  });

  it("falls back to the runtime, which is what every record did before the field existed", () => {
    expect(agentName({ runtime: "claude-code" })).toBe("claude-code");
  });
});

describe("agentLabel", () => {
  it("shows the bare agent name when it is unambiguous", () => {
    const roster = [cap({ agent: "hermes", model: "gemma4:12b" }), cap({ agent: "ollama", model: "qwen3.5:4b" })];
    expect(agentLabel(roster[0], roster)).toBe("hermes");
    expect(agentLabel(roster[1], roster)).toBe("ollama");
  });

  it("appends the model when one name covers different models", () => {
    // The company case: four OpenCode workers, and "opencode" alone tells you
    // nothing about which one you are looking at.
    const roster = [cap({ agent: "opencode", model: "gemma4:12b" }), cap({ agent: "opencode", model: "qwen3.5:4b" })];
    expect(agentLabel(roster[0], roster)).toBe("opencode/gemma4:12b");
    expect(agentLabel(roster[1], roster)).toBe("opencode/qwen3.5:4b");
  });

  it("stays bare when the same agent serves the same model twice", () => {
    // Two records differing only by seat or skills are not ambiguous to read.
    const roster = [cap({ agent: "opencode", model: "gemma4:12b" }), cap({ agent: "opencode", model: "gemma4:12b" })];
    expect(agentLabel(roster[0], roster)).toBe("opencode");
  });

  it("disambiguates tools by toolId when there is no model", () => {
    const roster = [
      cap({ runtime: "tool", tier: 4, billing: "free", toolId: "csv-report" }),
      cap({ runtime: "tool", tier: 4, billing: "free", toolId: "log-extract" }),
    ];
    expect(agentLabel(roster[0], roster)).toBe("tool [csv-report]");
  });

  it("falls back to the runtime when no agent is named", () => {
    expect(agentLabel(cap({ model: "gemma4:12b" }))).toBe("opencode");
  });
});

describe("describeCapability", () => {
  it("spells out everything, including the adapter behind a named agent", () => {
    const c = cap({ agent: "hermes", runtime: "personal", model: "gemma4:12b" });
    expect(describeCapability(c)).toBe("hermes/gemma4:12b (via personal)");
  });

  it("names the seat when a record is metered against one", () => {
    const c = cap({
      runtime: "claude-code",
      tier: 1,
      billing: "subscription",
      model: "sonnet",
      quotaWindow: { seatId: "demo-seat-1", windowSeconds: 3600, tokensPerWindow: 1000 },
    });
    expect(describeCapability(c)).toContain("seat=demo-seat-1");
  });
});

describe("wire compatibility", () => {
  it("carries `agent` across a parse", () => {
    const cap = CapabilityRecord.parse({ ...BASE, agent: "hermes" });
    expect(cap.agent).toBe("hermes");
  });

  it("does not materialise the key on a legacy record", () => {
    // zod is non-strict, so a defaulted field would silently appear on every
    // pre-existing hello and churn the worker's JSON change detection.
    const cap = CapabilityRecord.parse(BASE);
    expect("agent" in cap).toBe(false);
  });

  it("survives the hello round-trip the bus performs", () => {
    const hello = {
      kind: "agent.hello" as const,
      agentId: "personal-bee-1",
      site: "local",
      capabilities: [{ ...BASE, agent: "hermes", model: "gemma4:12b" }],
      bindsGeneral: false,
    };
    const parsed = AgentHello.parse(JSON.parse(JSON.stringify(hello)));
    expect(parsed.capabilities[0].agent).toBe("hermes");
  });

  it("keeps the owning agent and the executed runtime as separate fields", () => {
    // The pair is the whole point: equal means the bee ran what it promised,
    // different means it substituted — and the console can tell them apart.
    const result = TaskResult.parse({
      kind: "task.result",
      taskId: "t1",
      agentId: "personal-bee-1",
      customerId: "aiotlab",
      ok: true,
      output: "answer",
      tierUsed: 3,
      agent: "hermes",
      runtime: "personal-mini",
      billing: "local",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      durationMs: 5,
    });
    expect(result.agent).toBe("hermes");
    expect(result.runtime).toBe("personal-mini");
  });
});

describe("a qualified runtime is not a fallback", () => {
  it("does not flag an adapter naming the same runtime more precisely", () => {
    // The tool adapter answers `tool:csv-report` for a record whose runtime is
    // `tool`; the metered bee answers `api:openai` for `api`. Flagging these
    // would fire the substitution warning on every tool call and every API call.
    expect(isRuntimeFallback("tool", "tool:csv-report")).toBe(false);
    expect(isRuntimeFallback("api", "api:openai")).toBe(false);
    expect(isRuntimeFallback("api", "api:dry-run")).toBe(false);
  });

  it("still flags a genuinely different runtime", () => {
    expect(isRuntimeFallback("hermes", "personal-mini")).toBe(true);
    expect(isRuntimeFallback("opencode", "ollama-direct")).toBe(true);
  });

  it("says nothing when either side is unknown", () => {
    expect(isRuntimeFallback(undefined, "tool")).toBe(false);
    expect(isRuntimeFallback("tool", undefined)).toBe(false);
  });
});
