import { expect, it } from "vitest";
import { LeaseWallet } from "../src/wallet.js";

const grant = (usd: number, quota = 100_000) => ({
  kind: "budget.grant" as const,
  agentId: "metered-bee-1",
  leaseId: "lease-1",
  usdAllowance: usd,
  quotaTokens: quota,
  periodSeconds: 3600,
});

/**
 * The invariant behind the worker's startup ordering: a wallet with no lease
 * cannot spend anything. The budget guard reads that as "can't afford it" and
 * refuses per-token work — so a worker must hold a lease BEFORE it subscribes to
 * task queues, or the first per-token task is refused for a reason that has
 * nothing to do with the task.
 */
it("cannot spend before a grant arrives", () => {
  const wallet = new LeaseWallet();
  expect(wallet.snapshot().usdRemaining).toBe(0);
  expect(wallet.canSpendUsd(0.004)).toBe(false);
  expect(wallet.canSpendUsd(0)).toBe(true); // free work is always allowed
});

it("can spend up to the granted allowance", () => {
  const wallet = new LeaseWallet();
  wallet.applyGrant(grant(5));
  expect(wallet.canSpendUsd(4.99)).toBe(true);
  expect(wallet.canSpendUsd(5.01)).toBe(false);
});

it("never goes negative, so tiers 3/4 keep working at zero budget", () => {
  const wallet = new LeaseWallet();
  wallet.applyGrant(grant(1));
  wallet.spend(10, 999_999);
  expect(wallet.snapshot()).toEqual({ usdRemaining: 0, quotaRemaining: 0 });
  expect(wallet.canSpendUsd(0)).toBe(true);
});

it("asks for a top-up once, not on every task", () => {
  const wallet = new LeaseWallet();
  wallet.applyGrant(grant(0.4)); // below the $0.50 low-water mark
  expect(wallet.shouldRequestTopUp()).toBe(true);
  expect(wallet.shouldRequestTopUp()).toBe(false); // already outstanding
  wallet.applyGrant(grant(5));
  expect(wallet.shouldRequestTopUp()).toBe(false); // topped up
});

it("asks again if the grant never comes back", () => {
  // This used to be a permanent latch, cleared only by applyGrant. That is safe
  // only on a transport that cannot lose a message, and neither backend is: a
  // publish to a topic or exchange with no consumer yet is dropped silently. One
  // lost grant therefore disabled per-token work for the rest of the process
  // lifetime — silently, and unnoticeably, since the Queen keeps no lease state
  // and so cannot tell either. The window keeps the useful half (don't spam while
  // a request is outstanding) without the dead end.
  let now = 1_000;
  const wallet = new LeaseWallet(30_000, () => now);
  wallet.applyGrant(grant(0.4));

  expect(wallet.shouldRequestTopUp()).toBe(true);
  now += 29_000;
  expect(wallet.shouldRequestTopUp()).toBe(false); // still inside the window
  now += 2_000;
  expect(wallet.shouldRequestTopUp()).toBe(true); // grant never arrived; ask again
});
