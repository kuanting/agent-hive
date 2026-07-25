import { afterEach, beforeEach, expect, it } from "vitest";
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

let origPath: string | undefined;
let saved: Record<string, string | undefined> = {};
const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];

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
});

it("keeps CLI capabilities only when the binary is on PATH", () => {
  pathWith("claude");
  expect(viableCapabilities([CLAUDE, CODEX])).toEqual([CLAUDE]);
});

it("keeps both when both CLIs are present", () => {
  pathWith("claude", "codex");
  expect(viableCapabilities([CLAUDE, CODEX])).toEqual([CLAUDE, CODEX]);
});

it("drops every CLI capability on a bare host", () => {
  pathWith();
  expect(viableCapabilities([CLAUDE, CODEX])).toEqual([]);
});

it("keeps api capabilities only for providers whose key is set", () => {
  pathWith();
  process.env.GEMINI_API_KEY = "g-test";
  expect(viableCapabilities([GPT, GEMINI])).toEqual([GEMINI]);
});

it("never drops local runtimes — they fall back to ollama-direct", () => {
  pathWith();
  expect(viableCapabilities([LOCAL])).toEqual([LOCAL]);
});

it("reports why each capability was dropped, once", () => {
  pathWith();
  const lines: string[] = [];
  viableCapabilities([CLAUDE, GPT], (m) => lines.push(m));
  expect(lines).toEqual([
    "skipping claude-code/sonnet: 'claude' not on PATH",
    "skipping api/gpt-5-mini: OPENAI_API_KEY not set",
  ]);

  // Discovery re-runs every 30s; the same drop must not be logged again.
  const again: string[] = [];
  viableCapabilities([CLAUDE, GPT], (m) => again.push(m));
  expect(again).toEqual([]);
});

it("leaves a bee with nothing rather than advertising what would fail", () => {
  pathWith();
  expect(viableCapabilities([CLAUDE, CODEX, GPT, GEMINI])).toEqual([]);
});
