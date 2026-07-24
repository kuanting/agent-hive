import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../src/budget.js";

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
