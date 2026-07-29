import { afterEach, describe, expect, it, vi } from "vitest";
import { EXCHANGES } from "@hive/shared";
import { configuredLevel, createBeeLog } from "../src/log.js";

/** Collects what a bee would have put on the wire. */
function fakeBus() {
  const published: Array<{ exchange: string; key: string; payload: any }> = [];
  return {
    published,
    publish(exchange: string, key: string, payload: unknown) {
      published.push({ exchange, key, payload });
    },
  };
}

// The logger prints as well as publishes; keep the suite's output readable.
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};
afterEach(() => vi.restoreAllMocks());

describe("the level threshold", () => {
  it("publishes at or above the threshold", () => {
    quiet();
    const bus = fakeBus();
    const log = createBeeLog("local-bee-1", bus, "info");
    log("info", "took a task");
    log("warn", "budget guard refused");
    log("error", "adapter blew up");
    expect(bus.published.map((p) => p.payload.level)).toEqual(["info", "warn", "error"]);
  });

  it("stays silent below it, on the wire and in the terminal alike", () => {
    quiet();
    const bus = fakeBus();
    const log = createBeeLog("local-bee-1", bus, "warn");
    log("debug", "picked record");
    log("info", "took a task");
    expect(bus.published).toEqual([]);
    // One knob, both audiences: an operator reading the console and one tailing
    // the process must not be shown different things.
    expect(console.log).not.toHaveBeenCalled();
  });

  it("reads HIVE_LOG_LEVEL, and ignores a value that is not a level", () => {
    expect(configuredLevel("debug")).toBe("debug");
    expect(configuredLevel("chatty")).toBe("info");
    expect(configuredLevel(undefined)).toBe("info");
  });
});

describe("publishing is best-effort", () => {
  it("works with no bus at all", () => {
    quiet();
    const log = createBeeLog("local-bee-1", undefined, "info");
    expect(() => log("info", "still prints")).not.toThrow();
    expect(console.log).toHaveBeenCalledWith("[local-bee-1] still prints");
  });

  it("never lets a broker failure escape into the task it was describing", () => {
    quiet();
    const log = createBeeLog("local-bee-1", {
      publish() {
        throw new Error("connection closed");
      },
    });
    expect(() => log("error", "task failed")).not.toThrow();
  });
});

describe("what goes on the wire", () => {
  it("routes to telemetry under the bee's own id, carrying the task it belongs to", () => {
    quiet();
    const bus = fakeBus();
    createBeeLog("local-bee-1", bus)("info", "task abc123 via opencode/gemma4:12b (tier 3)", "abc123");
    expect(bus.published[0].exchange).toBe(EXCHANGES.telemetry);
    expect(bus.published[0].key).toBe("agent.log.local-bee-1");
    expect(bus.published[0].payload).toMatchObject({
      kind: "agent.log",
      agentId: "local-bee-1",
      level: "info",
      taskId: "abc123",
    });
  });

  it("clips an over-long line instead of letting the schema dead-letter it", () => {
    quiet();
    const bus = fakeBus();
    createBeeLog("local-bee-1", bus)("info", "x".repeat(900));
    expect(bus.published[0].payload.text.length).toBe(500);
    expect(bus.published[0].payload.text.endsWith("…")).toBe(true);
  });
});
