import { describe, expect, it } from "vitest";
import { AgentHello, CapabilityRecord, TaskResult, agentName } from "../src/index.js";

const BASE = { runtime: "personal", tier: 3, billing: "local", skills: ["email"] } as const;

describe("agentName", () => {
  it("prefers the configured agent", () => {
    expect(agentName({ agent: "hermes", runtime: "personal" })).toBe("hermes");
  });

  it("falls back to the runtime, which is what every record did before the field existed", () => {
    expect(agentName({ runtime: "claude-code" })).toBe("claude-code");
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
