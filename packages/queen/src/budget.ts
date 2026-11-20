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

/** What one person has spent inside their customer's cap. */
export interface UserState {
  customerId: string;
  userId: string;
  spentUsd: number;
}

interface LedgerFile {
  /**
   * Absent means the file predates the user dimension. Never fatal on its own —
   * the shape below is additive, so an old file loads as a ledger with nobody in
   * it, and a new file read by an older Queen has one key it ignores. Present
   * only so a human reading the JSON knows which shape they are looking at.
   */
  version?: number;
  customers: Record<string, CustomerState>;
  seats: Record<string, SeatState>;
  /**
   * customerId -> userId -> spend. Nested rather than keyed on
   * `"customer/user"`, because a userId can now arrive from an HTTP header and
   * there is no separator that is guaranteed not to appear inside one.
   *
   * Spend only. Caps are deliberately absent — see `setUserCaps`.
   */
  users?: Record<string, Record<string, { spentUsd: number }>>;
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

const LEDGER_VERSION = 2;

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
  /** customerId -> userId -> spend. Written on first spend; never configured. */
  private users = new Map<string, Map<string, number>>();
  /**
   * Per-user allowances, from the customer profile.
   *
   * In memory only, re-derived from `customers/*.yaml` on every start, and that
   * is the whole point rather than an omission: `CustomerState.capUsd` is
   * persisted, and persisting it is precisely why editing a cap in the yaml did
   * nothing for as long as a ledger file existed. Config is the authority on what
   * may be spent; the ledger is the authority on what has been. Keeping the two
   * in different places is what stops that bug recurring here.
   */
  private userCaps = new Map<string, { capUsd?: number; overrides: Record<string, number> }>();

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
      for (const [customerId, rows] of Object.entries(raw?.users ?? {})) {
        this.users.set(customerId, new Map(Object.entries(rows).map(([userId, u]) => [userId, u.spentUsd])));
      }
    }
  }

  /**
   * Upsert, not insert.
   *
   * This was insert-only, which meant the cap was frozen at whatever it happened
   * to be the first time `data/ledger.json` was written: editing `budget.capUsd`
   * in `customers/*.yaml` afterwards did nothing at all, silently, forever. The
   * profile is the authority on the cap and the ledger is the authority on the
   * spend, so a cap edited in yaml takes effect on the next start while what has
   * already been spent survives it.
   *
   * Note this is NOT applied to `addSeat` below, where first-write-wins is
   * documented behaviour that several profiles rely on.
   */
  addCustomer(customerId: string, capUsd: number): void {
    const spentUsd = this.customers.get(customerId)?.spentUsd ?? 0;
    this.customers.set(customerId, { customerId, capUsd, spentUsd });
    this.save();
  }

  /**
   * Record a customer's per-user allowances, as declared in its profile.
   *
   * In memory, never persisted — see the note on `userCaps`. An absent `capUsd`
   * means no per-user limit, which is exactly the behaviour before this existed.
   */
  setUserCaps(customerId: string, caps: { capUsd?: number; overrides?: Record<string, number> }): void {
    this.userCaps.set(customerId, { capUsd: caps.capUsd, overrides: caps.overrides ?? {} });
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
    // Users go with their customer and never on their own: a user row is created
    // by spending, not by configuration, so there is no "no longer configured"
    // state for one to be in. Pruning individually would delete the spend of
    // everyone who has not asked for anything since the last restart.
    for (const id of [...this.users.keys()]) if (!keepCustomers.has(id)) this.users.delete(id);
    this.save();
  }

  usdRemaining(customerId: string): number {
    const c = this.customers.get(customerId);
    return c ? Math.max(0, c.capUsd - c.spentUsd) : 0;
  }

  /** What one person has spent against their customer's budget. */
  userSpent(customerId: string, userId: string): number {
    return this.users.get(customerId)?.get(userId) ?? 0;
  }

  /** That person's own allowance, if their customer declared one. */
  userCap(customerId: string, userId: string): number | undefined {
    const caps = this.userCaps.get(customerId);
    if (!caps) return undefined;
    return caps.overrides[userId] ?? caps.capUsd;
  }

  /**
   * What this task may actually spend: the smallest of every cap that applies.
   *
   * A per-user allowance can only ever tighten, never widen — a user cap larger
   * than what the customer has left would let one person spend a budget that is
   * already gone.
   */
  spendableUsd(customerId: string, userId?: string): number {
    const customerRemaining = this.usdRemaining(customerId);
    if (!userId) return customerRemaining;
    const cap = this.userCap(customerId, userId);
    if (cap === undefined) return customerRemaining;
    return Math.min(customerRemaining, Math.max(0, cap - this.userSpent(customerId, userId)));
  }

  /**
   * @param userId when the intake knew who was asking. Recorded alongside the
   * customer's own total rather than instead of it: the customer is still the
   * budget, and the user is a dimension within it.
   */
  recordSpend(customerId: string, usd: number, userId?: string): void {
    const c = this.customers.get(customerId);
    if (c) c.spentUsd += usd;
    if (userId) {
      const rows = this.users.get(customerId) ?? new Map<string, number>();
      rows.set(userId, (rows.get(userId) ?? 0) + usd);
      this.users.set(customerId, rows);
    }
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
      /**
       * Additive: every existing reader of /status destructures `customers` and
       * `seats`, so nothing has to change to keep working, and anything that
       * wants to show who spent what now can.
       */
      users: [...this.users.entries()].flatMap(([customerId, rows]) =>
        [...rows.entries()].map(([userId, spentUsd]) => ({
          customerId,
          userId,
          spentUsd,
          capUsd: this.userCap(customerId, userId),
        })),
      ),
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
      version: LEDGER_VERSION,
      customers: Object.fromEntries(this.customers),
      seats: Object.fromEntries(this.seats),
      principals: Object.fromEntries(this.principals),
      users: Object.fromEntries(
        [...this.users.entries()].map(([customerId, rows]) => [
          customerId,
          Object.fromEntries([...rows.entries()].map(([userId, spentUsd]) => [userId, { spentUsd }])),
        ]),
      ),
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
