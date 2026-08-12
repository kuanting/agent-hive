import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { type Bus } from "@hive/shared";
import { QueenCore } from "../src/core.js";
import { loadApiKeys } from "../src/auth.js";
import { mountChatRoutes } from "../src/routes/chat.js";
import { mountTaskRoutes } from "../src/routes/tasks.js";
import { tmpRootWithCustomers } from "./tmpRoot.js";

/**
 * The intake routes that were not behind the key.
 *
 * `/v1` got a bearer gate when the hive learned to answer as an LLM, and the two
 * older doors did not: `POST /tasks` parsed a `customerId` straight out of the
 * request body, and `/chat` did the same *and* was ungated. Between them, anyone
 * who could reach the Queen chose whose USD cap to spend, whose tier-4 tools
 * `matchTool` could fire, and whose learned memory was recalled into the
 * planner's prompt. `GET /tasks/:id` returned the whole transcript for an
 * eight-hex id.
 *
 * Driven over real HTTP, because what is being tested is which requests the wire
 * accepts.
 */

const ROOT = tmpRootWithCustomers({
  "team-a": "customerId: team-a\nbudget:\n  capUsd: 10\n",
  "team-b": "customerId: team-b\nbudget:\n  capUsd: 10\n",
});

const bus: Bus = {
  publish() {},
  async consume() {},
  async pause() {},
  async close() {},
};

let core: QueenCore;
let server: Server;
let base: string;

async function startServer() {
  const keys = loadApiKeys();
  const app = express();
  app.use(express.json());
  mountTaskRoutes(app, core, keys);
  mountChatRoutes(app, core, ROOT, keys);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const post = (path: string, body: unknown, key?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });

const get = (path: string, key?: string) =>
  fetch(`${base}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });

/**
 * Start a chat turn and take only the session frame.
 *
 * The route creates the session and announces it before the planner runs, so
 * aborting here gives a real session without this test depending on a planner
 * model being installed — which is the point: what is under test is the gate and
 * the ownership check, not the turn.
 */
async function startSession(key: string, body: Record<string, unknown>): Promise<string> {
  const abort = new AbortController();
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: abort.signal,
  });
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  abort.abort();
  // One read can carry several frames, so take the first rather than the chunk.
  const first = new TextDecoder().decode(value).split("\n\n")[0];
  return (JSON.parse(first.replace(/^data: /, "").trim()) as { sessionId: string }).sessionId;
}

beforeEach(async () => {
  process.env.HIVE_API_KEYS = "sk-a:team-a:ada,sk-b:team-b:bob,sk-a2:team-a:mei";
  core = await QueenCore.create(ROOT, bus);
  await startServer();
});

afterEach(async () => {
  delete process.env.HIVE_API_KEYS;
  await new Promise((r) => server.close(r));
});

describe("POST /tasks", () => {
  it("401s without a key", async () => {
    const res = await post("/tasks", { customerId: "team-a", title: "t", input: "x" });
    expect(res.status).toBe(401);
  });

  it("bills the key's customer, not the one the body claims", async () => {
    const res = await post("/tasks", { customerId: "team-b", title: "t", input: "x" }, "sk-a");
    expect(res.status).toBe(202);
    const { taskId } = (await res.json()) as { taskId: string };
    expect(core.getTask(taskId)!.spec.customerId).toBe("team-a");
  });

  it("attributes the task to the person holding the key", async () => {
    const res = await post("/tasks", { title: "t", input: "x" }, "sk-a");
    const { taskId } = (await res.json()) as { taskId: string };
    expect(core.getTask(taskId)!.caller?.userId).toBe("ada");
  });
});

describe("GET /tasks/:id", () => {
  it("does not hand a transcript to another customer", async () => {
    const { taskId } = (await (await post("/tasks", { title: "secret work", input: "x" }, "sk-a")).json()) as {
      taskId: string;
    };

    expect((await get(`/tasks/${taskId}`, "sk-a")).status).toBe(200);
    // 404, not 403: a response that distinguished them would confirm the id.
    expect((await get(`/tasks/${taskId}`, "sk-b")).status).toBe(404);
  });

  it("does not hand it to another person inside the same customer", async () => {
    const { taskId } = (await (await post("/tasks", { title: "ada's work", input: "x" }, "sk-a")).json()) as {
      taskId: string;
    };
    expect((await get(`/tasks/${taskId}`, "sk-a2")).status).toBe(404);
  });

  it("401s without a key", async () => {
    expect((await get("/tasks/whatever")).status).toBe(401);
  });
});

describe("POST /chat", () => {
  it("401s without a key", async () => {
    const res = await post("/chat", { message: "hello" });
    expect(res.status).toBe(401);
  });

  it("opens the session for the key's customer, not the one the body claims", async () => {
    const sessionId = await startSession("sk-a", { message: "hello", customerId: "team-b" });
    const session = (await (await get(`/sessions/${sessionId}`, "sk-a")).json()) as {
      customerId: string;
      userId: string;
    };
    // The body said team-b. Believing it would have spent team-b's cap, fired
    // team-b's tools, and recalled team-b's memory into the prompt.
    expect(session.customerId).toBe("team-a");
    expect(session.userId).toBe("ada");
  });
});

describe("GET /sessions/:id", () => {
  it("does not hand a conversation to another customer, or another person", async () => {
    const sessionId = await startSession("sk-a", { message: "hello" });

    expect((await get(`/sessions/${sessionId}`, "sk-a")).status).toBe(200);
    expect((await get(`/sessions/${sessionId}`, "sk-b")).status).toBe(404);
    expect((await get(`/sessions/${sessionId}`, "sk-a2")).status).toBe(404);
  });

  it("401s without a key", async () => {
    expect((await get("/sessions/deadbeef")).status).toBe(401);
  });
});
