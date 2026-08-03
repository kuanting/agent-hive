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

describe("serving a caller's own agent loop", () => {
  /** Captures the body the adapter actually sends to Ollama. */
  function captureOllama(reply: Record<string, unknown> = { message: { content: "done" } }) {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => reply } as Response;
    });
    return sent;
  }

  const withTools = (messages: unknown[]): TaskMessage =>
    ({
      ...TASK,
      passthrough: {
        messages,
        tools: [{ type: "function", function: { name: "get_weather" } }],
      },
    }) as TaskMessage;

  it("re-encodes tool arguments as an object, because a string restarts the loop", async () => {
    // The bug this fences, seen against a real gemma4: OpenAI carries
    // `arguments` as a JSON STRING and Ollama wants an OBJECT. Forwarded
    // verbatim, the model reads its own previous turn as malformed, concludes
    // the tool was never really called, and calls it again — so the second turn
    // never produces an answer and the caller's loop never terminates.
    const sent = captureOllama();
    await new OllamaAgentAdapter().execute(
      withTools([
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Taipei"}' } }],
        },
        { role: "tool", tool_call_id: "c1", content: '{"tempC":31}' },
      ]),
      cap("ollama"),
      "unused",
    );

    const messages = sent[0].messages as Array<{ tool_calls?: Array<{ function: { arguments: unknown } }> }>;
    expect(messages[1].tool_calls?.[0].function.arguments).toEqual({ city: "Taipei" });
    expect(sent[0].tools).toHaveLength(1);
  });

  it("sends the caller's conversation instead of the hive's worker-bee prompt", async () => {
    // A passthrough turn belongs to someone else's agent, with its own system
    // prompt. Prepending "you are a worker bee, return the result itself" would
    // quietly change what they asked for.
    const sent = captureOllama();
    await new OllamaAgentAdapter().execute(
      withTools([{ role: "system", content: "You are Ada." }, { role: "user", content: "hello" }]),
      cap("ollama"),
      "THE HIVE PROMPT",
    );
    const body = JSON.stringify(sent[0]);
    expect(body).not.toContain("THE HIVE PROMPT");
    expect(body).toContain("You are Ada.");
  });

  it("returns tool calls in the caller's dialect, arguments back as a string", async () => {
    captureOllama({
      message: { content: "", tool_calls: [{ function: { name: "get_weather", arguments: { city: "Taipei" } } }] },
    });
    const res = await new OllamaAgentAdapter().execute(
      withTools([{ role: "user", content: "weather?" }]),
      cap("ollama"),
      "unused",
    );
    expect(res.toolCalls?.[0].function.name).toBe("get_weather");
    expect(res.toolCalls?.[0].function.arguments).toBe('{"city":"Taipei"}');
    expect(res.finishReason).toBe("tool_calls");
  });

  it("goes straight to the model even when the record names an agent harness", async () => {
    // `opencode run` runs its OWN loop with its own tools and returns prose;
    // there is no way to ask it which of the CALLER's tools to call next.
    const sent = captureOllama();
    const res = await new OllamaAgentAdapter().execute(
      withTools([{ role: "user", content: "hi" }]),
      cap("opencode"),
      "unused",
    );
    expect(sent).toHaveLength(1);
    expect(res.runtimeUsed).toBe("ollama-chat");
  });
});
