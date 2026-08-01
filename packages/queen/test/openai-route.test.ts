import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { EXCHANGES, type Bus, type TaskResult } from "@hive/shared";
import { QueenCore } from "../src/core.js";
import { mountOpenAiRoutes } from "../src/routes/openai.js";
import { tmpRoot } from "./tmpRoot.js";

/**
 * The hive answering as an LLM.
 *
 * Driven over real HTTP against a real express app, because the contract being
 * tested is a wire format: what matters is the bytes an OpenAI client receives,
 * not that a handler was called. The bus is fake so a "bee" can be made to
 * answer on cue.
 */

const ROOT = tmpRoot();

function fakeBus() {
  const published: Array<{ exchange: string; key: string; payload: Record<string, unknown> }> = [];
  const handlers = new Map<string, (msg: unknown, rk: string) => Promise<void>>();
  const bus: Bus = {
    publish(exchange, key, payload) {
      published.push({ exchange, key, payload: payload as Record<string, unknown> });
    },
    async consume(_exchange, queue, _patterns, schema, handler) {
      handlers.set(queue, (msg, rk) => handler(schema.parse(msg), rk));
    },
    async pause() {},
    async close() {},
  };
  return {
    bus,
    published,
    deliver: (queue: string, msg: unknown) => handlers.get(queue)!(msg, ""),
    tasks: () => published.filter((p) => p.exchange === EXCHANGES.tasks),
  };
}

let f: ReturnType<typeof fakeBus>;
let core: QueenCore;
let server: Server;
let base: string;

/**
 * Three bees: one that can serve a caller's tool loop, one that cannot, and a
 * local one so `hive/auto` has somewhere free to land. Without the last, every
 * unrouted request correctly *defers* waiting for a seat window — right
 * behaviour, wrong fixture.
 */
async function registerFleet() {
  await f.deliver("queen.hello", {
    kind: "agent.hello",
    agentId: "local-bee-1",
    site: "local",
    capabilities: [
      {
        agent: "ollama",
        runtime: "ollama",
        model: "gemma4:12b",
        tier: 3,
        billing: "local",
        skills: ["general", "writing"],
        description: "gemma4:12b on the lab GPU",
      },
    ],
  });
  await f.deliver("queen.hello", {
    kind: "agent.hello",
    agentId: "metered-bee-1",
    site: "cloud",
    capabilities: [
      {
        agent: "gemini",
        runtime: "api",
        model: "gemini-3-flash-preview",
        tier: 2,
        billing: "per-token",
        skills: ["general", "web-search"],
        description: "Gemini with Google Search grounding",
        supportsTools: true,
        search: true,
      },
    ],
  });
  await f.deliver("queen.hello", {
    kind: "agent.hello",
    agentId: "honey-bee-1",
    site: "local",
    capabilities: [
      {
        agent: "claude-code",
        runtime: "claude-code",
        model: "sonnet",
        tier: 1,
        billing: "subscription",
        skills: ["general", "coding"],
        description: "Claude Code on a prepaid seat",
        supportsTools: false,
        search: false,
      },
    ],
  });
}

/** Answer whatever task the hive just dispatched, as a bee would. */
async function answerNextTask(over: Partial<TaskResult> = {}): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const dispatched = f.tasks();
    if (dispatched.length) {
      const msg = dispatched[dispatched.length - 1].payload as { taskId: string; attempt: number };
      await f.deliver("queen.results", {
        kind: "task.result",
        taskId: msg.taskId,
        attempt: msg.attempt ?? 1,
        agentId: "metered-bee-1",
        customerId: "aiotlab",
        ok: true,
        output: "the answer",
        tierUsed: 2,
        agent: "gemini",
        runtime: "api:google",
        model: "gemini-3-flash-preview",
        billing: "per-token",
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.002 },
        durationMs: 12,
        ...over,
      });
      return msg.taskId;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no task was dispatched");
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  mountOpenAiRoutes(app, core);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

beforeEach(async () => {
  delete process.env.HIVE_API_KEYS;
  f = fakeBus();
  core = await QueenCore.create(ROOT, f.bus);
  await registerFleet();
  await startServer();
});

afterEach(async () => {
  delete process.env.HIVE_API_KEYS;
  await new Promise((r) => server.close(r));
});

describe("GET /v1/models describes the fleet as it is right now", () => {
  it("lists the router plus every live capability", async () => {
    const data = (await (await fetch(`${base}/v1/models`)).json()) as { data: Array<{ id: string }> };
    const ids = data.data.map((m) => m.id);
    expect(ids).toContain("hive/auto");
    expect(ids).toContain("hive/gemini");
    expect(ids).toContain("hive/claude-code");
  });

  it("says which bees can serve a caller's tool loop, so nobody finds out by failing", async () => {
    const data = (await (await fetch(`${base}/v1/models`)).json()) as {
      data: Array<{ id: string; hive: { supports_tools: boolean; description?: string } }>;
    };
    const byId = Object.fromEntries(data.data.map((m) => [m.id, m.hive]));
    expect(byId["hive/gemini"].supports_tools).toBe(true);
    // An agent runs its own tools and returns prose; it can never answer a turn
    // in somebody else's loop.
    expect(byId["hive/claude-code"].supports_tools).toBe(false);
    expect(byId["hive/gemini"].description).toContain("grounding");
  });
});

describe("POST /v1/chat/completions is the hive, wearing an LLM's clothes", () => {
  it("answers in the shape every OpenAI client already parses", async () => {
    const pending = post("/v1/chat/completions", {
      model: "hive/auto",
      messages: [{ role: "user", content: "say something" }],
    });
    await answerNextTask();
    const body = (await (await pending).json()) as {
      object: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      usage: { total_tokens: number };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("the answer");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBe(15);
  });

  it("reports which bee answered and what it cost, which no other gateway can", async () => {
    const pending = post("/v1/chat/completions", {
      model: "hive/auto",
      messages: [{ role: "user", content: "say something" }],
    });
    await answerNextTask();
    const body = (await (await pending).json()) as { x_hive: Record<string, unknown> };
    expect(body.x_hive.tier).toBe(2);
    expect(body.x_hive.agent).toBe("gemini");
    expect(body.x_hive.cost_usd).toBe(0.002);
  });

  it("returns tool calls to the caller instead of running them", async () => {
    const pending = post("/v1/chat/completions", {
      model: "hive/gemini",
      messages: [{ role: "user", content: "read a file" }],
      tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    });
    await answerNextTask({
      output: "",
      toolCalls: [{ id: "call_0", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    });
    const body = (await (await pending).json()) as {
      choices: Array<{ message: { tool_calls?: Array<{ function: { name: string } }> }; finish_reason: string }>;
    };
    expect(body.choices[0].message.tool_calls?.[0].function.name).toBe("read_file");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
  });

  it("forwards the caller's whole conversation, not a flattened prompt", async () => {
    // A tool loop is only expressible if the tool result survives the trip: the
    // hive's own prompt assembly has nowhere to put a `role: "tool"` turn.
    const pending = post("/v1/chat/completions", {
      model: "hive/gemini",
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "file contents" },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    await answerNextTask();
    await pending;

    const dispatched = f.tasks().at(-1)!.payload as { passthrough?: { messages: unknown[]; tools: unknown[] } };
    expect(dispatched.passthrough?.messages).toHaveLength(3);
    expect(dispatched.passthrough?.tools).toHaveLength(1);
  });

  it("streams for clients that ask, and still reports usage", async () => {
    const pending = post("/v1/chat/completions", {
      model: "hive/auto",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    await answerNextTask();
    const text = await (await pending).text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("the answer");
    expect(text).toContain("x_hive");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("saying no, by name", () => {
  it("404s an unknown model rather than quietly picking one", async () => {
    const res = await post("/v1/chat/completions", {
      model: "hive/does-not-exist",
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).toContain("/v1/models");
  });

  it("refuses tools on a bee that cannot serve them, before spending anything", async () => {
    const res = await post("/v1/chat/completions", {
      model: "hive/claude-code",
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("tools_unsupported");
    expect(body.error.message).toContain("supports_tools");
    expect(f.tasks()).toHaveLength(0);
  });

  it("tells the caller a refusal instead of hanging on it", async () => {
    // Naming a cloud bee for content the hive grounds as confidential: that
    // capability may never run it, and no amount of waiting changes that. The
    // honest answer is now, not a defer loop the client waits out.
    const res = await post("/v1/chat/completions", {
      model: "hive/gemini",
      messages: [{ role: "user", content: "summarize my unpublished results" }],
    });
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }>; x_hive: { refused?: string } };
    expect(body.x_hive.refused).toContain("confidential");
    expect(body.choices[0].message.content).toContain("could not run");
  });
});

describe("keys identify the caller", () => {
  beforeEach(async () => {
    await new Promise((r) => server.close(r));
    process.env.HIVE_API_KEYS = "sk-test:aiotlab:kt";
    await startServer();
  });

  it("401s without a key, in the error shape clients render", async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("bills the customer the key names", async () => {
    const pending = post(
      "/v1/chat/completions",
      { model: "hive/auto", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer sk-test" },
    );
    await answerNextTask();
    await pending;
    const dispatched = f.tasks().at(-1)!.payload as { spec: { customerId: string } };
    expect(dispatched.spec.customerId).toBe("aiotlab");
  });
});
