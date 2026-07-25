import { beforeEach, describe, expect, it } from "vitest";
import { TaskSpec, type CapabilityRecord } from "@hive/shared";
import { BudgetLedger } from "../src/budget.js";
import { decide } from "../src/tierMapper.js";

const spec = (partial: Partial<TaskSpec> = {}): TaskSpec =>
  TaskSpec.parse({ customerId: "aiotlab", title: "t", input: "x", ...partial });

const CAPS: CapabilityRecord[] = [
  { runtime: "opencode", model: "qwen3:8b", tier: 3, billing: "local", skills: ["general", "coding"] },
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
