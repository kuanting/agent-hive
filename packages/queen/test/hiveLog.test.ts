import { describe, expect, it } from "vitest";
import { HiveLog } from "../src/hiveLog.js";

function line(text: string, level: "debug" | "info" | "warn" | "error" = "info") {
  return { at: 1, level, source: "queen", text };
}

describe("the hive log is bounded", () => {
  it("keeps only the most recent entries once full", () => {
    const log = new HiveLog(3);
    for (const t of ["a", "b", "c", "d", "e"]) log.push(line(t));
    expect(log.size).toBe(3);
    expect(log.recent().map((e) => e.text)).toEqual(["c", "d", "e"]);
  });

  it("keeps seq monotonic across eviction, so a reconnecting client can still dedupe", () => {
    const log = new HiveLog(2);
    for (const t of ["a", "b", "c"]) log.push(line(t));
    expect(log.recent().map((e) => e.seq)).toEqual([2, 3]);
  });

  it("falls back to the default cap rather than trusting a nonsense one", () => {
    // HIVE_LOG_BUFFER=nope must not produce a log that evicts every line.
    const log = new HiveLog(Number("nope"));
    for (let i = 0; i < 10; i++) log.push(line(`x${i}`));
    expect(log.size).toBe(10);
  });
});

describe("level threshold", () => {
  it("recent() excludes anything below the threshold", () => {
    const log = new HiveLog();
    log.push(line("noisy", "debug"));
    log.push(line("routine", "info"));
    log.push(line("deferred", "warn"));
    log.push(line("dead", "error"));
    expect(log.recent("warn").map((e) => e.text)).toEqual(["deferred", "dead"]);
    expect(log.recent("debug").length).toBe(4);
  });

  it("defaults to showing everything, so a caller that forgets loses nothing", () => {
    const log = new HiveLog();
    log.push(line("noisy", "debug"));
    expect(log.recent().length).toBe(1);
  });
});

describe("live subscribers", () => {
  it("receives entries pushed after subscribing, and stops after unsubscribing", () => {
    const log = new HiveLog();
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.text));
    log.push(line("during"));
    off();
    log.push(line("after"));
    expect(seen).toEqual(["during"]);
  });

  it("survives a listener that throws, so one broken SSE socket cannot dead-letter a bus message", () => {
    const log = new HiveLog();
    const seen: string[] = [];
    log.subscribe(() => {
      throw new Error("socket closed");
    });
    log.subscribe((e) => seen.push(e.text));
    expect(() => log.push(line("still delivered"))).not.toThrow();
    expect(seen).toEqual(["still delivered"]);
  });
});
