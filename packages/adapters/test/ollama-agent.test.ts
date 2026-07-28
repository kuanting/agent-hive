import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityRecord, TaskMessage } from "@hive/shared";
import { OllamaAgentAdapter } from "../src/index.js";

const TASK = {
  kind: "task",
  taskId: "t1",
  spec: {
    customerId: "aiotlab",
    title: "Summarize",
    input: "the log",
    artifacts: [],
    skills: ["general"],
    sensitivity: "normal",
    urgency: "normal",
    dependsOn: [],
  },
  envelope: { maxUsd: 0, tier: 3, allowEscalation: true, urgency: "normal", degraded: false },
  difficulty: "standard",
} as TaskMessage;

const cap = (runtime: string): CapabilityRecord =>
  ({ runtime, tier: 3, billing: "local", model: "gemma4:12b", skills: ["general"] }) as CapabilityRecord;

/** Ollama's /api/chat answering normally. */
function stubOllama() {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ message: { content: "answer" }, prompt_eval_count: 11, eval_count: 3 }),
  }) as Response);
}

afterEach(() => vi.unstubAllGlobals());

describe("runtime: ollama", () => {
  it("reports `ollama`, not the `ollama-direct` degradation", async () => {
    // The distinction is the point: `ollama` is a host that harnessed no agent
    // and said so; `ollama-direct` is a host that meant to run one and could
    // not. Collapsing them would hide a broken install.
    stubOllama();
    const res = await new OllamaAgentAdapter().execute(TASK, cap("ollama"), "prompt");
    expect(res.ok).toBe(true);
    expect(res.runtimeUsed).toBe("ollama");
    expect(res.modelUsed).toBe("gemma4:12b");
    expect(res.output).toBe("answer");
    expect(res.output).not.toContain("unavailable");
  });

  it("still reports `ollama-direct` when a named agent binary is missing", async () => {
    // opencode is not installed in the test environment, so execFile rejects
    // and the adapter degrades — the historical path, unchanged.
    stubOllama();
    const res = await new OllamaAgentAdapter().execute(TASK, cap("opencode"), "prompt");
    expect(res.ok).toBe(true);
    expect(res.runtimeUsed).toBe("ollama-direct");
    expect(res.output).toContain("opencode unavailable");
  });

  it("is served by the same adapter as the agent runtimes", () => {
    // worker/src/index.ts asserts an adapter exists for every runtime, so a
    // value in the enum with no adapter is a crash on dispatch.
    expect(new OllamaAgentAdapter().runtimes).toContain("ollama");
  });
});
