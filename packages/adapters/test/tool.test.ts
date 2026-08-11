import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSpec, type CapabilityRecord, type TaskMessage } from "@hive/shared";
import { BUILTIN_TOOLS, ToolAdapter, toolData } from "../src/tool/index.js";
import { digikeyPriceTool, readSnapshot, scrapeTick } from "../src/tool/digikey.js";
import { SandboxError } from "../src/personal-agent/sandbox.js";

/**
 * Tier 4, which until now had no direct test at all.
 *
 * It is the rung the whole cost argument rests on — a program, no model, no
 * tokens — so the assertions that matter most are the boring ones: that the
 * token counts really are zero on every path, and that a tool handed a caller's
 * input cannot read its way out of its own directory.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tool-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const task = (over: Partial<TaskMessage> = {}): TaskMessage =>
  ({
    kind: "task",
    taskId: "t1",
    attempt: 1,
    spec: TaskSpec.parse({ customerId: "breeder", title: "t", input: "i" }),
    envelope: { maxUsd: 0, tier: 4, allowEscalation: true, urgency: "normal", degraded: false },
    difficulty: "simple",
    ...over,
  }) as TaskMessage;

const cap = { runtime: "tool", tier: 4, billing: "free", skills: [] } as unknown as CapabilityRecord;

const withToolInput = (toolInput: Record<string, unknown>, matchedToolId: string) =>
  task({
    matchedToolId,
    spec: TaskSpec.parse({ customerId: "breeder", title: "t", input: "i", toolInput }),
  });

describe("ToolAdapter", () => {
  const adapter = () => new ToolAdapter({ tools: BUILTIN_TOOLS, readArtifact: () => "a,b\n1,2" });

  it("runs a tool and spends nothing", async () => {
    const r = await adapter().execute(withToolInput({ csv: "a,b\n1,2\n3,4" }, "csv-report"), cap);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("rows: 2");
    expect(r.runtimeUsed).toBe("tool:csv-report");
    expect([r.inputTokens, r.outputTokens]).toEqual([0, 0]);
  });

  it("reports an unknown tool without pretending it ran", async () => {
    const r = await adapter().execute(withToolInput({}, "no-such-tool"), cap);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no-such-tool");
    expect(r.runtimeUsed).toBe("tool");
    expect([r.inputTokens, r.outputTokens]).toEqual([0, 0]);
  });

  it("keeps the tool id on a failure, so the attempt stays attributable", async () => {
    // The corpus records `runtime` per attempt. A failure that reported a bare
    // "tool" would be a row nobody could trace back to a program.
    const r = await adapter().execute(withToolInput({ csv: "   " }, "csv-report"), cap);
    expect(r.ok).toBe(false);
    expect(r.runtimeUsed).toBe("tool:csv-report");
    expect([r.inputTokens, r.outputTokens]).toEqual([0, 0]);
  });

  it("resolves an artifact reference through the injected reader", async () => {
    const r = await adapter().execute(withToolInput({ csvArtifact: "ref-1" }, "csv-report"), cap);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("rows: 1");
  });

  it("hands a tool no store when none is configured", async () => {
    // Undefined is a configuration fact, not an empty directory, and the two
    // send an operator to different places.
    const r = await adapter().execute(withToolInput({ part: "LM358N" }, "digikey-price"), cap);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HIVE_TOOL_DATA_DIR/);
  });
});

describe("a tool's local store", () => {
  it("refuses to read its way out of the root", () => {
    // The sandbox is the personal bee's, reused rather than reimplemented: a
    // tool receives an accessor and never a path, so this is impossible rather
    // than discouraged.
    writeFileSync(join(root, "inside.txt"), "ok");
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));

    const data = toolData(root);
    expect(data.read("inside.txt")).toBe("ok");
    expect(() => data.read("../../etc/passwd")).toThrow(SandboxError);
    expect(() => data.read("/etc/passwd")).toThrow(SandboxError);
    expect(() => data.read("link.txt")).toThrow(SandboxError);
    expect(data.exists("../../etc/passwd")).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it("says a file was truncated rather than letting JSON.parse blame the wrong thing", () => {
    // The sandbox caps reads at 64KB silently, which is right for prose a model
    // will read and wrong for anything parsed — the caller would otherwise chase
    // a syntax error in a perfectly well-formed file.
    writeFileSync(join(root, "big.json"), JSON.stringify({ pad: "x".repeat(80 * 1024) }));
    expect(() => toolData(root).readJson("big.json")).toThrow(/read cap|truncated/i);
  });
});

describe("the digikey price store", () => {
  it("is deterministic across fresh stores, and still moves between ticks", () => {
    // Both halves matter. Deterministic, or no test could assert a price.
    // Moving, or the corpus could never classify the shape as reading live data.
    const other = mkdtempSync(join(tmpdir(), "tool-b-"));
    const a1 = scrapeTick(root);
    const a2 = scrapeTick(root);
    const b1 = scrapeTick(other);

    expect(a1.tick).toBe(1);
    expect(a2.tick).toBe(2);
    expect(b1.rows).toEqual(a1.rows);

    const skus = Object.keys(a1.rows);
    const moved = skus.filter((s) => a1.rows[s].breaks[0].usd !== a2.rows[s].breaks[0].usd);
    expect(moved.length).toBeGreaterThan(skus.length / 2);
    rmSync(other, { recursive: true, force: true });
  });

  it("derives the tick from the store rather than the clock", () => {
    scrapeTick(root);
    scrapeTick(root);
    expect(readSnapshot(root).tick).toBe(2);
  });
});

describe("the digikey lookup", () => {
  const lookup = (input: Record<string, unknown>) => digikeyPriceTool.run(input, () => "", toolData(root));

  it("answers from the store, naming how old the answer is", () => {
    scrapeTick(root);
    const out = lookup({ part: "STM32F103C8T6" });
    expect(out).toContain("497-6063-ND");
    expect(out).toContain("STMicroelectronics");
    // The `as of` line is the only thing telling a reader this came from a store
    // with an age rather than from a live fetch.
    expect(out).toMatch(/as of: .*scrape tick 1/);
  });

  it("picks the largest price break at or below the quantity asked for", () => {
    scrapeTick(root);
    const snap = readSnapshot(root);
    const breaks = snap.rows["497-6063-ND"].breaks;
    expect(lookup({ part: "STM32F103C8T6", qty: 100 })).toContain(`$${breaks[2].usd.toFixed(4)} at qty 100`);
    expect(lookup({ part: "STM32F103C8T6", qty: 10 })).toContain(`$${breaks[1].usd.toFixed(4)} at qty 10`);
  });

  it("treats a part it does not stock as an answer, not a failure", () => {
    // The load-bearing asymmetry. A thrown tier-4 error escalates, and the retry
    // skips tool matching — so throwing here would hand a correct negative to a
    // model that will invent a price. The store is the authority on its contents.
    scrapeTick(root);
    const out = lookup({ part: "NOT-A-REAL-PART" });
    expect(out).toContain("not in the local catalogue");
    expect(out).toContain("12 part(s)");
  });

  it("refuses when the scraper has not run, and says so", () => {
    expect(() => lookup({ part: "LM358N" })).toThrow(/scrape:digikey/);
  });

  it("never fetches to answer — the store is the only source", () => {
    // Stated as a test because it is the architectural claim, not a detail: the
    // lookup is cheap precisely because a schedule already paid for the data.
    mkdirSync(join(root, "digikey", "prices"), { recursive: true });
    writeFileSync(
      join(root, "digikey", "prices", "latest.json"),
      JSON.stringify({ tick: 9, scrapedAt: "2020-01-01T00:00:00.000Z", source: "frozen", rows: {} }),
    );
    writeFileSync(join(root, "digikey", "catalog.json"), JSON.stringify({}));
    // An empty store answers "not stocked" rather than reaching out for the part.
    expect(lookup({ part: "LM358N" })).toContain("not in the local catalogue");
  });
});
