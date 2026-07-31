import {
  adequateTiers,
  allowedByConfidentiality,
  costRank,
  type CapabilityRecord,
  type Difficulty,
  type TaskSpec,
  type Tier,
} from "@hive/shared";
import type { BudgetLedger } from "./budget.js";

export interface RouteDecision {
  action: "dispatch" | "defer";
  tier: Tier;
  capability?: CapabilityRecord;
  degraded: boolean;
  maxUsd: number;
  /** seconds to wait before re-deciding, when action = defer */
  retryInSeconds?: number;
  reason: string;
}

const DEFAULT_TASK_USD = 2.0;

/**
 * Per-customer routing policy.
 *
 * `onBudgetBlock`: what to do when no affordable adequate capability exists but
 * both fallbacks are viable — wait for a subscription seat window to reset (full
 * quality, higher latency) or degrade to a local model now (lower quality, no
 * wait). Urgent tasks never wait regardless.
 *
 * `routing`: which way to lean when several capabilities are adequate.
 * `cost-first` (default) takes the cheapest, and escalates only after a failure.
 * `completion-first` prefers the more capable one *within the same cost class*,
 * trading a higher first-attempt cost for a lower chance of paying for the
 * attempt twice. It is a preference over ordering only: budget and
 * confidentiality remain hard constraints and are untouched by it.
 */
export interface RoutePolicy {
  onBudgetBlock: "wait" | "degrade";
  routing?: "cost-first" | "completion-first";
}

export const DEFAULT_ROUTE_POLICY: RoutePolicy = { onBudgetBlock: "wait", routing: "cost-first" };

/**
 * Cheapest adequate capability wins, ranked by billing type, not tier number.
 * Order: free tools, local models, subscription seats (Ollama cloud before
 * frontier), per-token API last. Per-token is dispatched only for urgent
 * overflow; non-urgent tasks defer until a subscription quota window resets
 * instead of paying retail.
 */
export function decide(
  spec: TaskSpec,
  difficulty: Difficulty,
  capabilities: CapabilityRecord[],
  ledger: BudgetLedger,
  estimatedUsd = DEFAULT_TASK_USD,
  policy: RoutePolicy = DEFAULT_ROUTE_POLICY,
): RouteDecision {
  const tiers = new Set<Tier>(adequateTiers(difficulty));
  const skillOk = (c: CapabilityRecord) =>
    spec.skills.length === 0 || c.skills.some((s) => spec.skills.includes(s)) || c.tier === 4;

  // For hard tasks the frontier seat beats the mid-tier seat: both are prepaid
  // (marginal cost ~0), so capability wins at equal cost class.
  //
  // `completion-first` extends that same reasoning to every difficulty rather
  // than only `complex`: among capabilities that cost the customer nothing extra
  // — free tools, local models, and seats already paid for — prefer the more
  // capable one. A task that completes on attempt 1 at tier 1 costs the customer
  // exactly what a task that fails at tier 3 and then succeeds at tier 1 costs,
  // minus the failed attempt and its latency. The knob cannot reach per-token
  // billing, which stays last and stays urgent-only, so it can never turn a
  // preference into a bill.
  const preferCapability = policy.routing === "completion-first";
  /** Strictly greater than any completion-first rank below, so per-token stays last. */
  const PER_TOKEN_LAST = 100;
  const rank = (c: CapabilityRecord): number => {
    if (difficulty === "complex" && c.billing === "subscription") return c.tier === 1 ? 2 : 3;
    if (preferCapability) {
      // Per-token is never reordered: it is the only billing that spends real
      // money per call, and `decide` below still refuses it for non-urgent work.
      // Everything else costs the customer nothing extra, so within that band
      // order by capability — tier 1 is the most capable.
      return c.billing === "per-token" ? PER_TOKEN_LAST : c.tier;
    }
    return costRank(c);
  };

  const eligible = capabilities
    .filter((c) => c.tier !== 4) // tool matching happens before tier mapping
    .filter((c) => tiers.has(c.tier))
    .filter((c) => allowedByConfidentiality(c, spec.sensitivity));

  /**
   * Skills narrow the field when the hive can honor them, and are ignored when
   * it can't. The planner emits free-form skill tags, so a task can ask for a
   * skill no capability advertises; treating that as a hard filter would empty
   * the candidate list and strand the task on a 60s defer loop forever. Tier,
   * budget and confidentiality are constraints — an unmatched skill is only an
   * unmet preference. (QueenCore applies the same reasoning to the routing key,
   * falling back to "general".)
   */
  const narrow = <T>(list: T[], keep: (item: T) => boolean): T[] => {
    const kept = list.filter(keep);
    return kept.length > 0 ? kept : list;
  };

  const candidates = narrow(eligible, skillOk).sort((a, b) => rank(a) - rank(b));

  for (const cap of candidates) {
    switch (cap.billing) {
      case "free":
      case "local":
        return { action: "dispatch", tier: cap.tier, capability: cap, degraded: false, maxUsd: 0, reason: "free capacity" };
      case "subscription": {
        const seatId = cap.quotaWindow?.seatId ?? `${cap.runtime}:${cap.model}`;
        if (ledger.quotaRemaining(seatId) > 0) {
          return { action: "dispatch", tier: cap.tier, capability: cap, degraded: false, maxUsd: 0, reason: `subscription seat ${seatId}` };
        }
        break; // window empty, try the next candidate
      }
      case "per-token": {
        if (spec.urgency !== "urgent") break; // never burn API dollars on non-urgent work
        if (ledger.usdRemaining(spec.customerId) >= estimatedUsd) {
          return {
            action: "dispatch",
            tier: cap.tier,
            capability: cap,
            degraded: false,
            maxUsd: Math.min(estimatedUsd, ledger.usdRemaining(spec.customerId)),
            reason: "urgent overflow to per-token API",
          };
        }
        break;
      }
    }
  }

  // Nothing adequate is affordable right now. Two fallbacks may be viable: wait
  // for a subscription seat window to reset, or degrade to a local model now. The
  // customer policy picks the preferred order; urgent work never waits.
  const exhaustedSeat = candidates.find((c) => c.billing === "subscription");
  const canWait = exhaustedSeat && spec.urgency !== "urgent";

  const localFallback = narrow(
    capabilities
      .filter((c) => (c.billing === "local" || c.billing === "free") && c.tier !== 4)
      .filter((c) => allowedByConfidentiality(c, spec.sensitivity)),
    skillOk,
  ).sort((a, b) => a.tier - b.tier)[0];

  const deferForSeat = (): RouteDecision => {
    const seatId = exhaustedSeat!.quotaWindow?.seatId ?? `${exhaustedSeat!.runtime}:${exhaustedSeat!.model}`;
    const wait = Math.max(30, Math.ceil(ledger.secondsToReset(seatId)));
    return {
      action: "defer",
      tier: exhaustedSeat!.tier,
      degraded: false,
      maxUsd: 0,
      retryInSeconds: wait,
      reason: `quota window on ${seatId} empty, waiting ${wait}s for reset`,
    };
  };
  const degradeToLocal = (): RouteDecision => ({
    action: "dispatch",
    tier: localFallback!.tier,
    capability: localFallback!,
    degraded: true,
    maxUsd: 0,
    reason: "no affordable adequate capability, degraded to local",
  });

  const order =
    policy.onBudgetBlock === "degrade"
      ? [localFallback ? degradeToLocal : null, canWait ? deferForSeat : null]
      : [canWait ? deferForSeat : null, localFallback ? degradeToLocal : null];
  for (const choose of order) if (choose) return choose();

  return { action: "defer", tier: 3, degraded: false, maxUsd: 0, retryInSeconds: 60, reason: "no capability available" };
}
