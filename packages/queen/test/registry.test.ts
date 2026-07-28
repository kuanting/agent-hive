import { describe, expect, it } from "vitest";
import { AgentHello } from "@hive/shared";
import { WorkerRegistry } from "../src/registry.js";

const hello = (over: Record<string, unknown> = {}) =>
  AgentHello.parse({
    kind: "agent.hello",
    agentId: "local-bee-1",
    site: "local",
    capabilities: [{ agent: "ollama", runtime: "ollama", model: "gemma4:12b", tier: 3, billing: "local", skills: ["general"] }],
    bindsGeneral: true,
    ...over,
  });

describe("host inventory rides the hello", () => {
  it("stores what a worker reported and hands it to /status", () => {
    const reg = new WorkerRegistry();
    reg.hello(
      hello({
        host: {
          ollamaUrl: "http://localhost:11434",
          ollamaUp: true,
          models: [{ name: "gemma4:12b", cloud: false, tools: true }],
          runtimes: [{ name: "hermes", present: true }],
          drops: [{ label: "opencode/foo:1b", reason: "'foo:1b' not installed in local Ollama" }],
          notes: [],
        },
      }),
    );
    const [w] = reg.snapshot();
    expect(w.host?.models[0].name).toBe("gemma4:12b");
    expect(w.host?.drops[0].reason).toContain("not installed");
  });

  it("accepts a worker that predates the field", () => {
    // zod is non-strict, so an absent optional must stay absent rather than
    // becoming an empty inventory that the console would render as "nothing
    // installed" — which is a different claim from "did not report".
    const reg = new WorkerRegistry();
    reg.hello(hello());
    expect(reg.snapshot()[0].host).toBeUndefined();
  });

  it("keeps the capability list separate from the inventory", () => {
    // A promise and a possibility are different things: routing reads the
    // first, Setup reads the second, and they must not be conflated.
    const reg = new WorkerRegistry();
    reg.hello(
      hello({
        host: {
          ollamaUrl: "http://localhost:11434",
          ollamaUp: true,
          models: [
            { name: "gemma4:12b", cloud: false, tools: true },
            { name: "gpt-oss:20b", cloud: false, tools: true },
            { name: "llama3.2:1b", cloud: false, tools: true },
          ],
          runtimes: [],
          drops: [],
          notes: [],
        },
      }),
    );
    const [w] = reg.snapshot();
    expect(w.capabilities).toHaveLength(1); // one configured agent
    expect(w.host?.models).toHaveLength(3); // three models merely present
    expect(reg.liveCapabilities()).toHaveLength(1);
  });
});
