import { afterEach, describe, expect, it, vi } from "vitest";
import { probeHost } from "../src/discovery.js";

/** Ollama's /api/tags, in the shape the daemon actually returns. */
function stubTags(models: Array<{ name: string; capabilities?: string[] }>) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("/api/tags")) {
      return { ok: true, status: 200, json: async () => ({ models }) } as Response;
    }
    throw new Error("connection refused"); // openclaw probe
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("probeHost", () => {
  it("reports models with their cloud and tool-support flags", async () => {
    // `tools` is not cosmetic: Hermes always advertises tools, so a model
    // without them cannot serve it — which is how gemma3 broke the personal bee.
    stubTags([
      { name: "gemma4:12b", capabilities: ["completion", "tools", "thinking"] },
      { name: "gemma3:12b", capabilities: ["completion"] },
      { name: "qwen3.5:cloud", capabilities: ["completion", "tools"] },
    ]);
    const host = await probeHost();
    expect(host.ollamaUp).toBe(true);
    expect(host.models).toEqual([
      { name: "gemma4:12b", cloud: false, tools: true },
      { name: "gemma3:12b", cloud: false, tools: false },
      { name: "qwen3.5:cloud", cloud: true, tools: true },
    ]);
  });

  it("treats an older daemon's missing capabilities list as no tool support", async () => {
    stubTags([{ name: "gemma4:12b" }]);
    const host = await probeHost();
    expect(host.models[0].tools).toBe(false);
  });

  it("reports the daemon down rather than throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection refused");
    });
    const host = await probeHost();
    expect(host.ollamaUp).toBe(false);
    expect(host.models).toEqual([]);
    expect(host.ollamaUrl).toContain("11434");
  });

  it("probes the agent runtimes an operator might harness", async () => {
    stubTags([]);
    const host = await probeHost();
    const names = host.runtimes.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["hermes", "openclaw", "opencode", "claude", "codex", "ollama"]));
  });

  it("registers nothing — an inventory is not a promise", async () => {
    // The whole point of the change: this used to return CapabilityRecords.
    stubTags([{ name: "gemma4:12b", capabilities: ["tools"] }]);
    const host = await probeHost();
    expect(host.drops).toEqual([]);
    expect(host.notes).toEqual([]);
    expect(host).not.toHaveProperty("capabilities");
  });
});
