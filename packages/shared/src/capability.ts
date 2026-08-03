import { z } from "zod";

/**
 * Capability tiers describe composition, NOT cost.
 *  1: official agent + paid frontier model (Claude Code, Codex)  — "honey bee"
 *  2: open-source agent + paid model (per-token API or Ollama cloud) — "metered bee"
 *  3: open-source agent + local model (local Ollama)              — "local bee"
 *  4: hardcoded tool, no LLM                                      — "worker bee"
 */
export const Tier = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Tier = z.infer<typeof Tier>;

/** Billing type determines real marginal cost, independent of tier. */
export const BillingType = z.enum(["subscription", "per-token", "local", "free"]);
export type BillingType = z.infer<typeof BillingType>;

export const Difficulty = z.enum(["simple", "standard", "complex"]);
export type Difficulty = z.infer<typeof Difficulty>;

export const Sensitivity = z.enum(["normal", "confidential"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const Urgency = z.enum(["normal", "urgent"]);
export type Urgency = z.infer<typeof Urgency>;

export const QuotaWindow = z.object({
  seatId: z.string(),
  windowSeconds: z.number(),
  /** estimated tokens the seat allows per window */
  tokensPerWindow: z.number(),
});
export type QuotaWindow = z.infer<typeof QuotaWindow>;

export const CapabilityRecord = z.object({
  /**
   * Operator-chosen name of the harnessed agent this record offers ("hermes",
   * "opencode", "my-research-agent"). This is the identity humans see: the hive
   * manages agents, and an agent is a thing someone installed and configured,
   * not a model tag.
   *
   * `runtime` stays the dispatch key that selects an adapter, so naming an agent
   * never changes how a task executes. Optional on purpose — absent means "call
   * it by its runtime", which is exactly what every capability did before this
   * field existed, so old configs and old hellos behave identically.
   */
  agent: z.string().optional(),
  /**
   * Which adapter drives this capability. `ollama` is the bare daemon itself —
   * no agent harness in front of it — which is the honest declaration for a host
   * that has models pulled but has installed none of opencode/openclaw/hermes.
   * Naming one of those instead would advertise a binary that isn't there and
   * fail once per task before degrading.
   */
  runtime: z.enum(["claude-code", "codex", "opencode", "openclaw", "hermes", "ollama", "personal", "api", "tool"]),
  tier: Tier,
  billing: BillingType,
  model: z.string().optional(),
  skills: z.array(z.string()).default([]),
  toolId: z.string().optional(),
  quotaWindow: QuotaWindow.optional(),
  /**
   * One line, written by whoever harnessed this agent, saying what it is good
   * for: "Gemini 3 Flash with Google Search grounding — looks up current papers
   * and cites URLs."
   *
   * Strictly advice, and strictly for the PLANNER. The router never reads it —
   * `skills` remains the only thing that narrows candidates, so routing stays a
   * set operation over tags rather than a judgement about prose. This is the
   * same split the hive already draws between YAML and markdown, one layer down:
   * the tag is authority, the sentence is advice.
   *
   * It earns its place because a bare tag list makes the planner guess. `skills:
   * [web-search]` tells a 12B model nothing about whether that bee can actually
   * find a paper; this does.
   */
  description: z.string().max(200).optional(),
  /**
   * Whether this capability can serve a caller's own tool loop — accept an
   * OpenAI-style `tools` array and answer with tool calls instead of prose.
   *
   * A property of the capability, never of the hive: the `api` runtimes support
   * it natively and a tool-capable Ollama model does too, while `claude-code`
   * and `codex` cannot, because they are agents that execute tools themselves
   * and hand back a finished answer. Tier 4 is a program and has no such notion.
   *
   * Defaults false so a record that has not thought about it is never routed
   * work it would silently answer without the tools the caller required.
   */
  supportsTools: z.boolean().default(false),
  /**
   * Opt this capability into provider-side web search (today: Google Search
   * grounding on the Gemini models).
   *
   * Off by default and per-capability, because it changes both what the answer
   * is made of and what it costs — grounding bills per query on top of tokens.
   * A bee that advertises search should say so in `description` too, so the
   * planner knows why it would reach for this one.
   */
  search: z.boolean().default(false),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecord>;

/**
 * A hard constraint on which capability may run a task — what a caller means by
 * naming a model instead of letting the router choose.
 *
 * Every field is a filter, and all of them must hold. Absent fields constrain
 * nothing, so `{ label, supportsTools: true }` is a perfectly good requirement.
 *
 * Serializable on purpose. The Queen decides against its registry and the bee
 * decides again against its own records — `capabilityHint` is only a hint, and a
 * bee holding two records on one tier picks for itself — so the two have to be
 * able to evaluate the *same* constraint rather than each other's conclusions.
 * A predicate would have made the Queen's choice unrepeatable on the far side.
 */
export const CapabilitySelector = z.object({
  /** what the caller asked for, in the caller's words, so a refusal can quote it back */
  label: z.string(),
  agent: z.string().optional(),
  runtime: z.string().optional(),
  model: z.string().optional(),
  /** every tag here must be advertised, unlike `TaskSpec.skills` which is a preference */
  skills: z.array(z.string()).default([]),
  supportsTools: z.boolean().optional(),
  /**
   * The seat, when that is what distinguishes two otherwise identical records.
   *
   * The same runtime and model can appear twice against different quota windows
   * — a general seat and a tiny demo one — and those are different capabilities
   * with different budgets. `pickRecord` already treats the seat as part of a
   * record's identity for exactly this reason; a selector that ignored it could
   * name one and be served by the other.
   */
  seatId: z.string().optional(),
});
export type CapabilitySelector = z.infer<typeof CapabilitySelector>;

/** The one place a selector is evaluated, so the Queen and the bee cannot disagree. */
export function matchesSelector(cap: CapabilityRecord, sel: CapabilitySelector): boolean {
  if (sel.agent && agentName(cap) !== sel.agent) return false;
  if (sel.runtime && cap.runtime !== sel.runtime) return false;
  if (sel.model && cap.model !== sel.model) return false;
  if (sel.supportsTools !== undefined && cap.supportsTools !== sel.supportsTools) return false;
  if (sel.seatId && cap.quotaWindow?.seatId !== sel.seatId) return false;
  return sel.skills.every((s) => cap.skills.includes(s));
}

/**
 * What to call this capability: the configured agent, else the runtime that
 * serves it. Every label in the hive — console chips, worker logs, rosters —
 * goes through here, so a bee is named the same thing everywhere it appears.
 */
export function agentName(cap: Pick<CapabilityRecord, "agent" | "runtime">): string {
  return cap.agent ?? cap.runtime;
}

/**
 * The name to show in a roster, with the model appended ONLY when the name
 * alone would be ambiguous.
 *
 * A solo host running one Hermes reads `hermes`; a company running four
 * OpenCode workers on different models reads `opencode/gemma4:12b`,
 * `opencode/qwen3.5:4b`. Same rule at both scales, so nobody configures a
 * "verbosity" switch — the roster shows detail exactly when detail carries
 * information.
 *
 * `among` must be EVERY live capability, not one worker's: two bees each
 * running a single `opencode` are ambiguous to the person reading the hive,
 * even though neither bee is ambiguous by itself.
 */
export function agentLabel(
  cap: CapabilityRecord,
  among: readonly CapabilityRecord[] = [],
): string {
  const name = agentName(cap);
  const sharers = among.filter((c) => agentName(c) === name);
  const ambiguous = sharers.length > 1 && new Set(sharers.map((c) => c.model ?? c.toolId)).size > 1;
  if (!ambiguous) return name;
  return cap.model ? `${name}/${cap.model}` : cap.toolId ? `${name} [${cap.toolId}]` : name;
}

/** Never-abbreviated form, for logs and hover text: everything, always. */
export function describeCapability(cap: CapabilityRecord): string {
  const parts = [agentName(cap)];
  if (cap.model) parts.push(`/${cap.model}`);
  if (cap.toolId) parts.push(` [${cap.toolId}]`);
  if (cap.agent && cap.agent !== cap.runtime) parts.push(` (via ${cap.runtime})`);
  if (cap.quotaWindow) parts.push(` seat=${cap.quotaWindow.seatId}`);
  return parts.join("");
}

/**
 * Did the bee actually reach for one thing and run another?
 *
 * Adapters report `runtimeUsed` more precisely than a capability names its
 * runtime: the tool adapter answers `tool:csv-report` for a record whose runtime
 * is `tool`, and the metered bee answers `api:openai` for `api`. Those are the
 * same runtime named at finer grain — the qualified form is extra information,
 * not a substitution. A plain `configured !== actual` reads both as fallbacks,
 * which means the honest-substitution signal fires on every tool call and every
 * API call and stops meaning anything.
 *
 * A real fallback is a different runtime entirely: `hermes` configured,
 * `personal-mini` run. That is what this returns true for.
 */
export function isRuntimeFallback(configured: string | undefined, actual: string | undefined): boolean {
  if (!configured || !actual || configured === actual) return false;
  const base = (s: string) => s.split(":")[0];
  return base(configured) !== base(actual);
}

/**
 * Marginal-cost rank used by the Queen's "cheapest adequate capability" routing.
 * Lower rank = dispatch first. Per-token API is the true last resort:
 * subscription seats are prepaid, so their marginal token cost is ~0
 * inside the quota window.
 */
export function costRank(cap: CapabilityRecord): number {
  switch (cap.billing) {
    case "free":
      return 0;
    case "local":
      return 1;
    case "subscription":
      return cap.tier === 1 ? 3 : 2; // Ollama cloud seat before frontier seat
    case "per-token":
      return 4;
  }
}

/** Which tiers may serve a given difficulty. */
export function adequateTiers(difficulty: Difficulty): Tier[] {
  switch (difficulty) {
    case "simple":
      return [4, 3, 2, 1];
    case "standard":
      return [3, 2, 1];
    case "complex":
      return [1, 2];
  }
}

/** Confidential work never leaves the premises. */
export function allowedByConfidentiality(cap: CapabilityRecord, sensitivity: Sensitivity): boolean {
  if (sensitivity !== "confidential") return true;
  return cap.billing === "local" || cap.billing === "free";
}
