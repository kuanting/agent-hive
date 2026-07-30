import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityRecord, TaskMessage } from "@hive/shared";
import {
  PersonalAgentAdapter,
  buildPersonalContext,
  hermesArgs,
  hermesCmd,
  hermesOnPath,
  openclawUp,
  queryTerms,
  runMiniAgent,
  searchMailbox,
  splitHermesOutput,
} from "../src/index.js";

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

function task(
  title = "Summarize my inbox about the yield model",
  input = "What's the current accuracy?",
): TaskMessage {
  return {
    kind: "task",
    taskId: "t1",
    spec: {
      customerId: "aiotlab",
      title,
      input,
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

/**
 * The bug this suite exists for: a task to summarize code at an explicit path was
 * answered with "no source code … beyond development status updates for the
 * yield-prediction model". Nothing was wrong with the model. The corpus snapshot
 * scored an unrelated personal note as relevant on the words "and" and "the",
 * pasted it in under a heading claiming relevance, and clamped the bee to it.
 */
const CODE_TASK = ["Read and summarize the code", "Summarize the code under /home/kuanting/projects/agent-hive"] as const;

describe("relevance gating", () => {
  it("drops stopwords, so unrelated prose no longer scores", () => {
    // "and" and "the" are 3 chars, so a bare length filter keeps them — and then
    // every English document in the corpus matches every English request.
    expect(queryTerms("read and summarize the code under /home/kuanting/projects/agent-hive")).toEqual([
      "read",
      "summarize",
      "code",
      "/home/kuanting/projects/agent-hive",
    ]);
    // Trailing punctuation stripped, path characters kept.
    expect(queryTerms("What's the current accuracy?")).toContain("accuracy");
    expect(queryTerms("the and but for are")).toEqual([]);
  });

  it("returns no context at all when nothing in the corpus is relevant", () => {
    const ctx = buildPersonalContext(dataDir, `${CODE_TASK[0]} ${CODE_TASK[1]}`);
    expect(ctx).toBe("");
    // Specifically: not the file listing either. A directory dump of unrelated
    // personal files is still unrelated personal files.
    expect(ctx).not.toContain("status.md");
  });

  it("still grounds a genuinely personal request", () => {
    // The gate must not simply disable retrieval — this is the case it exists for.
    const ctx = buildPersonalContext(dataDir, "yield model accuracy");
    expect(ctx).toContain("0.912");
    expect(ctx).toContain("Personal data files available");
  });

  it("does not return the whole inbox for a stopword-only query", () => {
    expect(searchMailbox(dataDir, "the and but")).toEqual([]);
    expect(searchMailbox(dataDir, "yield")).toHaveLength(1);
  });
});

describe("per-backend framing", () => {
  function systemOf(calls: Call[], urlPart: string): string {
    const chat = calls.find((c) => c.url.includes(urlPart));
    const msgs = (chat!.body as { messages: Array<{ role: string; content: string }> }).messages;
    return msgs[0].content;
  }

  it("tells a no-tool backend that its snapshot is all it has", async () => {
    const calls = stubFetch({ openclaw: true });
    await new PersonalAgentAdapter({ dataDir }).execute(task(), CAP, "prompt");
    const system = systemOf(calls, "/v1/chat/completions");
    // OpenClaw gets a plain chat completion with no tools, so this is true.
    expect(system).toContain("no file access in this call");
    expect(system).toContain("0.912");
  });

  it("does not clamp a tool-capable backend to the personal corpus", async () => {
    stubFetch({ openclaw: false });
    const dir = mkdtempSync(join(tmpdir(), "agent-path-"));
    const shim = join(dir, "hermes");
    // Echo the prompt back so the test can inspect what Hermes was told.
    writeFileSync(shim, `#!/bin/sh\nprintf '%s' "$3"\n`);
    chmodSync(shim, 0o755);
    process.env.PATH = dir;
    try {
      const res = await new PersonalAgentAdapter({ dataDir }).execute(
        task(CODE_TASK[0], CODE_TASK[1]),
        { ...CAP, agent: "hermes" },
        "prompt",
      );
      expect(res.runtimeUsed).toBe("hermes");
      // The clamp that caused the original failure must be gone...
      expect(res.output).not.toContain("only that data");
      expect(res.output).not.toContain("Answer using only");
      // ...and paths named in the task must be explicitly in scope.
      expect(res.output).toContain("read it directly");
      // No irrelevant personal material, and no heading asserting relevance.
      expect(res.output).not.toContain("0.912");
      expect(res.output).not.toContain("Personal data matching this request");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never prints a relevance heading over an empty snapshot", async () => {
    const calls = stubFetch({ openclaw: false });
    await new PersonalAgentAdapter({ dataDir }).execute(task(CODE_TASK[0], CODE_TASK[1]), CAP, "prompt");
    const system = systemOf(calls, "/api/chat");
    expect(system).toContain("Nothing in the personal corpus matched");
    expect(system).not.toContain("Here is the relevant personal data");
  });

  it("reuses the adapter's snapshot instead of walking the corpus twice", async () => {
    const calls = stubFetch({ openclaw: false });
    // Point at an unreadable dataDir: rebuilding the snapshot here would yield
    // "", so seeing the passed-in text prove it was threaded through, not redone.
    const res = await runMiniAgent({
      dataDir: join(dataDir, "does-not-exist"),
      model: "qwen3.5:4b",
      ollamaUrl: "http://localhost:11434",
      timeoutMs: 5_000,
      instruction: "prompt",
      query: "yield model",
      toolLoop: false,
      context: "PRECOMPUTED-SNAPSHOT",
    });
    expect(res.ok).toBe(true);
    expect(systemOf(calls, "/api/chat")).toContain("PRECOMPUTED-SNAPSHOT");
  });
});

describe("hermes stdout is untrusted", () => {
  // Real shapes from ~/.hermes/hermes-agent/agent/conversation_loop.py, where a
  // couple of dozen bare print() calls bypass the quiet_mode guard that -Q sets.
  const REPAIR = "🔧 Auto-repaired tool name: 'research:search_files' -> 'search_files'";

  it("keeps a CLI diagnostic out of the answer", () => {
    const { answer, diagnostics } = splitHermesOutput(`${REPAIR}\nThe project is a TypeScript workspace.`);
    expect(answer).toBe("The project is a TypeScript workspace.");
    expect(diagnostics).toEqual([REPAIR]);
  });

  it("does not discard stderr, which used to be dropped unread", () => {
    const { answer, diagnostics } = splitHermesOutput("real answer", "session_id: 20260730_143514_d803a4");
    expect(answer).toBe("real answer");
    expect(diagnostics).toContain("session_id: 20260730_143514_d803a4");
  });

  it("takes a multi-line block with its indented continuation", () => {
    const stdout = [
      "🔐 Anthropic 401 — authentication failed.",
      "   Auth method: oauth",
      "   Troubleshooting:",
      "     • Re-authenticate: hermes login --provider nous",
      "",
      "Here is the actual answer.",
    ].join("\n");
    const { answer, diagnostics } = splitHermesOutput(stdout);
    expect(answer).toBe("Here is the actual answer.");
    expect(diagnostics).toHaveLength(4);
  });

  it("redacts a credential fragment instead of logging it", () => {
    // conversation_loop.py:2025 prints the first 12 characters of the live token,
    // always inside the 🔐 block that opens at :2023.
    const { answer, diagnostics } = splitHermesOutput(
      "🔐 Anthropic 401 — authentication failed.\n   Token prefix: sk-ant-api03...\nanswer",
    );
    expect(answer).toBe("answer");
    expect(diagnostics.join(" ")).not.toContain("sk-ant");
    expect(diagnostics.join(" ")).toContain("[redacted]");
  });

  it("does not mistake an answer about tokens for a leaked credential", () => {
    // The redaction pattern matches the word "token", and this codebase's own
    // summary opens with it — so the pattern must only ever apply to lines
    // already identified as diagnostics by position, never select them.
    const real = "Agent Hive is designed for extreme token optimization.\nIt routes by cost.";
    expect(splitHermesOutput(real).answer).toBe(real);
    expect(splitHermesOutput(real).diagnostics).toEqual([]);
  });

  it("leaves an answer that merely looks like chatter alone", () => {
    // Only a *leading* run is stripped, so a summary containing a bulleted or
    // emoji-prefixed line mid-answer survives intact.
    const stdout = "A summary:\n- ❌ one test fails\n   • and a bullet";
    expect(splitHermesOutput(stdout).answer).toBe(stdout);
    expect(splitHermesOutput(stdout).diagnostics).toEqual([]);
  });

  it("treats diagnostics-only output as no answer", () => {
    expect(splitHermesOutput(REPAIR).answer).toBe("");
  });

  it("surfaces diagnostics on the result, and falls through when only chatter came back", async () => {
    stubFetch({ openclaw: false });
    const dir = mkdtempSync(join(tmpdir(), "agent-path-"));
    const shim = join(dir, "hermes");
    // Emit a repair notice ahead of the answer, exactly as Hermes does.
    writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n%s' "${REPAIR}" 'the real answer'\n`);
    chmodSync(shim, 0o755);
    process.env.PATH = dir;
    try {
      const res = await new PersonalAgentAdapter({ dataDir }).execute(task(), { ...CAP, agent: "hermes" }, "prompt");
      expect(res.runtimeUsed).toBe("hermes");
      expect(res.output).toBe("the real answer");
      expect(res.output).not.toContain("Auto-repaired");
      expect(res.diagnostics).toEqual([REPAIR]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades to the next backend when the CLI returns chatter and nothing else", async () => {
    stubFetch({ openclaw: false });
    const dir = mkdtempSync(join(tmpdir(), "agent-path-"));
    const shim = join(dir, "hermes");
    writeFileSync(shim, `#!/bin/sh\nprintf '%s' "${REPAIR}"\n`);
    chmodSync(shim, 0o755);
    process.env.PATH = dir;
    try {
      const res = await new PersonalAgentAdapter({ dataDir }).execute(task(), { ...CAP, agent: "hermes" }, "prompt");
      // A run that produced only chatter is not an answer — the chain moves on,
      // and the note says what happened rather than returning the chatter.
      expect(res.runtimeUsed).toBe("personal-mini");
      expect(res.output).toContain("hermes unavailable");
      expect(res.output).toContain("no answer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("detects an absolute HERMES_CMD, which is a documented configuration", async () => {
    // `join(dir, "/abs/path")` is "<dir>/abs/path", so probing PATH entries can
    // never find an absolute override — it dropped Hermes from the chain on every
    // host while hermesCmd() went on reporting it.
    const dir = mkdtempSync(join(tmpdir(), "abs-hermes-"));
    const shim = join(dir, "hermes-custom");
    writeFileSync(shim, "#!/bin/sh\nprintf 'hi'\n");
    chmodSync(shim, 0o755);
    process.env.HERMES_CMD = shim;
    try {
      expect(await hermesOnPath()).toBe(true); // PATH is the empty dir from beforeEach
      process.env.HERMES_CMD = join(dir, "not-installed");
      expect(await hermesOnPath()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the provider to Hermes when HERMES_PROVIDER is empty", () => {
    process.env.HERMES_PROVIDER = "";
    expect(hermesArgs("q", "m")).not.toContain("--provider");
  });
});
