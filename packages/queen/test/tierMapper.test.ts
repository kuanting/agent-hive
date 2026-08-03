import { beforeEach, describe, expect, it } from "vitest";
import { TaskSpec, type CapabilityRecord } from "@hive/shared";
import { BudgetLedger } from "../src/budget.js";
import { decide } from "../src/tierMapper.js";

const spec = (partial: Partial<TaskSpec> = {}): TaskSpec =>
  TaskSpec.parse({ customerId: "aiotlab", title: "t", input: "x", ...partial });

const CAPS: CapabilityRecord[] = [
  { runtime: "opencode", model: "qwen3.5:4b", tier: 3, billing: "local", skills: ["general", "coding"] },
  {
    runtime: "opencode",
    model: "qwen3.5:cloud",
    tier: 2,
    billing: "subscription",
    skills: ["general", "coding"],
    quotaWindow: { seatId: "ollama-cloud-1", windowSeconds: 3600, tokensPerWindow: 1000 },
  },
  {
    runtime: "claude-code",
    model: "sonnet",
    tier: 1,
    billing: "subscription",
    skills: ["general", "coding"],
    quotaWindow: { seatId: "claude-max-1", windowSeconds: 18000, tokensPerWindow: 1000 },
  },
  { runtime: "opencode", model: "claude-sonnet-4-6", tier: 2, billing: "per-token", skills: ["general", "coding"] },
];

describe("cheapest adequate capability routing", () => {
  let ledger: BudgetLedger;
  beforeEach(() => {
    ledger = new BudgetLedger();
    ledger.addCustomer("aiotlab", 50);
    ledger.addSeat("claude-max-1", 18000, 1000);
    ledger.addSeat("ollama-cloud-1", 3600, 1000);
  });

  it("simple work goes to free local capacity", () => {
    const d = decide(spec(), "simple", CAPS, ledger);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.billing).toBe("local");
    expect(d.tier).toBe(3);
  });

  it("complex work uses the tier-1 subscription seat while quota remains", () => {
    const d = decide(spec({ skills: ["coding"] }), "complex", CAPS, ledger);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.runtime).toBe("claude-code");
    expect(d.maxUsd).toBe(0);
  });

  it("prefers the cheaper Ollama cloud seat over the frontier seat when both are adequate", () => {
    const d = decide(spec(), "standard", CAPS, ledger);
    // standard admits tiers 3/2/1; local wins outright
    expect(d.capability?.billing).toBe("local");
    const noLocal = CAPS.filter((c) => c.billing !== "local");
    const d2 = decide(spec(), "standard", noLocal, ledger);
    expect(d2.capability?.quotaWindow?.seatId).toBe("ollama-cloud-1");
  });

  it("non-urgent complex work defers when all seats are exhausted (never burns API dollars)", () => {
    ledger.recordQuotaUse("claude-max-1", 1000);
    ledger.recordQuotaUse("ollama-cloud-1", 1000);
    const d = decide(spec({ skills: ["coding"] }), "complex", CAPS, ledger);
    expect(d.action).toBe("defer");
    expect(d.retryInSeconds).toBeGreaterThan(0);
  });

  it("degrade policy runs local now instead of waiting for a seat reset", () => {
    ledger.recordQuotaUse("claude-max-1", 1000);
    ledger.recordQuotaUse("ollama-cloud-1", 1000);
    // same exhausted-seat, non-urgent case that defers under the default "wait" policy
    const waited = decide(spec({ skills: ["coding"] }), "complex", CAPS, ledger, 2);
    expect(waited.action).toBe("defer");
    const degraded = decide(spec({ skills: ["coding"] }), "complex", CAPS, ledger, 2, { onBudgetBlock: "degrade" });
    expect(degraded.action).toBe("dispatch");
    expect(degraded.degraded).toBe(true);
    expect(degraded.capability?.billing).toBe("local");
  });

  it("urgent complex work overflows to per-token API when quota is gone and budget allows", () => {
    ledger.recordQuotaUse("claude-max-1", 1000);
    ledger.recordQuotaUse("ollama-cloud-1", 1000);
    const d = decide(spec({ skills: ["coding"], urgency: "urgent" }), "complex", CAPS, ledger, 1.5);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.billing).toBe("per-token");
    expect(d.maxUsd).toBeGreaterThan(0);
  });

  it("urgent overflow degrades to local when the USD cap is spent", () => {
    ledger.recordQuotaUse("claude-max-1", 1000);
    ledger.recordQuotaUse("ollama-cloud-1", 1000);
    ledger.recordSpend("aiotlab", 50);
    const d = decide(spec({ skills: ["coding"], urgency: "urgent" }), "complex", CAPS, ledger, 1.5);
    expect(d.action).toBe("dispatch");
    expect(d.degraded).toBe(true);
    expect(d.capability?.billing).toBe("local");
  });

  it("confidential complex work never leaves the premises", () => {
    const d = decide(spec({ skills: ["coding"], sensitivity: "confidential" }), "complex", CAPS, ledger);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.billing).toBe("local");
    expect(d.degraded).toBe(true);
  });

  // The planner emits free-form skill tags, so a task can name a skill nothing
  // in the hive advertises. That is an unmet preference, not a reason to strand
  // the task on an empty candidate list and defer it every 60s forever.
  it("ignores a skill no capability advertises rather than stranding the task", () => {
    const d = decide(spec({ skills: ["log-extract"] }), "simple", CAPS, ledger);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.billing).toBe("local");
  });

  it("still honors a skill when some capability has it", () => {
    const writer: CapabilityRecord = {
      runtime: "opencode",
      model: "writer:8b",
      tier: 3,
      billing: "local",
      skills: ["writing"],
    };
    const d = decide(spec({ skills: ["writing"] }), "simple", [...CAPS, writer], ledger);
    expect(d.capability?.model).toBe("writer:8b");
  });

  const PERSONAL: CapabilityRecord = {
    runtime: "personal",
    model: "qwen3.5:4b",
    tier: 3,
    billing: "local",
    skills: ["email", "files", "calendar", "daily-report", "personal"],
  };

  it("routes a personal-skill task to the personal bee even beside the local bee", () => {
    // Both are tier-3 local (same cost rank); the skill filter is what decides.
    const d = decide(spec({ skills: ["email"] }), "standard", [...CAPS, PERSONAL], ledger);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.runtime).toBe("personal");
  });

  it("keeps confidential personal work on local billing", () => {
    const d = decide(
      spec({ skills: ["email"], sensitivity: "confidential" }),
      "standard",
      [...CAPS, PERSONAL],
      ledger,
    );
    expect(d.action).toBe("dispatch");
    expect(d.capability?.runtime).toBe("personal");
    expect(d.capability?.billing).toBe("local");
  });

  it("falls back past an unmatched skill to the local degrade path too", () => {
    // Seats empty, cap spent, and the skill unmatched: the degrade fallback must
    // still find a local capability instead of "no capability available".
    ledger.recordQuotaUse("claude-max-1", 1000);
    ledger.recordQuotaUse("ollama-cloud-1", 1000);
    ledger.recordSpend("aiotlab", 50);
    const d = decide(
      spec({ skills: ["log-extract"], urgency: "urgent" }),
      "complex",
      CAPS,
      ledger,
      2.0,
      { onBudgetBlock: "degrade" },
    );
    expect(d.action).toBe("dispatch");
    expect(d.capability?.billing).toBe("local");
    expect(d.degraded).toBe(true);
  });
});

describe("a specialist bee is not the default", () => {
  let ledger: BudgetLedger;
  beforeEach(() => {
    ledger = new BudgetLedger();
    ledger.addCustomer("aiotlab", 50);
  });

  /** The 🏡 personal bee: same tier and cost as the local bee, no `general`. */
  const PERSONAL: CapabilityRecord = {
    agent: "hermes",
    runtime: "personal",
    model: "gemma4:12b",
    tier: 3,
    billing: "local",
    skills: ["email", "files", "calendar", "daily-report", "personal"],
  } as CapabilityRecord;
  const LOCAL: CapabilityRecord = {
    agent: "ollama",
    runtime: "ollama",
    model: "gemma4:12b",
    tier: 3,
    billing: "local",
    skills: ["general", "coding", "writing"],
  } as CapabilityRecord;

  it("does not hand untagged work to a bee that advertises only specialties", () => {
    // Observed for real: "Reply with exactly the word: pong" reached the
    // personal bee and came back with a sentence about integrating personal
    // data. Both bees are tier-3 local so they tie on cost, and the old
    // predicate passed every capability when the task had no tags — which left
    // the stable sort to decide, i.e. whichever bee registered first.
    const personalFirst = decide(spec(), "simple", [PERSONAL, LOCAL], ledger);
    const localFirst = decide(spec(), "simple", [LOCAL, PERSONAL], ledger);
    expect(personalFirst.capability?.runtime).toBe("ollama");
    expect(localFirst.capability?.runtime).toBe("ollama");
  });

  it("does not hand it work whose tags matched nothing either", () => {
    // "No tag matched" and "no tag was given" are the same situation, and the
    // answer has to be the same or the bug just moves.
    const d = decide(spec({ skills: ["log-extract"] }), "simple", [PERSONAL, LOCAL], ledger);
    expect(d.capability?.runtime).toBe("ollama");
  });

  it("still routes to it when the task names what it does", () => {
    const d = decide(spec({ skills: ["email"] }), "standard", [LOCAL, PERSONAL], ledger);
    expect(d.capability?.runtime).toBe("personal");
  });

  it("still answers when specialists are all there is", () => {
    // Answering imperfectly beats not answering: a fleet of nothing but
    // specialists must not strand the task on a defer loop.
    const d = decide(spec(), "simple", [PERSONAL], ledger);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.runtime).toBe("personal");
  });

  it("keeps the specialist out of the degrade path too", () => {
    // degradeToLocal rebuilds its candidate list from scratch, so the rule has
    // to be reapplied there or it is dropped at the moment it matters most.
    const seated: CapabilityRecord = {
      runtime: "claude-code",
      model: "sonnet",
      tier: 1,
      billing: "subscription",
      skills: ["general"],
      quotaWindow: { seatId: "empty-seat", windowSeconds: 60, tokensPerWindow: 10 },
    } as CapabilityRecord;
    ledger.addSeat("empty-seat", 60, 10);
    ledger.recordQuotaUse("empty-seat", 10);

    const d = decide(spec({ urgency: "urgent" }), "complex", [PERSONAL, LOCAL, seated], ledger, 2.0, {
      onBudgetBlock: "degrade",
    });
    expect(d.action).toBe("dispatch");
    expect(d.degraded).toBe(true);
    expect(d.capability?.runtime).toBe("ollama");
  });
});

describe("refusing beats answering the wrong question", () => {
  let ledger: BudgetLedger;
  beforeEach(() => {
    ledger = new BudgetLedger();
    ledger.addCustomer("aiotlab", 50);
    ledger.addSeat("claude-max-1", 18000, 1000);
    ledger.addSeat("ollama-cloud-1", 3600, 1000);
  });

  const searcher: CapabilityRecord = {
    runtime: "api",
    model: "gemini-3-flash-preview",
    tier: 2,
    billing: "per-token",
    skills: ["web-search"],
    description: "Gemini with Google Search grounding",
  };
  const needsSearch = {
    selector: { label: "grounded web search", skills: ["web-search"] },
    remedy: "set GEMINI_API_KEY, or configure a bee that advertises web-search",
  };

  it("refuses by name when the fleet has nothing that can do the job", () => {
    // The alternative is the reason this exists: handed to a local model with no
    // web access, a literature search does not fail — it invents citations.
    const d = decide(spec(), "standard", CAPS, ledger, 2.0, undefined, needsSearch);
    expect(d.action).toBe("refuse");
    expect(d.reason).toContain("grounded web search");
    expect(d.remedy).toContain("GEMINI_API_KEY");
  });

  it("still waits when the roster is empty, because that is a startup race", () => {
    // The Queen comes up before its bees. "Nobody has said hello yet" is a claim
    // about timing; refusal is a claim about capability.
    const d = decide(spec(), "standard", [], ledger, 2.0, undefined, needsSearch);
    expect(d.action).toBe("defer");
  });

  it("does not degrade past a requirement, even when policy says degrade", () => {
    // Degrading to a bee that cannot do the thing asked for is not degrading,
    // it is answering a different question — and it would be marked `degraded`,
    // which reads as "lower quality" rather than "wrong bee".
    ledger.recordSpend("aiotlab", 50);
    const d = decide(
      spec({ urgency: "urgent" }),
      "standard",
      [...CAPS, searcher],
      ledger,
      2.0,
      { onBudgetBlock: "degrade" },
      needsSearch,
    );
    expect(d.action).not.toBe("dispatch");
  });

  it("naming a per-token capability is itself the authorization to pay for it", () => {
    // The urgent-only rule exists to stop the hive reaching for retail pricing
    // when something cheaper would have done. A requirement says nothing
    // cheaper would have done.
    const d = decide(spec(), "standard", [...CAPS, searcher], ledger, 2.0, undefined, needsSearch);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.model).toBe("gemini-3-flash-preview");
    expect(d.maxUsd).toBeGreaterThan(0);
    expect(d.reason).toContain("by name");
  });

  it("but the USD cap still binds, and that is a wait rather than a refusal", () => {
    ledger.recordSpend("aiotlab", 50);
    const d = decide(spec(), "standard", [...CAPS, searcher], ledger, 2.0, undefined, needsSearch);
    expect(d.action).toBe("defer");
  });

  it("leaves an unrequired skill exactly as soft as it was", () => {
    // The contract from "ignores a skill no capability advertises": a free-form
    // planner tag must keep falling back rather than stranding the task. Only an
    // explicit requirement is hard.
    const d = decide(spec({ skills: ["web-search"] }), "simple", CAPS, ledger);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.billing).toBe("local");
  });

  it("refuses confidential work when no local bee exists, instead of waiting on nothing", () => {
    const cloudOnly = CAPS.filter((c) => c.billing !== "local");
    const d = decide(spec({ sensitivity: "confidential" }), "standard", cloudOnly, ledger);
    expect(d.action).toBe("refuse");
    expect(d.remedy).toContain("local or free");
  });
});

describe("the agent name is display-only", () => {
  const ledger = new BudgetLedger();

  it("routes a named capability exactly like an unnamed one", () => {
    // `agent` exists so humans can read the roster. If it ever reached routing,
    // renaming a bee would silently change which tasks it wins.
    const plain = decide(spec(), "standard", CAPS, ledger);
    const named = decide(
      spec(),
      "standard",
      CAPS.map((c) => ({ ...c, agent: "my-harnessed-agent" })),
      ledger,
    );
    expect(named.action).toBe(plain.action);
    expect(named.tier).toBe(plain.tier);
    expect(named.capability?.model).toBe(plain.capability?.model);
    expect(named.capability?.billing).toBe(plain.capability?.billing);
  });

  it("keeps metering a seatless record on runtime:model, not on the agent name", () => {
    // The synthetic seat key indexes persisted quota state in the ledger.
    // Re-keying it on a name the operator can edit would orphan every window
    // already recorded under the old key.
    const seatless: CapabilityRecord = {
      agent: "renamed-later",
      runtime: "opencode",
      model: "qwen3.5:4b",
      tier: 3,
      billing: "subscription",
      skills: ["general"],
    };
    const fresh = new BudgetLedger();
    fresh.recordQuotaUse("opencode:qwen3.5:4b", 1_000_000);
    const d = decide(spec(), "standard", [seatless], fresh);
    // Quota for that synthetic key is exhausted, so this capability cannot take
    // the task — proof the key is still runtime:model.
    expect(d.capability).not.toBe(seatless);
  });
});

/**
 * `completion-first` is the per-customer answer to "we optimize, we do not
 * minimize": among capabilities that cost the customer nothing extra, prefer the
 * one most likely to finish on the first attempt. It reorders; it never widens.
 */
describe("completion-first routing", () => {
  let ledger: BudgetLedger;
  const policy = { onBudgetBlock: "wait" as const, routing: "completion-first" as const };

  beforeEach(() => {
    ledger = new BudgetLedger();
    ledger.addCustomer("aiotlab", 50);
    ledger.addSeat("claude-max-1", 18000, 1000);
    ledger.addSeat("ollama-cloud-1", 3600, 1000);
  });

  it("sends standard work to the prepaid seat instead of the local model", () => {
    // cost-first starts on tier 3 and escalates only after failing. Both routes
    // cost the customer $0; this one does not pay for the failed attempt first.
    const costFirst = decide(spec({ skills: ["coding"] }), "standard", CAPS, ledger);
    expect(costFirst.capability?.billing).toBe("local");

    const d = decide(spec({ skills: ["coding"] }), "standard", CAPS, ledger, 2, policy);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.runtime).toBe("claude-code");
    expect(d.maxUsd).toBe(0);
  });

  it("still refuses per-token billing for non-urgent work", () => {
    // The knob may reorder the prepaid band. It may never turn a preference into
    // a bill, so per-token stays last and stays urgent-only.
    const perTokenOnly = CAPS.filter((c) => c.billing === "per-token");
    const d = decide(spec({ skills: ["coding"] }), "standard", perTokenOnly, ledger, 2, policy);
    expect(d.action).toBe("defer");
  });

  it("never reaches a capability confidentiality forbids", () => {
    // The ordering knob sits inside the eligibility filter, not around it.
    const d = decide(spec({ skills: ["coding"], sensitivity: "confidential" }), "standard", CAPS, ledger, 2, policy);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.billing).toBe("local");
  });

  it("falls back to the next capability when the preferred seat is exhausted", () => {
    ledger.recordQuotaUse("claude-max-1", 1_000_000);
    const d = decide(spec({ skills: ["coding"] }), "standard", CAPS, ledger, 2, policy);
    expect(d.action).toBe("dispatch");
    expect(d.capability?.model).toBe("qwen3.5:cloud"); // tier 2 seat, still prepaid
  });
});
