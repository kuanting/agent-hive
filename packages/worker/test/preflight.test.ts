import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityRecord } from "@hive/shared";
import { resetPreflightLog, viableCapabilities } from "../src/preflight.js";

const CLAUDE: CapabilityRecord = {
  runtime: "claude-code",
  model: "sonnet",
  tier: 1,
  billing: "subscription",
  skills: ["general"],
};
const CODEX: CapabilityRecord = { ...CLAUDE, runtime: "codex", model: "gpt-5-codex" };
const GPT: CapabilityRecord = {
  runtime: "api",
  model: "gpt-5-mini",
  tier: 2,
  billing: "per-token",
  skills: ["general"],
};
const GEMINI: CapabilityRecord = { ...GPT, model: "gemini-3-flash-preview" };
const LOCAL: CapabilityRecord = {
  runtime: "opencode",
  model: "gemma3:4b",
  tier: 3,
  billing: "local",
  skills: ["general"],
};
const PERSONAL: CapabilityRecord = {
  runtime: "personal",
  model: "qwen3:8b",
  tier: 3,
  billing: "local",
  skills: ["email", "files", "calendar", "daily-report", "personal"],
};

let origPath: string | undefined;
let saved: Record<string, string | undefined> = {};
const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "HERMES_CMD"];

/** A PATH containing only the named shims, so absence is deterministic. */
function pathWith(...commands: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  for (const c of commands) {
    const shim = join(dir, c);
    writeFileSync(shim, "#!/bin/sh\nexit 0\n");
    chmodSync(shim, 0o755);
  }
  process.env.PATH = dir;
  resetPreflightLog(); // onPath() memoizes; a new PATH needs a fresh cache
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as Response;
}

/**
 * Stub fetch by URL so the personal-runtime probes are deterministic:
 * - openclaw: /v1/models resolves when `openclaw` is true, else rejects
 * - ollama:   /api/tags returns `models` when `models` is non-empty
 */
function stubProbes(opts: { openclaw?: boolean; models?: string[] }) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("/v1/models")) {
      // A real gateway answers JSON; the probe requires that, so the stub must
      // carry the content-type too.
      if (opts.openclaw) return jsonResponse({ data: [{ id: "qwen3:8b" }] });
      throw new Error("connection refused");
    }
    if (url.includes("/api/tags")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: (opts.models ?? []).map((name) => ({ name })) }),
      } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  origPath = process.env.PATH;
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  resetPreflightLog();
});

afterEach(() => {
  process.env.PATH = origPath;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

it("keeps CLI capabilities only when the binary is on PATH", async () => {
  pathWith("claude");
  expect(await viableCapabilities([CLAUDE, CODEX])).toEqual([CLAUDE]);
});

it("keeps both when both CLIs are present", async () => {
  pathWith("claude", "codex");
  expect(await viableCapabilities([CLAUDE, CODEX])).toEqual([CLAUDE, CODEX]);
});

it("drops every CLI capability on a bare host", async () => {
  pathWith();
  expect(await viableCapabilities([CLAUDE, CODEX])).toEqual([]);
});

it("keeps api capabilities only for providers whose key is set", async () => {
  pathWith();
  process.env.GEMINI_API_KEY = "g-test";
  expect(await viableCapabilities([GPT, GEMINI])).toEqual([GEMINI]);
});

it("never drops local runtimes — they fall back to ollama-direct", async () => {
  pathWith();
  expect(await viableCapabilities([LOCAL])).toEqual([LOCAL]);
});

it("keeps the personal bee when Ollama has a local model (mini-agent backend)", async () => {
  pathWith();
  stubProbes({ openclaw: false, models: ["qwen3:8b"] });
  expect(await viableCapabilities([PERSONAL])).toEqual([PERSONAL]);
});

it("keeps the personal bee when an OpenClaw gateway answers, even with no local model", async () => {
  pathWith();
  stubProbes({ openclaw: true, models: [] });
  expect(await viableCapabilities([PERSONAL])).toEqual([PERSONAL]);
});

it("keeps the personal bee when a hermes CLI is on PATH", async () => {
  pathWith("hermes");
  stubProbes({ openclaw: false, models: [] });
  expect(await viableCapabilities([PERSONAL])).toEqual([PERSONAL]);
});

it("drops the personal bee when nothing can back it", async () => {
  pathWith();
  stubProbes({ openclaw: false, models: [] });
  const lines: string[] = [];
  expect(await viableCapabilities([PERSONAL], (m) => lines.push(m))).toEqual([]);
  expect(lines[0]).toContain("no OpenClaw gateway");
  expect(lines[0]).toContain("no local Ollama models");
});

it("reports why each capability was dropped, once", async () => {
  pathWith();
  const lines: string[] = [];
  await viableCapabilities([CLAUDE, GPT], (m) => lines.push(m));
  expect(lines).toEqual([
    "skipping claude-code/sonnet: 'claude' not on PATH",
    "skipping api/gpt-5-mini: OPENAI_API_KEY not set",
  ]);

  // Discovery re-runs every 30s; the same drop must not be logged again.
  const again: string[] = [];
  await viableCapabilities([CLAUDE, GPT], (m) => again.push(m));
  expect(again).toEqual([]);
});

it("leaves a bee with nothing rather than advertising what would fail", async () => {
  pathWith();
  expect(await viableCapabilities([CLAUDE, CODEX, GPT, GEMINI])).toEqual([]);
});
