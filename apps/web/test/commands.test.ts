import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands.js";

/**
 * The regression that prompted this file: `/shutdown` typed in the console was
 * sent to the planner as ordinary chat, which replied "System shutting down."
 * while the hive kept running — four bees, a Queen, and nothing stopped. A model
 * can claim any outcome it likes, so nothing that controls the hive may go
 * through one.
 */

describe("a slash line is for the console, never for the planner", () => {
  it("recognises /shutdown", () => {
    expect(parseCommand("/shutdown")).toEqual({ kind: "shutdown", reason: "requested from the console" });
  });

  it("keeps the rest of the line as the reason, which reaches every bee's log", () => {
    expect(parseCommand("/shutdown maintenance window")).toEqual({
      kind: "shutdown",
      reason: "maintenance window",
    });
  });

  it("is not case-sensitive, because the cost of missing it is a silent no-op", () => {
    expect(parseCommand("/Shutdown").kind).toBe("shutdown");
  });

  it("tolerates the spacing people actually type", () => {
    expect(parseCommand("  /shutdown   deploying v2  ")).toEqual({ kind: "shutdown", reason: "deploying v2" });
  });

  it("refuses an unknown command rather than letting a model answer it", () => {
    // The important half. Falling through to chat is exactly how "System
    // shutting down." got said in the first place.
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
