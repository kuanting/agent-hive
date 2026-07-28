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

/** Everything, always — for hover text. */
export function describeCapability(cap: Cap): string {
  const parts = [agentName(cap)];
  if (cap.model) parts.push(`/${cap.model}`);
  if (cap.toolId) parts.push(` [${cap.toolId}]`);
  if (cap.agent && cap.agent !== cap.runtime) parts.push(` (via ${cap.runtime})`);
  if (cap.billing) parts.push(` · ${cap.billing}`);
  return parts.join("");
}
