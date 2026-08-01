/**
 * What the composer does with a line starting with `/`.
 *
 * Split out from App so it can be tested, because the bug it exists to prevent
 * was invisible: typing `/shutdown` went to the planner as ordinary chat, the
 * model answered "System shutting down.", and nothing stopped. A `answer`
 * decision can assert anything at all, so routing a control action through one
 * means the console reports outcomes that never happened.
 *
 * The rule is therefore absolute rather than a lookup with a fallback: anything
 * beginning with `/` is for the console, and an unknown one is refused. Passing
 * `/foo` through to the planner would let it invent a result for that too, which
 * is the same failure wearing a different name.
 *
 * This mirrors what the routing core already does with the planner — it
 * proposes, something deterministic disposes — applied to the surface a person
 * actually types at.
 */
export type Command =
  /** not a command at all; send it to the Queen as chat */
  | { kind: "chat"; message: string }
  | { kind: "shutdown"; reason: string }
  | { kind: "unknown"; name: string };

export const KNOWN_COMMANDS = ["shutdown"] as const;

export function parseCommand(raw: string): Command {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return { kind: "chat", message: trimmed };

  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  if (name.toLowerCase() === "shutdown") {
    return { kind: "shutdown", reason: rest.join(" ").trim() || "requested from the console" };
  }
  return { kind: "unknown", name };
}
