import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityRecord, TaskMessage } from "@hive/shared";
import { PersonalAgentAdapter } from "../src/index.js";

let dataDir: string;
let emptyPath: string;
let origPath: string | undefined;

const CAP: CapabilityRecord = {
  runtime: "personal",
  tier: 3,
  billing: "local",
  model: "qwen3:8b",
  skills: ["email", "daily-report"],
};

function task(): TaskMessage {
  return {
    kind: "task",
    taskId: "t1",
    spec: {
      customerId: "aiotlab",
      title: "Summarize my inbox about the yield model",
      input: "What's the current accuracy?",
      artifacts: [],
      skills: ["email"],
      sensitivity: "confidential",
      urgency: "normal",
      dependsOn: [],
    },
    envelope: { maxUsd: 0, tier: 3, allowEscalation: true, urgency: "normal", degraded: false },
    difficulty: "standard",
  } as TaskMessage;
}

interface Call {
  url: string;
  body: unknown;
}

/** Route fetch by URL; record chat calls so we can inspect the prompt sent. */
function stubFetch(opts: { openclaw?: boolean }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("/v1/models")) {
      if (opts.openclaw) return { ok: true, status: 200, json: async () => ({}) } as Response;
      throw new Error("connection refused");
    }
    if (url.includes("/v1/chat/completions")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "openclaw answer" } }],
          usage: { prompt_tokens: 42, completion_tokens: 7 },
        }),
      } as Response;
    }
    if (url.includes("/api/chat")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { content: "mini answer" }, prompt_eval_count: 30, eval_count: 9 }),
      } as Response;
    }
    if (url.includes("/api/tags")) {
      return { ok: true, status: 200, json: async () => ({ models: [{ name: "qwen3:8b" }] }) } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "personal-data-"));
  mkdirSync(join(dataDir, "documents"));
  writeFileSync(
    join(dataDir, "mailbox.json"),
    JSON.stringify({ messages: [{ id: "1", from: "prof@x", subject: "Yield model", body: "accuracy is 0.912" }] }),
  );
  writeFileSync(join(dataDir, "documents", "status.md"), "yield model validation accuracy 0.912");
  // Empty PATH so `hermes` is deterministically absent unless a test adds it.
  emptyPath = mkdtempSync(join(tmpdir(), "empty-path-"));
  origPath = process.env.PATH;
  process.env.PATH = emptyPath;
});

afterEach(() => {
  process.env.PATH = origPath;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(emptyPath, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.PERSONAL_TOOL_LOOP;
});

describe("backend selection", () => {
  it("uses the OpenClaw gateway when it answers", async () => {
    const calls = stubFetch({ openclaw: true });
    const res = await new PersonalAgentAdapter({ dataDir }).execute(task(), CAP, "prompt");
    expect(res.ok).toBe(true);
    expect(res.runtimeUsed).toBe("openclaw");
    expect(res.output).toBe("openclaw answer");
    // OpenClaw is still handed the grounded local context in the system message.
    const chat = calls.find((c) => c.url.includes("/v1/chat/completions"));
    const system = (chat!.body as { messages: Array<{ role: string; content: string }> }).messages[0];
    expect(system.content).toContain("0.912");
  });

  it("falls back to the built-in mini agent when no external runtime exists", async () => {
    const calls = stubFetch({ openclaw: false });
    const res = await new PersonalAgentAdapter({ dataDir }).execute(task(), CAP, "prompt");
    expect(res.ok).toBe(true);
    expect(res.runtimeUsed).toBe("personal-mini");
    expect(res.output).toBe("mini answer");
    expect(res.inputTokens).toBe(30);
    expect(res.outputTokens).toBe(9);
    // The mini agent prefetches real local data into the prompt it sends Ollama.
    const chat = calls.find((c) => c.url.includes("/api/chat"));
    const system = (chat!.body as { messages: Array<{ role: string; content: string }> }).messages[0];
    expect(system.content).toContain("0.912");
    expect(system.content).toContain("Yield model");
  });
});
