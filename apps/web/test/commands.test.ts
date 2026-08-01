import { describe, expect, it } from "vitest";
import { KNOWN_COMMANDS, parseCommand } from "../src/commands.js";

/**
 * Two bugs' worth of history in one small parser.
 *
 * First, `/shutdown` typed in the console went to the planner as ordinary chat,
 * which replied "System shutting down." while four bees and a Queen carried on
 * running. A model can claim any outcome, so nothing that controls the hive may
 * be routed through one.
 *
 * Then the fix put shutdown in the console, which was also wrong: the dev server
 * proxies to the Queen from its own process, so the Queen's loopback guard sees
 * 127.0.0.1 wherever the browser is. With no user authentication yet, admin
 * capability is confined to the hive's machine — and a browser is not it.
 *
 * What this file pins is the property both bugs violated: **the console cannot
 * stop the hive, and never silently pretends otherwise.**
 */

describe("the console cannot perform admin actions", () => {
  it("refuses /shutdown and names where it went", () => {
    const cmd = parseCommand("/shutdown");
    expect(cmd.kind).toBe("moved");
    expect(cmd.kind === "moved" && cmd.use).toContain("npm run stop");
  });

  it("refuses it however it is typed, since a near-miss must not fall through to chat", () => {
    for (const raw of ["/Shutdown", "  /shutdown  ", "/shutdown maintenance window"]) {
      expect(parseCommand(raw).kind, raw).toBe("moved");
    }
  });

  it("offers no command that acts on the hive at all", () => {
    // The guarantee, stated directly: if a future command is added here, this
    // fails and someone has to think about whether a browser should have it.
    expect(KNOWN_COMMANDS).toEqual([]);
  });
});

describe("a slash line is for the console, never for the planner", () => {
  it("refuses an unknown command rather than letting a model answer it", () => {
    // Falling through to chat is exactly how "System shutting down." got said.
    expect(parseCommand("/restart")).toEqual({ kind: "unknown", name: "restart" });
    expect(parseCommand("/halt now")).toEqual({ kind: "unknown", name: "halt" });
  });

  it("leaves ordinary messages alone", () => {
    expect(parseCommand("shut down the hive please")).toEqual({
      kind: "chat",
      message: "shut down the hive please",
    });
    // A slash inside a sentence is not a command; only a leading one is.
    expect(parseCommand("summarise the report and/or the appendix").kind).toBe("chat");
  });
});
