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
  /** a command that used to live here and now lives on the machine */
  | { kind: "moved"; name: string; use: string }
  | { kind: "unknown"; name: string };

/** Commands the console can carry out itself. Admin actions are deliberately absent — see below. */
export const KNOWN_COMMANDS: readonly string[] = [];

/**
 * Commands that exist, but not here.
 *
 * `/shutdown` briefly worked from the console and should not have. The Queen
 * guards the route by refusing anything but loopback, but the dev server proxies
 * to it from its own process, so the Queen sees 127.0.0.1 whatever machine the
 * browser is on — the guard reads as protection while providing none. There is
 * no user authentication yet, so admin capability is confined to the hive's own
 * machine instead, and a browser is not that.
 *
 * Named rather than merely refused: anyone who used it yesterday will type it
 * again, and "unknown command" would read as a bug rather than a decision.
 */
const MOVED: Record<string, string> = {
  shutdown: "npm run stop (on the machine running the hive)",
};

export function parseCommand(raw: string): Command {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return { kind: "chat", message: trimmed };

  const name = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
  const use = MOVED[name];
  if (use) return { kind: "moved", name, use };
  return { kind: "unknown", name };
}
