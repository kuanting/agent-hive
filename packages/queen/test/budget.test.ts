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

describe("caps come from the profile, spend comes from the ledger", () => {
  it("takes a raised cap on the next start and keeps what was already spent", () => {
    // `addCustomer` was insert-only, so the cap was frozen at whatever it was the
    // first time ledger.json was written and editing budget.capUsd in the yaml
    // did nothing at all — silently, forever. Unworkable the moment more than one
    // person shares a budget somebody has to adjust.
    const path = ledgerPath();
    const first = new BudgetLedger(path);
    first.addCustomer("aiotlab", 50);
    first.recordSpend("aiotlab", 10);

    const reopened = new BudgetLedger(path);
    reopened.addCustomer("aiotlab", 100); // the yaml was edited between starts
    expect(reopened.snapshot().customers[0]).toMatchObject({ capUsd: 100, spentUsd: 10 });
    expect(reopened.usdRemaining("aiotlab")).toBe(90);
  });

  it("takes a lowered cap too, even below what has been spent", () => {
    const ledger = new BudgetLedger();
    ledger.addCustomer("aiotlab", 50);
    ledger.recordSpend("aiotlab", 20);
    ledger.addCustomer("aiotlab", 5);
    // Not negative: a cap cut below current spend means nothing more may be
    // spent, which is what the operator asked for.
    expect(ledger.usdRemaining("aiotlab")).toBe(0);
  });
});

describe("spend has a user inside the customer", () => {
  it("records one person's spend alongside the customer's own total", () => {
    const ledger = new BudgetLedger();
    ledger.addCustomer("aiotlab", 50);
    ledger.recordSpend("aiotlab", 3, "ada");
    ledger.recordSpend("aiotlab", 2, "mei");
    ledger.recordSpend("aiotlab", 1); // an unattributed path, still the customer's

    // The customer is still the budget; the user is a dimension within it.
    expect(ledger.snapshot().customers[0].spentUsd).toBe(6);
    expect(ledger.userSpent("aiotlab", "ada")).toBe(3);
    expect(ledger.userSpent("aiotlab", "mei")).toBe(2);
  });

  it("round-trips per-user spend across a restart", () => {
    const path = ledgerPath();
    const first = new BudgetLedger(path);
    first.addCustomer("aiotlab", 50);
    first.recordSpend("aiotlab", 4.25, "ada");

    const reopened = new BudgetLedger(path);
    expect(reopened.userSpent("aiotlab", "ada")).toBe(4.25);
    expect(reopened.snapshot().users).toEqual([
      { customerId: "aiotlab", userId: "ada", spentUsd: 4.25, capUsd: undefined },
    ]);
  });

  it("loads a ledger written before users existed, then gains them", () => {
    const path = ledgerPath();
    writeFileSync(
      path,
      JSON.stringify({ customers: { aiotlab: { customerId: "aiotlab", capUsd: 50, spentUsd: 7 } }, seats: {} }),
    );

    const ledger = new BudgetLedger(path);
    expect(ledger.snapshot().users).toEqual([]);
    expect(ledger.usdRemaining("aiotlab")).toBe(43);
    ledger.recordSpend("aiotlab", 1, "ada");
    expect(new BudgetLedger(path).userSpent("aiotlab", "ada")).toBe(1);
  });

  it("narrows what a task may spend to the smaller of the two caps", () => {
    // Laid down here and consumed by the enforcement pass. A per-user allowance
    // can only tighten: one larger than what the customer has left would let a
    // person spend a budget that is already gone.
    const ledger = new BudgetLedger();
    ledger.addCustomer("aiotlab", 50);
    ledger.setUserCaps("aiotlab", { capUsd: 5, overrides: { mei: 40 } });

    expect(ledger.spendableUsd("aiotlab", "ada")).toBe(5);
    expect(ledger.spendableUsd("aiotlab", "mei")).toBe(40);
    // No user named, or no allowance declared: exactly today's behaviour.
    expect(ledger.spendableUsd("aiotlab")).toBe(50);
    expect(ledger.spendableUsd("demo-lab", "ada")).toBe(0);

    ledger.recordSpend("aiotlab", 4, "ada");
    expect(ledger.spendableUsd("aiotlab", "ada")).toBe(1);
    // The customer's cap still binds over a larger allowance: mei is allowed 40
    // and has spent nothing, but the budget she would draw from is gone.
    ledger.recordSpend("aiotlab", 49);
    expect(ledger.spendableUsd("aiotlab", "mei")).toBe(0);
  });

  it("drops a departed customer's users, but never a user on their own", () => {
    const ledger = new BudgetLedger();
    ledger.addCustomer("aiotlab", 50);
    ledger.addCustomer("stale", 10);
    ledger.recordSpend("aiotlab", 1, "ada");
    ledger.recordSpend("stale", 1, "bob");

    ledger.reconcile(["aiotlab"], []);

    // A user row is created by spending, not by configuration, so there is no
    // "no longer configured" state for one to be in — pruning individually would
    // erase the spend of everyone quiet since the last restart.
    expect(ledger.userSpent("aiotlab", "ada")).toBe(1);
    expect(ledger.userSpent("stale", "bob")).toBe(0);
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
