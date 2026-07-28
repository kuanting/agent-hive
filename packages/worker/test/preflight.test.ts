import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityRecord, HostInventory } from "@hive/shared";
import { preflight, resetPreflightLog, viableCapabilities } from "../src/preflight.js";

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
  agent: "ollama",
  runtime: "ollama",
  model: "gemma4:12b",
  tier: 3,
  billing: "local",
  skills: ["general"],
};
const PERSONAL: CapabilityRecord = {
  agent: "hermes",
  runtime: "personal",
  model: "gemma4:12b",
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

/**
 * A host inventory, the way probeHost() would report one. Preflight is pure
 * now, so this whole suite is fixtures — no fetch stubbing, and the rules are
 * exercised through the same shape the console's Setup view renders.
 */
function host(over: Partial<HostInventory> = {}): HostInventory {
  return {
    ollamaUrl: "http://localhost:11434",
    ollamaUp: true,
    models: [{ name: "gemma4:12b", cloud: false, tools: true }],
    runtimes: [],
    drops: [],
    notes: [],
    ...over,
  };
}

const up = (...names: string[]) => names.map((name) => ({ name, present: true }));

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

describe("binaries and keys", () => {
  it("keeps CLI capabilities only when the binary is on PATH", () => {
    pathWith("claude");
    expect(preflight([CLAUDE, CODEX], host()).kept).toEqual([CLAUDE]);
  });

  it("keeps both when both CLIs are present", () => {
    pathWith("claude", "codex");
    expect(preflight([CLAUDE, CODEX], host()).kept).toEqual([CLAUDE, CODEX]);
  });

  it("drops every CLI capability on a bare host", () => {
    pathWith();
    expect(preflight([CLAUDE, CODEX], host()).kept).toEqual([]);
  });

  it("keeps api capabilities only for providers whose key is set", () => {
    pathWith();
    process.env.GEMINI_API_KEY = "g-test";
    expect(preflight([GPT, GEMINI], host()).kept).toEqual([GEMINI]);
  });

  it("leaves a bee with nothing rather than advertising what would fail", () => {
    pathWith();
    expect(preflight([CLAUDE, CODEX, GPT, GEMINI], host()).kept).toEqual([]);
  });
});

describe("a configured model must actually exist", () => {
  // Auto-discovery used to be the existence proof: it only ever registered
  // models Ollama had reported. Now that the operator declares them, preflight
  // is the only thing between a typo and a dispatch-time failure.
  it("drops a local capability whose model this host never pulled", () => {
    pathWith();
    const missing = { ...LOCAL, model: "gemma4:70b" };
    const report = preflight([missing], host());
    expect(report.kept).toEqual([]);
    expect(report.drops[0].reason).toContain("not installed in local Ollama");
    expect(report.drops[0].reason).toContain("ollama pull gemma4:70b");
  });

  it("keeps it when the model is installed", () => {
    pathWith();
    expect(preflight([LOCAL], host()).kept).toEqual([LOCAL]);
  });

  it("matches a bare tag against :latest, the way Ollama reports it", () => {
    pathWith();
    const bare = { ...LOCAL, model: "qwen3.5" };
    const inv = host({ models: [{ name: "qwen3.5:latest", cloud: false, tools: true }] });
    expect(preflight([bare], inv).kept).toEqual([bare]);
  });

  it("drops every Ollama-backed record when the daemon is down", () => {
    pathWith();
    const report = preflight([LOCAL], host({ ollamaUp: false, models: [] }));
    expect(report.kept).toEqual([]);
    expect(report.drops[0].reason).toContain("no Ollama daemon");
  });
});

describe("kept, but degraded — said out loud instead of found at runtime", () => {
  it("notes that a missing agent binary means ollama-direct", () => {
    pathWith();
    const oc: CapabilityRecord = { ...LOCAL, agent: "opencode", runtime: "opencode" };
    const report = preflight([oc], host());
    expect(report.kept).toEqual([oc]); // still viable — it degrades, it doesn't fail
    expect(report.notes[0].reason).toContain("ollama-direct");
  });

  it("notes a model that cannot serve hermes, since hermes always sends tools", () => {
    pathWith("hermes");
    const inv = host({
      models: [{ name: "gemma3:12b", cloud: false, tools: false }],
      runtimes: up("hermes"),
    });
    const report = preflight([{ ...PERSONAL, model: "gemma3:12b" }], inv);
    expect(report.kept).toHaveLength(1);
    expect(report.notes[0].reason).toContain("does not support tool calling");
  });

  it("says nothing when the configured agent is present and the model fits", () => {
    pathWith("hermes");
    const report = preflight([PERSONAL], host({ runtimes: up("hermes") }));
    expect(report.kept).toEqual([PERSONAL]);
    expect(report.notes).toEqual([]);
  });
});

describe("the personal bee is viable if anything can back it", () => {
  it("keeps it when Ollama has a local model (mini-agent backend)", () => {
    pathWith();
    expect(preflight([PERSONAL], host()).kept).toEqual([PERSONAL]);
  });

  it("keeps it when an OpenClaw gateway answers, even with no local model", () => {
    pathWith();
    const inv = host({ models: [], runtimes: up("openclaw") });
    expect(preflight([PERSONAL], inv).kept).toEqual([PERSONAL]);
  });

  it("keeps it when a hermes CLI is on PATH", () => {
    pathWith("hermes");
    expect(preflight([PERSONAL], host({ models: [] })).kept).toEqual([PERSONAL]);
  });

  it("drops it when nothing can back it", () => {
    pathWith();
    const report = preflight([PERSONAL], host({ models: [], ollamaUp: false }));
    expect(report.kept).toEqual([]);
    expect(report.drops[0].reason).toContain("no OpenClaw gateway");
    expect(report.drops[0].reason).toContain("no local Ollama models");
  });
});

describe("logging", () => {
  it("reports why each capability was dropped, once", () => {
    pathWith();
    const lines: string[] = [];
    viableCapabilities([CLAUDE, GPT], host(), (m) => lines.push(m));
    expect(lines).toEqual([
      "skipping claude-code/sonnet: 'claude' not on PATH",
      "skipping api/gpt-5-mini: OPENAI_API_KEY not set",
    ]);

    // Discovery re-runs every 30s; the same drop must not be logged again.
    const again: string[] = [];
    viableCapabilities([CLAUDE, GPT], host(), (m) => again.push(m));
    expect(again).toEqual([]);
  });

  it("names capabilities by their configured agent, not their adapter", () => {
    pathWith();
    const lines: string[] = [];
    const named: CapabilityRecord = { ...LOCAL, agent: "my-harnessed-agent", runtime: "opencode", model: "nope:1b" };
    viableCapabilities([named], host(), (m) => lines.push(m));
    expect(lines[0]).toContain("my-harnessed-agent/nope:1b (via opencode)");
  });
});

describe("the personal bee's model stays advisory", () => {
  it("is not dropped for a model this host lacks", () => {
    // The personal adapter resolves PERSONAL_MODEL > cap.model > first installed
    // model, so its `model:` is a suggestion. Applying the existence check here
    // would refuse a bee that would in fact have answered.
    pathWith("hermes");
    const report = preflight([{ ...PERSONAL, model: "never-pulled:1b" }], host({ runtimes: up("hermes") }));
    expect(report.kept).toHaveLength(1);
    expect(report.drops).toEqual([]);
  });
});
