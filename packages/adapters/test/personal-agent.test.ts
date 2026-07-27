import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityRecord, TaskMessage } from "@hive/shared";
import { PersonalAgentAdapter, hermesArgs, hermesCmd, openclawUp } from "../src/index.js";

let dataDir: string;
let emptyPath: string;
let origPath: string | undefined;

const CAP: CapabilityRecord = {
  runtime: "personal",
  tier: 3,
  billing: "local",
  model: "qwen3.5:4b",
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
      // Only a JSON reply counts as a gateway (a control UI answers HTML), so
      // the stub carries the content-type a real one would.
      if (opts.openclaw) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ data: [{ id: "qwen3.5:4b" }] }),
        } as Response;
      }
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
      return { ok: true, status: 200, json: async () => ({ models: [{ name: "qwen3.5:4b" }] }) } as Response;
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

describe("configured agent", () => {
  /** Put a real `hermes` shim on PATH so hermesOnPath() finds one. */
  function withHermes(stdout = "hermes answer") {
    const dir = mkdtempSync(join(tmpdir(), "agent-path-"));
    const shim = join(dir, "hermes");
    writeFileSync(shim, `#!/bin/sh\nprintf '%s' '${stdout}'\n`);
    chmodSync(shim, 0o755);
    process.env.PATH = dir;
    return dir;
  }

  it("puts the named agent at the head of the chain, ahead of OpenClaw", async () => {
    // OpenClaw answers and would win by default; naming hermes reorders the
    // chain, which is the whole point of configuring an agent.
    stubFetch({ openclaw: true });
    withHermes();
    const cap = { ...CAP, agent: "hermes" };
    const res = await new PersonalAgentAdapter({ dataDir }).execute(task(), cap, "prompt");
    expect(res.runtimeUsed).toBe("hermes");
    expect(res.output).toBe("hermes answer");
  });

  it("falls back when the named agent is missing, and says so in the output", async () => {
    // Decision the config documents: a preference, not a pin. The task still
    // gets answered — but a bee that promised hermes must not look like it ran
    // hermes.
    stubFetch({ openclaw: false }); // PATH is the empty dir from beforeEach
    const cap = { ...CAP, agent: "hermes" };
    const res = await new PersonalAgentAdapter({ dataDir }).execute(task(), cap, "prompt");
    expect(res.ok).toBe(true);
    expect(res.runtimeUsed).toBe("personal-mini");
    expect(res.output).toContain("hermes preferred but unavailable");
  });

  it("names a typo'd agent rather than silently using the default chain", async () => {
    stubFetch({ openclaw: false });
    const cap = { ...CAP, agent: "hermez" };
    const res = await new PersonalAgentAdapter({ dataDir }).execute(task(), cap, "prompt");
    expect(res.runtimeUsed).toBe("personal-mini");
    expect(res.output).toContain('unknown agent "hermez"');
  });

  it("keeps the historical chain when no agent is configured", async () => {
    stubFetch({ openclaw: true });
    withHermes();
    const res = await new PersonalAgentAdapter({ dataDir }).execute(task(), CAP, "prompt");
    expect(res.runtimeUsed).toBe("openclaw"); // openclaw still leads
  });
});

describe("openclaw probe", () => {
  /** Reply with an arbitrary status/content-type for /v1/models. */
  function stubModels(status: number, contentType: string, body: string) {
    vi.stubGlobal("fetch", async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ "content-type": contentType }),
      json: async () => JSON.parse(body),
      text: async () => body,
    }) as Response);
  }

  it("rejects the control UI answering HTML on the gateway port", async () => {
    // OpenClaw's SPA returns 200 text/html for any GET path, /v1/models
    // included. Counting that as a gateway puts a backend with no chat surface
    // at the head of the chain, which silently shadows Hermes.
    stubModels(200, "text/html; charset=utf-8", "<!doctype html>");
    expect(await openclawUp()).toBe(false);
  });

  it("accepts an OpenAI-compatible JSON model list", async () => {
    stubModels(200, "application/json", JSON.stringify({ data: [{ id: "qwen3.5:4b" }] }));
    expect(await openclawUp()).toBe(true);
  });

  it("rejects an error status", async () => {
    stubModels(404, "application/json", "{}");
    expect(await openclawUp()).toBe(false);
  });
});

describe("hermes invocation", () => {
  afterEach(() => {
    delete process.env.HERMES_CMD;
    delete process.env.HERMES_PROVIDER;
  });

  it("uses the non-interactive quiet chat surface", () => {
    // `hermes run` does not exist; `chat -q` is the one-shot form and -Q keeps
    // stdout to the answer alone so the adapter can capture it.
    expect(hermesArgs("say hi", "qwen3.5:4b")).toEqual([
      "chat",
      "-q",
      "say hi",
      "-m",
      "qwen3.5:4b",
      "-Q",
      "--provider",
      "ollama",
    ]);
  });

  it("honours HERMES_PROVIDER and HERMES_CMD", () => {
    process.env.HERMES_PROVIDER = "auto";
    process.env.HERMES_CMD = "/opt/hermes/bin/hermes";
    expect(hermesArgs("q", "m")).toContain("auto");
    expect(hermesCmd()).toBe("/opt/hermes/bin/hermes");
  });

  it("leaves the provider to Hermes when HERMES_PROVIDER is empty", () => {
    process.env.HERMES_PROVIDER = "";
    expect(hermesArgs("q", "m")).not.toContain("--provider");
  });
});
