import type { BudgetGrant } from "@hive/shared";

/**
 * Local lease wallet: the worker spends autonomously against its lease and
 * asks the Queen for a top-up when it runs low. With no USD left the worker
 * keeps serving free work (tiers 3/4), so an exhausted budget never idles the
 * hive.
 */
export class LeaseWallet {
  private usdRemaining = 0;
  private quotaRemaining = 0;
  private requestedAt: number | undefined;

  constructor(
    /**
     * How long an unanswered top-up request suppresses the next one.
     *
     * There used to be no window: a boolean latch was set when a request went out
     * and cleared only by the grant. That is safe only if the transport cannot
     * lose a message — and neither backend guarantees that (a publish to an
     * exchange or topic with no consumer yet is dropped silently). One lost grant
     * therefore disabled per-token work for the rest of the process lifetime,
     * with nothing logged and nothing to notice it: the Queen keeps no lease
     * state, so it cannot tell either.
     *
     * A window keeps the useful half — don't spam the Queen while one request is
     * outstanding — and drops the failure mode.
     */
    private readonly requestTimeoutMs = Number(process.env.HIVE_LEASE_RETRY_MS ?? 30_000),
    private readonly now: () => number = () => Date.now(),
  ) {}

  applyGrant(grant: BudgetGrant): void {
    this.usdRemaining = grant.usdAllowance;
    this.quotaRemaining = grant.quotaTokens;
    this.requestedAt = undefined;
  }

  canSpendUsd(usd: number): boolean {
    return this.usdRemaining >= usd;
  }

  canSpendQuota(tokens: number): boolean {
    return this.quotaRemaining >= tokens;
  }

  spend(usd: number, quotaTokens: number): void {
    this.usdRemaining = Math.max(0, this.usdRemaining - usd);
    this.quotaRemaining = Math.max(0, this.quotaRemaining - quotaTokens);
  }

  /** true when a top-up request should be sent: low, and no request outstanding within the retry window */
  shouldRequestTopUp(): boolean {
    const low = this.usdRemaining < 0.5 || this.quotaRemaining < 10_000;
    if (!low) return false;
    const outstanding = this.requestedAt !== undefined && this.now() - this.requestedAt < this.requestTimeoutMs;
    if (outstanding) return false;
    this.requestedAt = this.now();
    return true;
  }

  snapshot() {
    return { usdRemaining: this.usdRemaining, quotaRemaining: this.quotaRemaining };
  }
}
