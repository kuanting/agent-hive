import type { RequestHandler } from "express";

/**
 * Who is calling, and whose budget they spend.
 *
 * The hive's admin surface was loopback-only precisely because it could not tell
 * callers apart (see the note on QUEEN_HOST in index.ts). An OpenAI-compatible
 * endpoint has to be reachable by other machines to be worth anything, so that
 * substitute for authorization stops working and something has to replace it.
 *
 * A bearer key mapped to a customer is that something, and it is deliberately
 * the smallest thing that works: it is the convention every OpenAI client
 * already implements, so no caller needs teaching, and `customerId` is already
 * the hive's unit of budget and memory. Identity therefore lands exactly where
 * spending is already accounted, rather than beside it.
 *
 * What this is NOT: mutual defence between users. Keys identify and attribute;
 * they do not isolate. Artifacts are a shared directory, `/status` still shows
 * every task once you are past the gate, and seats are global. This is a lab
 * where people are told apart and budgeted separately, not a multi-tenant
 * service, and saying so plainly is better than implying more.
 */

export interface Caller {
  customerId: string;
  /**
   * The key's own name, for logs and per-user attribution within a customer.
   *
   * Absent only for a gateway key whose request carried no user header — a state
   * the routes that need attribution refuse rather than paper over.
   */
  userId?: string;
  /**
   * True when this key is a front end acting for many people, and may therefore
   * name which one. See `USER_HEADER`.
   */
  gateway?: boolean;
}

/**
 * The header a gateway key may name its user in.
 *
 * Defaulted to Open WebUI's, because that is the front end this exists for and a
 * default nobody has to look up is worth more than a neutral one. Any gateway
 * that can set a header works; `req.get` is case-insensitive.
 */
export const USER_HEADER = process.env.HIVE_USER_HEADER ?? "x-openwebui-user-id";

/** Marks a key as a gateway rather than a person. Cannot collide with a user id. */
const GATEWAY = "@gateway";

/**
 * Parsed from `HIVE_API_KEYS`: `key:customerId[:userId|:@gateway]`, comma or
 * newline separated. Absent means the gate is open, which keeps `npm run solo`
 * working on a loopback bind with no configuration — the same posture the rest
 * of the admin surface has today.
 *
 * The third field says who the key is. A name means one person, and that name is
 * final. `@gateway` means the key is a front end holding one credential on
 * behalf of many people — Open WebUI has exactly one upstream key per connection
 * — and its requests carry the person in a header instead. Marked by name rather
 * than inferred, because "this key may assert an identity" is a trust decision,
 * and a trust decision is not something an operator should discover.
 *
 * Returns templates, not finished callers: a gateway key has no `userId` until a
 * request supplies one.
 */
export function loadApiKeys(raw = process.env.HIVE_API_KEYS): Map<string, Caller> {
  const keys = new Map<string, Caller>();
  for (const entry of (raw ?? "").split(/[,\n]/)) {
    const [key, customerId, third] = entry.trim().split(":");
    if (!key || !customerId) continue;
    keys.set(key, third === GATEWAY ? { customerId, gateway: true } : { customerId, userId: third || customerId });
  }
  return keys;
}

/** True when no keys are configured, so the caller can warn once at startup rather than per request. */
export const isOpen = (keys: Map<string, Caller>): boolean => keys.size === 0;

/**
 * Clean up an id a gateway asserted, or report that it did not assert one.
 *
 * This value becomes a key in the budget ledger and a `user_id` column in the
 * corpus, and it arrives over the network — trusted to be *from* the gateway,
 * not trusted to be shaped like anything. An unbounded id is an unbounded number
 * of ledger rows, and a control character in one would land in a log line and
 * then in somebody's terminal.
 *
 * An allowlist rather than a blocklist, because the set of characters an
 * identifier legitimately needs is small and knowable, while the set that could
 * cause trouble somewhere downstream is neither.
 */
function assertedUser(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const clean = raw
    .trim()
    // Kept as a separator rather than dropped, so an id that legitimately holds
    // a space stays legible in a usage report instead of silently fusing.
    .replace(/\s+/g, "-")
    .replace(/[^\w.:@-]/g, "")
    .slice(0, 64);
  return clean || undefined;
}

/**
 * Bearer-token gate.
 *
 * Answers in OpenAI's error shape, because the clients on the other side already
 * know how to surface that and a bespoke body would just be rendered as "unknown
 * error" in somebody's UI.
 *
 * Note where the header is read: inside the gateway branch, and nowhere else.
 * That is what makes a named key structurally incapable of claiming to be
 * someone else — not a check that could be forgotten, but a value that is never
 * fetched. Whether a *missing* header is fatal is the route's decision rather
 * than this one's: `/v1/models` has no user to attribute and should not care.
 */
export function requireKey(keys: Map<string, Caller>): RequestHandler {
  return (req, res, next) => {
    if (isOpen(keys)) {
      // No keys configured: attribute to the request's own customer, or the
      // house default. Unauthenticated, and the startup banner says so.
      //
      // The header is honoured here even though nothing was authenticated, and
      // the asymmetry with the gateway branch below is deliberate rather than an
      // oversight: an open gate is not a trust claim, so refusing to read a
      // header buys no safety while costing the zero-config path — Open WebUI in
      // front of `npm run solo`. A request with no header is still "anonymous",
      // exactly as before.
      res.locals.caller = {
        customerId: req.body?.customerId ?? "aiotlab",
        userId: assertedUser(req.get(USER_HEADER)) ?? "anonymous",
      } satisfies Caller;
      return next();
    }
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const caller = keys.get(token);
    if (!caller) {
      return res.status(401).json({
        error: { message: "invalid or missing API key", type: "invalid_request_error", code: "invalid_api_key" },
      });
    }
    res.locals.caller = caller.gateway
      ? ({ ...caller, userId: assertedUser(req.get(USER_HEADER)) } satisfies Caller)
      : caller;
    return next();
  };
}

/** The caller a guarded handler is running for. Present because `requireKey` ran. */
export const callerOf = (res: { locals: Record<string, unknown> }): Caller => res.locals.caller as Caller;

/**
 * The refusal a route sends when it needs a user and the gateway named none.
 *
 * Refusing beats an `unattributed` bucket. A bucket is how usage tracking rots:
 * it looks like it is working, costs nothing to ignore, and by the time anyone
 * reads the report the misconfiguration is months old. A 400 naming the exact
 * setting is discovered on the first request instead.
 *
 * A body rather than middleware, because only some routes need a user — see the
 * note on `requireKey`.
 */
export function userRequiredBody() {
  return {
    error: {
      message:
        `this key is a gateway, so it must name the user it is calling for in the '${USER_HEADER}' header. ` +
        `In Open WebUI, set ENABLE_FORWARD_USER_INFO_HEADERS=true. ` +
        `Without it every one of your users would spend, and be recorded, as the same person.`,
      type: "invalid_request_error",
      code: "user_header_required",
    },
  };
}
