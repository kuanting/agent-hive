import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger } from "../src/budget.js";

/**
 * A ledger file in a directory of its own, so the "no temp file left behind"
 * assertion below can read the whole directory. Cleanup is the run's job — see
 * vitest.globalSetup.ts.
 */
function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "hive-led-")), "ledger.json");
}

describe("BudgetLedger.reconcile", () => {
  it("drops customers/seats no longer configured, keeps the rest with spend intact", () => {
    const ledger = new BudgetLedger(); // no persist path -> in-memory
    ledger.addCustomer("aiotlab", 50);
    ledger.addCustomer("stale", 10);
    ledger.addSeat("claude-max-1", 18000, 2_000_000);
    ledger.addSeat("old-seat", 3600, 1000);
    ledger.recordSpend("aiotlab", 5);

    ledger.reconcile(["aiotlab"], ["claude-max-1"]);

    const snap = ledger.snapshot();
    expect(snap.customers.map((c) => c.customerId)).toEqual(["aiotlab"]);
    expect(snap.customers[0].spentUsd).toBe(5); // spend preserved for kept customer
    expect(snap.seats.map((s) => s.seatId)).toEqual(["claude-max-1"]);
  });
});

/**
 * The ledger is the one piece of hive state that cannot be recomputed: it is the
 * record of what has been spent and how much seat quota is left. So the bar is
 * not "usually writes correctly" but "a reader never sees a half-written file,
 * and a damaged one is never mistaken for an empty one".
 */
describe("BudgetLedger persistence", () => {
  it("never leaves the file truncated, and never leaves a temp file behind", () => {
    const path = ledgerPath();
    const ledger = new BudgetLedger(path);
    ledger.addCustomer("aiotlab", 50);
    ledger.addSeat("claude-max-1", 18000, 2_000_000);

    // Every save has to land whole. Reading between them is exactly what the
    // parallel test files were doing when they flaked.
    for (let i = 0; i < 20; i++) {
      ledger.recordSpend("aiotlab", 0.5);
      expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
    }

    // The rename is what makes the write atomic; a lingering .tmp would mean it
    // never happened, and a fixed temp name would put two writers back in a race.
    expect(readdirSync(join(path, ".."))).toEqual(["ledger.json"]);
  });

  it("reloads spend and quota across a restart", () => {
    const path = ledgerPath();
    const first = new BudgetLedger(path);
    first.addCustomer("aiotlab", 50);
    first.recordSpend("aiotlab", 7.5);

    const reopened = new BudgetLedger(path);
    expect(reopened.snapshot().customers[0].spentUsd).toBe(7.5);
  });

  it("refuses to start on a damaged ledger, and says which file", () => {
    const path = ledgerPath();
    writeFileSync(path, ""); // what a kill mid-write used to leave behind

    // The old behavior was a bare `SyntaxError: Unexpected end of JSON input`
    // pointing at budget.ts, which says nothing about which file to go fix.
    expect(() => new BudgetLedger(path)).toThrow(/unreadable/);
    expect(() => new BudgetLedger(path)).toThrow(path);
  });

  it("does not silently reset budgets when the ledger is damaged", () => {
    const path = ledgerPath();
    const ledger = new BudgetLedger(path);
    ledger.addCustomer("aiotlab", 50);
    ledger.recordSpend("aiotlab", 49);
    writeFileSync(path, "{ this is not json");

    // Starting fresh here would hand a customer who has spent 49 of 50 a full
    // cap again. Not starting is the safer failure, so it must stay a throw.
    expect(() => new BudgetLedger(path)).toThrow();
  });

  it("treats a well-formed but empty ledger as empty rather than throwing", () => {
    const path = ledgerPath();
    writeFileSync(path, "{}");

    const ledger = new BudgetLedger(path);
    expect(ledger.snapshot().customers).toEqual([]);
    expect(ledger.snapshot().seats).toEqual([]);
  });
});
