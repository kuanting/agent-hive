import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
      const raw = JSON.parse(readFileSync(persistPath, "utf8")) as LedgerFile;
      this.customers = new Map(Object.entries(raw.customers));
      this.seats = new Map(Object.entries(raw.seats));
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

  private save(): void {
    if (!this.persistPath) return;
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const out: LedgerFile = {
      customers: Object.fromEntries(this.customers),
      seats: Object.fromEntries(this.seats),
    };
    writeFileSync(this.persistPath, JSON.stringify(out, null, 2));
  }
}
