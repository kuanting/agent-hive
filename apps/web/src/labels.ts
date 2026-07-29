// Client-side mirror of the label rules in packages/shared/src/capability.ts.
//
// Duplicated on purpose, the same way api.ts hand-mirrors the server's message
// shapes: `@hive/shared` re-exports the bus, so importing it here would pull
// amqplib and aedes into a browser bundle. The rules are ten lines and change
// rarely; the dependency would be permanent.

export interface Cap {
  tier: number;
  agent?: string;
  runtime: string;
  model?: string;
  billing?: string;
  toolId?: string;
}

/** The configured agent, else the runtime that serves it. */
export function agentName(cap: Pick<Cap, "agent" | "runtime">): string {
  return cap.agent ?? cap.runtime;
}

/**
 * Show the agent; append the model only when the name alone is ambiguous.
 * `among` is every live capability in the hive, so two bees each running one
 * `opencode` disambiguate against each other.
 */
export function agentLabel(cap: Cap, among: readonly Cap[] = []): string {
  const name = agentName(cap);
  const sharers = among.filter((c) => agentName(c) === name);
  const ambiguous = sharers.length > 1 && new Set(sharers.map((c) => c.model ?? c.toolId)).size > 1;
  if (!ambiguous) return name;
  return cap.model ? `${name}/${cap.model}` : cap.toolId ? `${name} [${cap.toolId}]` : name;
}

/**
 * Tier is composition, billing is cost — the bee names carry both, which is why
 * they read better on a card than "T2 oss+paid" did.
 *   honey   prepaid subscription seat, $0 marginal
 *   metered per-token API, the only one that spends
 *   local   on this machine, $0 and no egress
 *   worker  a plain tool, no LLM at all
 *
 * Here rather than in App.tsx because Activity needs the same names, and a feed
 * that called tier 3 something different from the card above it would be its own
 * small lie. (demo/watch.ts and demo/scoreboard.ts keep their own copies — they
 * are separate CLI processes that must not import from apps/web.)
 */
export const TIER_LABEL: Record<number, string> = {
  1: "🍯 T1 honey bee",
  2: "💵 T2 metered bee",
  3: "🏠 T3 local bee",
  4: "🐝 T4 worker bee",
};

/** Just the emoji, for places too tight for the full name. */
export const TIER_ICON: Record<number, string> = { 1: "🍯", 2: "💵", 3: "🏠", 4: "🐝" };

/**
 * Did the bee reach for one thing and run another? Mirrors isRuntimeFallback in
 * packages/shared/src/capability.ts.
 *
 * `tool` vs `tool:csv-report` and `api` vs `api:openai` are the same runtime
 * named at finer grain, not a substitution — flagging them would put a fallback
 * chip on every tool card and every metered card, which is how a real signal
 * stops being read.
 */
export function isRuntimeFallback(configured?: string, actual?: string): boolean {
  if (!configured || !actual || configured === actual) return false;
  return configured.split(":")[0] !== actual.split(":")[0];
}

/** Everything, always — for hover text. */
export function describeCapability(cap: Cap): string {
  const parts = [agentName(cap)];
  if (cap.model) parts.push(`/${cap.model}`);
  if (cap.toolId) parts.push(` [${cap.toolId}]`);
  if (cap.agent && cap.agent !== cap.runtime) parts.push(` (via ${cap.runtime})`);
  if (cap.billing) parts.push(` · ${cap.billing}`);
  return parts.join("");
}
