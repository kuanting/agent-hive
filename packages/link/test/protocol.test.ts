import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BoxToCloud, boxToken, CloudToBox, parseBoxToken } from "../src/protocol.js";
import { hourStart, UsageRollups } from "../src/rollup.js";

/**
 * The fixtures under test/fixtures are the contract between the two repos.
 * iBuddys keeps byte-identical copies and runs the same parse over them, so a
 * change to the protocol that breaks one side fails a test on both.
 */

const FIXTURES = join(import.meta.dirname, "fixtures");
const load = (dir: string) =>
  readdirSync(join(FIXTURES, dir)).map((f) => ({ name: f, json: JSON.parse(readFileSync(join(FIXTURES, dir, f), "utf8")) }));

describe("protocol fixtures", () => {
  it("every cloud-to-box message parses, and there is one fixture per type", () => {
    const fixtures = load("cloud-to-box");
    for (const f of fixtures) expect(() => CloudToBox.parse(f.json), f.name).not.toThrow();
    const types = new Set(fixtures.map((f) => f.json.type));
    expect(types.size).toBe(CloudToBox.options.length);
  });

  it("every box-to-cloud message parses, and there is one fixture per type", () => {
    const fixtures = load("box-to-cloud");
    for (const f of fixtures) expect(() => BoxToCloud.parse(f.json), f.name).not.toThrow();
    const types = new Set(fixtures.map((f) => f.json.type));
    expect(types.size).toBe(BoxToCloud.options.length);
  });

  it("rejects a message from the wrong direction", () => {
    const hello = load("box-to-cloud").find((f) => f.json.type === "link.hello")!.json;
    expect(() => CloudToBox.parse(hello)).toThrow();
  });
});

describe("box tokens", () => {
  it("round-trips, and refuses anything that is not one", () => {
    const token = boxToken("k3j9x2demo", "s3cr3t-s3cr3t-s3cr3t");
    expect(parseBoxToken(token)).toEqual({ boxId: "k3j9x2demo", secret: "s3cr3t-s3cr3t-s3cr3t" });
    expect(parseBoxToken("hbx_k3j9_short")).toBeUndefined();
    expect(parseBoxToken("Bearer nonsense")).toBeUndefined();
  });
});

describe("usage rollups", () => {
  it("folds work into absolute per-member hourly totals", () => {
    const r = new UsageRollups();
    const at = Date.UTC(2026, 10, 5, 9, 15);
    r.add({ memberKey: "mbr_a", at, ok: true, chat: false, tier: 3, billing: "local", inputTokens: 100, outputTokens: 50, costUsd: 0, counterfactualUsd: 0.01, durationMs: 1000 });
    r.add({ memberKey: "mbr_a", at: at + 60_000, ok: false, chat: false, tier: 2, billing: "per-token", inputTokens: 10, outputTokens: 10, costUsd: 0.02, counterfactualUsd: 0, durationMs: 500 });
    const b = r.add({ memberKey: "mbr_a", at: at + 120_000, ok: true, chat: true, tier: 3, billing: "local", inputTokens: 5, outputTokens: 5, costUsd: 0, counterfactualUsd: 0.001, durationMs: 200 });
    expect(b.bucketStart).toBe(hourStart(at));
    expect(b).toMatchObject({ tasks: 2, tasksOk: 1, tasksFailed: 1, chatTurns: 1, localTokens: 160, cloudTokens: 20, costUsd: 0.02 });
    expect(b.counterfactualUsd).toBeCloseTo(0.011);
    expect(b.tierMix).toEqual({ "3": 2, "2": 1 });
    // a different member, same hour, is a different bucket
    r.add({ memberKey: "mbr_b", at, ok: true, chat: false, inputTokens: 1, outputTokens: 1, costUsd: 0, counterfactualUsd: 0, durationMs: 1 });
    expect(r.all()).toHaveLength(2);
  });
});
