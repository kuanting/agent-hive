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

/**
 * A monthly USD cap on one member or one department, inside a customer's cap.
 *
 * Keyed `member:<id>` or `dept:<id>`. Spend is charged to the customer AND to
 * every principal the task ran for, so the tightest of the three is what binds
 * (see `LedgerView`). A null cap tracks spend without limiting it, which is what
 * the owner's dashboard needs for members nobody has budgeted yet.
 */
export interface PrincipalState {
  key: string;
  capUsd: number | null;
  spentUsd: number;
  /** first instant of the calendar month (UTC) this spend belongs to */
  periodStart: number;
}

interface LedgerFile {
  customers: Record<string, CustomerState>;
  seats: Record<string, SeatState>;
  /** absent in ledgers written before member budgets existed */
  principals?: Record<string, PrincipalState>;
}

/**
 * The three questions `decide` asks of a ledger, and nothing else.
 *
 * Narrow on purpose: member routing hands `decide` a view whose `usdRemaining`
 * is the tightest of the company, member and department caps, and `decide`
 * needs no idea that members exist for that to bind.
 */
export interface LedgerView {
  usdRemaining(customerId: string): number;
  quotaRemaining(seatId: string): number;
  secondsToReset(seatId: string): number;
}

export function monthStart(at = Date.now()): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
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
  private principals = new Map<string, PrincipalState>();

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
      this.principals = new Map(Object.entries(raw?.principals ?? {}));
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

  /**
   * Set (or clear, with null) a member's or department's monthly cap. Spend so
   * far this month is kept: lowering a cap below it simply leaves nothing left.
   */
  setPrincipalCap(key: string, capUsd: number | null): void {
    const p = this.principal(key);
    if (p.capUsd === capUsd) return;
    p.capUsd = capUsd;
    this.save();
  }

  /** what is left for one principal this month; Infinity when uncapped */
  principalRemaining(key: string): number {
    const p = this.principals.get(key);
    if (!p) return Number.POSITIVE_INFINITY;
    this.rollPeriod(p);
    return p.capUsd === null ? Number.POSITIVE_INFINITY : Math.max(0, p.capUsd - p.spentUsd);
  }

  /** Charge spend to principals in addition to the customer. Call alongside recordSpend. */
  recordPrincipalSpend(keys: string[], usd: number): void {
    if (usd <= 0 || keys.length === 0) return;
    for (const key of keys) {
      const p = this.principal(key);
      p.spentUsd += usd;
    }
    this.save();
  }

  /**
   * A view of this ledger as one member sees it: the customer's remaining USD is
   * clipped to the tightest principal cap. Seats are untouched, since a prepaid
   * seat costs nobody anything extra per call.
   */
  viewFor(principalKeys: string[]): LedgerView {
    return {
      usdRemaining: (customerId) =>
        Math.min(this.usdRemaining(customerId), ...principalKeys.map((k) => this.principalRemaining(k))),
      quotaRemaining: (seatId) => this.quotaRemaining(seatId),
      secondsToReset: (seatId) => this.secondsToReset(seatId),
    };
  }

  private principal(key: string): PrincipalState {
    let p = this.principals.get(key);
    if (!p) {
      p = { key, capUsd: null, spentUsd: 0, periodStart: monthStart() };
      this.principals.set(key, p);
    }
    this.rollPeriod(p);
    return p;
  }

  /** Monthly budgets start over on the first of the month, the way an owner reads a bill. */
  private rollPeriod(p: PrincipalState): void {
    const current = monthStart();
    if (p.periodStart !== current) {
      p.periodStart = current;
      p.spentUsd = 0;
    }
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
      principals: [...this.principals.values()].map((p) => ({ ...p, remaining: this.principalRemaining(p.key) })),
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
      principals: Object.fromEntries(this.principals),
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
