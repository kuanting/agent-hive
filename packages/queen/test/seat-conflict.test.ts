import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bus } from "@hive/shared";
import { QueenCore } from "../src/core.js";
import { tmpRootWithCustomers } from "./tmpRoot.js";

/**
 * Seats are global, and two profiles can disagree about one.
 *
 * `BudgetLedger.addSeat` is first-write-wins, and deliberately so: a seat is a
 * real prepaid window on a real account, keyed by `seatId` across the whole
 * ledger, and several profiles *declaring* the same one is how they share it. The
 * failure mode is not the rule, it is the silence — whichever profile
 * `readdirSync` happened to yield first set the window size for everybody, and
 * nothing said which.
 *
 * Making the last writer win instead would be worse: it would make routing
 * depend on filename order, so renaming a customer file would change what a
 * quota window is.
 */

const bus: Bus = {
  publish() {},
  async consume() {},
  async pause() {},
  async close() {},
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

const withSeat = (seconds: number, tokens: number) => `
customerId: placeholder
budget:
  capUsd: 10
seats:
  - seatId: claude-max-1
    windowSeconds: ${seconds}
    tokensPerWindow: ${tokens}
`;

const lines = () => warn.mock.calls.map((c) => String(c[0]));

describe("two profiles declaring one seat differently", () => {
  it("says which numbers are in force and how to stop sharing", async () => {
    // Alphabetical, so `aaa` is loaded first and wins.
    const root = tmpRootWithCustomers({
      aaa: withSeat(18000, 2_000_000).replace("placeholder", "aaa"),
      zzz: withSeat(90, 400).replace("placeholder", "zzz"),
    });
    await QueenCore.create(root, bus);

    const conflict = lines().find((l) => l.includes("claude-max-1"));
    expect(conflict).toBeDefined();
    // Both sides named, so the operator can tell which file to edit.
    expect(conflict).toContain("aaa");
    expect(conflict).toContain("zzz");
    // And which one actually took effect, since that is the part they cannot see.
    expect(conflict).toContain("aaa's numbers");
    expect(conflict).toContain("seatId");
  });

  it("stays quiet when two profiles share a seat on the same terms", async () => {
    // Sharing a seat is the normal case and must not warn — only disagreeing
    // about its size is a mistake.
    const root = tmpRootWithCustomers({
      aaa: withSeat(18000, 2_000_000).replace("placeholder", "aaa"),
      zzz: withSeat(18000, 2_000_000).replace("placeholder", "zzz"),
    });
    await QueenCore.create(root, bus);

    expect(lines().filter((l) => l.includes("claude-max-1"))).toEqual([]);
  });
});
