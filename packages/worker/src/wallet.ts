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
  private requestInFlight = false;

  applyGrant(grant: BudgetGrant): void {
    this.usdRemaining = grant.usdAllowance;
    this.quotaRemaining = grant.quotaTokens;
    this.requestInFlight = false;
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

  /** true when a top-up request should be sent (low and not already asked) */
  shouldRequestTopUp(): boolean {
    if (this.requestInFlight) return false;
    const low = this.usdRemaining < 0.5 || this.quotaRemaining < 10_000;
    if (low) this.requestInFlight = true;
    return low;
  }

  snapshot() {
    return { usdRemaining: this.usdRemaining, quotaRemaining: this.quotaRemaining };
  }
}
