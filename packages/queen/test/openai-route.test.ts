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

/**
 * Answer the NEXT task, not whatever was dispatched last.
 *
 * `answerNextTask` takes the most recent entry the moment it sees one, so a test
 * that has already run a request will answer that one again — the HTTP round
 * trip has not necessarily dispatched yet. Waiting for the count to move is what
 * makes "and then a second request happened" testable at all.
 */
async function answerTaskAfter(baseline: number, over: Partial<TaskResult> = {}): Promise<string> {
  for (let i = 0; i < 200 && f.tasks().length <= baseline; i++) await new Promise((r) => setTimeout(r, 5));
  if (f.tasks().length <= baseline) throw new Error("no new task was dispatched");
  return answerNextTask(over);
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

  it("does not advertise a tier-4 tool it could never route to", async () => {
    // The two halves were each correct and the pair was not. `/v1/models` is
    // built from every live capability, and tier-4 tools are live capabilities —
    // but `decide` filters tier 4 out of selection, because tool matching
    // already had its chance at the top of dispatch. So the listing offered
    // `hive/tool-csv-report` and picking it returned "no capability is
    // adequate". Advertising less is the honest failure mode.
    await f.deliver("queen.hello", {
      kind: "agent.hello",
      agentId: "worker-bee-1",
      site: "local",
      capabilities: [
        { agent: "tool", runtime: "tool", tier: 4, billing: "free", skills: ["reporting"], toolId: "csv-report" },
      ],
    });

    const data = (await (await fetch(`${base}/v1/models`)).json()) as { data: Array<{ id: string }> };
    const ids = data.data.map((m) => m.id);
    expect(ids.filter((id) => id.includes("tool"))).toEqual([]);
    // The rest of the fleet is untouched.
    expect(ids).toContain("hive/gemini");

    // And naming it is a clean 404 rather than a dispatch that refuses.
    const res = await post("/v1/chat/completions", {
      model: "hive/tool-csv-report",
      messages: [{ role: "user", content: "report on the rows" }],
    });
    expect(res.status).toBe(404);
    expect(f.tasks()).toHaveLength(0);
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

  it("does not serve turn 2 of a tool loop from turn 1's cache", async () => {
    // The loop is: ask -> model returns a tool call -> caller runs it -> caller
    // posts the result -> model answers. Turn 2 appends an assistant `tool_calls`
    // turn and a `role: "tool"` turn, but the last *user* turn is unchanged — and
    // the cache key was built from the spec, whose `input` is only that last user
    // turn. So turn 2 hashed identically to turn 1 and was served the same tool
    // call back, forever, for the whole TTL. The caller runs the tool again, posts
    // again, gets the same call again: a loop that never reaches a model.
    const tools = [{ type: "function", function: { name: "read_file" } }];
    const call = { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } };

    const first = post("/v1/chat/completions", {
      model: "hive/gemini",
      messages: [{ role: "user", content: "read a.txt" }],
      tools,
    });
    await answerNextTask({ output: "", toolCalls: [call] });
    await first;
    const afterTurnOne = f.tasks().length;

    const second = post("/v1/chat/completions", {
      model: "hive/gemini",
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: "", tool_calls: [call] },
        { role: "tool", tool_call_id: "c1", content: "file contents" },
      ],
      tools,
    });
    // Wait for a task beyond turn 1's rather than answering whatever is last:
    // served from cache, no second task is ever dispatched and this fails here
    // with a clear reason instead of hanging on the fetch.
    for (let i = 0; i < 100 && f.tasks().length === afterTurnOne; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(f.tasks().length, "turn 2 was served from cache and never reached a bee").toBeGreaterThan(afterTurnOne);
    await answerNextTask({ output: "a.txt says hello" });
    const body = (await (await second).json()) as {
      choices: Array<{ message: { content: string; tool_calls?: unknown[] }; finish_reason: string }>;
    };

    expect(f.tasks().length).toBeGreaterThan(afterTurnOne);
    expect(body.choices[0].message.content).toBe("a.txt says hello");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(body.choices[0].finish_reason).toBe("stop");
  });

  it("records who asked, without writing down who they are", async () => {
    // `body.user` was declared in the request schema and read nowhere, and
    // `Caller.userId` was parsed from HIVE_API_KEYS with a comment promising
    // per-user attribution that nothing delivered. Both now reach the row.
    process.env.HIVE_API_KEYS = "sk-lab:aiotlab:ada";
    await new Promise((r) => server.close(r));
    f = fakeBus();
    core = await QueenCore.create(ROOT, f.bus);
    await registerFleet();
    await startServer();

    const pending = post(
      "/v1/chat/completions",
      { model: "hive/gemini", messages: [{ role: "user", content: "hi" }], user: "ada@example.com" },
      { authorization: "Bearer sk-lab" },
    );
    await answerNextTask();
    await pending;

    // The last row, not the first: ROOT is shared by every test in this file, so
    // the corpus already holds their rows too.
    const row = core.taskEpisodes.readAll().at(-1)!;
    expect(row.userId).toBe("ada");
    // The end-user field is a grouping key, and callers put anything in it. The
    // hash serves the grouping exactly as well and carries no address to disk.
    expect(row.endUserHash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(row)).not.toContain("ada@example.com");
  });

  it("groups a caller's turns under one hash, and different callers apart", async () => {
    const before = core.taskEpisodes.readAll().length;
    // Distinct wording per request, or the second is a cache hit and never
    // dispatches — which is the cache working, not the grouping failing.
    const send = async (user: string, ask: string) => {
      const n = f.tasks().length;
      const pending = post("/v1/chat/completions", {
        model: "hive/gemini",
        messages: [{ role: "user", content: ask }],
        user,
      });
      await answerTaskAfter(n);
      await pending;
    };

    await send("ada", "what is the yield today");
    await send("ada", "and the scrap rate");
    await send("grace", "summarize the week");

    const hashes = core.taskEpisodes.readAll().slice(before).map((r) => r.endUserHash);
    expect(hashes).toHaveLength(3);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it("records a tool loop as one loop, in call order", async () => {
    // The evidence that matters most: a caller's recurring tool sequence is
    // already structured, so it needs none of the masking the text path does —
    // and names are structure, so it survives the default fidelity. Before this,
    // `toolCalls` was dropped on the way to disk and three turns of one loop were
    // three unrelated rows.
    const tools = [
      { type: "function", function: { name: "digikey_search" } },
      { type: "function", function: { name: "get_price" } },
    ];
    const before = core.taskEpisodes.readAll().length;
    const messages: unknown[] = [{ role: "user", content: "price for LM358N" }];

    const turn = async (over: Partial<TaskResult>) => {
      const n = f.tasks().length;
      const pending = post("/v1/chat/completions", { model: "hive/gemini", messages, tools, user: "ada" });
      await answerTaskAfter(n, over);
      await pending;
    };

    await turn({
      output: "",
      toolCalls: [{ id: "c1", type: "function", function: { name: "digikey_search", arguments: '{"part":"LM358N"}' } }],
    });
    messages.push(
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "digikey_search", arguments: '{"part":"LM358N"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "sku 296-1234" },
    );
    await turn({
      output: "",
      toolCalls: [{ id: "c2", type: "function", function: { name: "get_price", arguments: '{"sku":"296-1234"}' } }],
    });
    messages.push(
      { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "get_price", arguments: '{"sku":"296-1234"}' } }] },
      { role: "tool", tool_call_id: "c2", content: "$1.20" },
    );
    await turn({ output: "LM358N is $1.20" });

    const rows = core.taskEpisodes.readAll().slice(before);
    expect(rows).toHaveLength(3);

    // One loop, however many HTTP requests it took.
    expect(new Set(rows.map((r) => r.loopId)).size).toBe(1);
    expect(rows.map((r) => r.turnIndex)).toEqual([1, 3, 5]);
    // What the caller offered, as opposed to what actually got called.
    expect(rows[0].declaredTools).toEqual(["digikey_search", "get_price"]);
    // The procedure, in the order it ran. This is the recommendation.
    expect(rows.flatMap((r) => r.attempts[0].toolCallNames ?? [])).toEqual(["digikey_search", "get_price"]);
    expect(rows[0].attempts[0].toolCallArgKeys).toEqual([["part"]]);
    expect(rows[1].attempts[0].toolCallArgKeys).toEqual([["sku"]]);
  });

  it("keeps argument values out of the corpus at every fidelity", async () => {
    // Names and key names are structure; values are content. Asserted on the
    // bytes rather than field by field, the way log-privacy.test.ts does it.
    const before = core.taskEpisodes.readAll().length;
    const pending = post("/v1/chat/completions", {
      model: "hive/gemini",
      messages: [{ role: "user", content: "look it up" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    await answerNextTask({
      output: "",
      toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"/etc/shadow"}' } }],
    });
    await pending;

    const raw = JSON.stringify(core.taskEpisodes.readAll().slice(before));
    expect(raw).toContain("read_file");
    expect(raw).toContain("path");
    expect(raw).not.toContain("/etc/shadow");
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

  it("accepts the content-part arrays a real client sends, and OpenAI's developer role", async () => {
    // Open WebUI and the OpenAI SDKs send `content` as an array of parts the
    // moment anything is attached, and `developer` replaced `system`. Both used
    // to 400 on a zod issue about receiving an array — a message that told the
    // person who just attached something nothing at all.
    const pending = post("/v1/chat/completions", {
      model: "hive/gemini",
      messages: [
        { role: "developer", content: "be terse" },
        {
          role: "user",
          content: [
            { type: "text", text: "first part" },
            { type: "text", text: "second part" },
          ],
        },
      ],
    });
    await answerNextTask();
    await pending;

    const dispatched = f.tasks().at(-1)!.payload as {
      spec: { input: string };
      passthrough?: { messages: Array<{ role: string; content: string }> };
    };
    // Narrowed before it reaches the wire: the bee sees a hive ChatTurn, never
    // the client's dialect.
    expect(dispatched.passthrough?.messages[0].role).toBe("system");
    expect(dispatched.passthrough?.messages[1].content).toBe("first part\n\nsecond part");
    // And the flattened text is what difficulty scoring and the cache key read.
    expect(dispatched.spec.input).toBe("first part\n\nsecond part");
  });

  it("streams for clients that ask, and still reports usage", async () => {
    const pending = post("/v1/chat/completions", {
      model: "hive/auto",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    await answerNextTask();
    const res = await pending;
    // Without this a buffering proxy holds the whole response until the body
    // ends, so a caller that asked for a stream gets silence and then all of it.
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const text = await res.text();
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

  it("names the attachment it cannot take, instead of a zod issue about arrays", async () => {
    const res = await post("/v1/chat/completions", {
      model: "hive/auto",
      messages: [
        { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:," } }] },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unsupported_content");
    expect(body.error.message).toContain("image_url");
    // The index, so a client with a long transcript knows which message to fix.
    expect(body.error.message).toContain("message 0");
    expect(f.tasks()).toHaveLength(0);
  });

  it("answers an endpoint it does not serve in JSON, not an HTML 404 page", async () => {
    // A caller with the wrong base URL, or one reaching for /v1/embeddings, used
    // to get Express's HTML and a parse error about a `<`.
    const res = await fetch(`${base}/v1/embeddings`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unknown_endpoint");
    expect(body.error.message).toContain("/v1/chat/completions");
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

describe("a request that outlives its wait gets a handle, not a dead socket", () => {
  beforeEach(async () => {
    await new Promise((r) => server.close(r));
    process.env.HIVE_HTTP_WAIT_MS = "50";
    await startServer();
  });

  afterEach(() => {
    delete process.env.HIVE_HTTP_WAIT_MS;
  });

  it("names the task and why it is waiting, without claiming it failed", async () => {
    const res = await post("/v1/chat/completions", {
      model: "hive/auto",
      messages: [{ role: "user", content: "something no bee answers in 50ms" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { total_tokens: number };
      x_hive: { status?: string; task_id?: string; refused?: string };
    };
    expect(body.x_hive.status).toBe("waiting");
    expect(body.x_hive.task_id).toBeTruthy();
    // Not a refusal. The task is still running and may yet succeed, so saying
    // the hive could not run it would be a false statement about live work.
    expect(body.x_hive.refused).toBeUndefined();
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBe(0);
    // The task id is a handle, so it has to be in the part a human reads too.
    expect(body.choices[0].message.content).toContain(body.x_hive.task_id!);
  });

  it("still settles the task the caller stopped listening for", async () => {
    // The half that matters. The socket giving up must not lose the work, the
    // spend, or the row — otherwise a busy hive under a short timeout would
    // quietly stop accounting for exactly the tasks that cost the most.
    const res = await post("/v1/chat/completions", {
      model: "hive/auto",
      messages: [{ role: "user", content: "a slow one, answered late" }],
    });
    const { x_hive } = (await res.json()) as { x_hive: { task_id: string } };

    await answerNextTask();
    const row = core.taskEpisodes.readAll().at(-1)!;
    expect(row.taskId).toBe(x_hive.task_id);
    expect(row.attempts.at(-1)?.costUsd).toBeGreaterThan(0);
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
