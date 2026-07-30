import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface SeatState {
  seatId: string;
  windowSeconds: number;
  tokensPerWindow: number;
  usedTokens: number;
  windowStart: number;
}

export interface CustomerState {
  customerId: string;
  capUsd: number;
  spentUsd: number;
}

interface LedgerFile {
  customers: Record<string, CustomerState>;
  seats: Record<string, SeatState>;
}

/**
 * Dual-currency budget ledger.
 * USD tracks per-token API spend against per-customer caps.
 * Subscription seats (Claude Max, ChatGPT Pro, Ollama cloud plans) are prepaid:
 * they meter rolling token-quota windows instead of dollars, and refill on
 * their own when the window rolls over.
 */
export class BudgetLedger {
  private customers = new Map<string, CustomerState>();
  private seats = new Map<string, SeatState>();

  constructor(private persistPath?: string) {
    if (persistPath && existsSync(persistPath)) {
      let raw: LedgerFile | null;
      try {
        raw = JSON.parse(readFileSync(persistPath, "utf8")) as LedgerFile;
      } catch (err) {
        // Deliberately fatal, and deliberately not a silent reset. This file is
        // the record of what has been spent and how much seat quota is left;
        // starting from an empty one would hand every customer a fresh budget
        // and every seat a full window, which is a worse outcome than refusing
        // to boot. `save()` below is atomic, so this should now be unreachable
        // from our own writes — if it fires, something else damaged the file,
        // and the operator needs to know which file and why.
        throw new Error(
          `budget ledger at ${persistPath} is unreadable: ${err instanceof Error ? err.message : String(err)}. ` +
            `Restore it from a backup, or delete it to start a fresh ledger.`,
        );
      }
      this.customers = new Map(Object.entries(raw?.customers ?? {}));
      this.seats = new Map(Object.entries(raw?.seats ?? {}));
    }
  }

  addCustomer(customerId: string, capUsd: number): void {
    if (!this.customers.has(customerId)) {
      this.customers.set(customerId, { customerId, capUsd, spentUsd: 0 });
    }
    this.save();
  }

  addSeat(seatId: string, windowSeconds: number, tokensPerWindow: number): void {
    if (!this.seats.has(seatId)) {
      this.seats.set(seatId, {
        seatId,
        windowSeconds,
        tokensPerWindow,
        usedTokens: 0,
        windowStart: Date.now(),
      });
    }
    this.save();
  }

  /**
   * Drop persisted customers/seats that are no longer configured, so a removed
   * customer profile doesn't linger in the ledger (and in /status) forever.
   * Spend and quota-window state for still-configured ids is preserved.
   */
  reconcile(customerIds: Iterable<string>, seatIds: Iterable<string>): void {
    const keepCustomers = new Set(customerIds);
    const keepSeats = new Set(seatIds);
    for (const id of [...this.customers.keys()]) if (!keepCustomers.has(id)) this.customers.delete(id);
    for (const id of [...this.seats.keys()]) if (!keepSeats.has(id)) this.seats.delete(id);
    this.save();
  }

  usdRemaining(customerId: string): number {
    const c = this.customers.get(customerId);
    return c ? Math.max(0, c.capUsd - c.spentUsd) : 0;
  }

  recordSpend(customerId: string, usd: number): void {
    const c = this.customers.get(customerId);
    if (c) c.spentUsd += usd;
    this.save();
  }

  private rollWindow(seat: SeatState): void {
    const elapsed = (Date.now() - seat.windowStart) / 1000;
    if (elapsed >= seat.windowSeconds) {
      seat.usedTokens = 0;
      seat.windowStart = Date.now();
    }
  }

  quotaRemaining(seatId: string): number {
    const seat = this.seats.get(seatId);
    if (!seat) return 0;
    this.rollWindow(seat);
    return Math.max(0, seat.tokensPerWindow - seat.usedTokens);
  }

  recordQuotaUse(seatId: string, tokens: number): void {
    const seat = this.seats.get(seatId);
    if (!seat) return;
    this.rollWindow(seat);
    seat.usedTokens += tokens;
    this.save();
  }

  /** seconds until the seat's current window resets (0 if seat unknown) */
  secondsToReset(seatId: string): number {
    const seat = this.seats.get(seatId);
    if (!seat) return 0;
    return Math.max(0, seat.windowSeconds - (Date.now() - seat.windowStart) / 1000);
  }

  grantLease(usdAllowance: number, quotaTokens: number, periodSeconds: number) {
    return { leaseId: randomUUID(), usdAllowance, quotaTokens, periodSeconds };
  }

  snapshot() {
    return {
      customers: [...this.customers.values()],
      seats: [...this.seats.values()].map((s) => ({
        ...s,
        remaining: this.quotaRemaining(s.seatId),
      })),
    };
  }

  /**
   * Write the ledger atomically: temp file, then rename onto the target.
   *
   * `writeFileSync` straight to the target truncates before it writes, so anyone
   * reading during that window sees an empty or half-written file. That is not a
   * theoretical race — it made two test files sharing this path flake, and in
   * production it means a Queen killed mid-write leaves a truncated ledger that
   * the next start cannot parse. `rename` is atomic within a filesystem, so a
   * reader sees the whole old file or the whole new one, never the middle.
   *
   * Two details carry the guarantee. The temp name is unique per write rather
   * than a fixed `.tmp`, because two writers sharing one temp path would just
   * race on that instead — the same bug moved one file over. And the temp sits
   * in the target's own directory, so the rename never crosses a filesystem
   * boundary and quietly degrades into a non-atomic copy.
   */
  private save(): void {
    if (!this.persistPath) return;
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const out: LedgerFile = {
      customers: Object.fromEntries(this.customers),
      seats: Object.fromEntries(this.seats),
    };
    const tmp = `${this.persistPath}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(out, null, 2));
      renameSync(tmp, this.persistPath);
    } catch (err) {
      // Leave the previous ledger in place and take the temp file with us; a
      // failed save must not also litter the data directory.
      rmSync(tmp, { force: true });
      throw err;
    }
  }
}
