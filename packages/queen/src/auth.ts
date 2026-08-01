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
  /** the key's own name, for logs and per-user attribution within a customer */
  userId: string;
}

/**
 * Parsed from `HIVE_API_KEYS`: `key:customerId[:userId]`, comma or newline
 * separated. Absent means the gate is open, which keeps `npm run solo` working
 * on a loopback bind with no configuration — the same posture the rest of the
 * admin surface has today.
 */
export function loadApiKeys(raw = process.env.HIVE_API_KEYS): Map<string, Caller> {
  const keys = new Map<string, Caller>();
  for (const entry of (raw ?? "").split(/[,\n]/)) {
    const [key, customerId, userId] = entry.trim().split(":");
    if (!key || !customerId) continue;
    keys.set(key, { customerId, userId: userId || customerId });
  }
  return keys;
}

/** True when no keys are configured, so the caller can warn once at startup rather than per request. */
export const isOpen = (keys: Map<string, Caller>): boolean => keys.size === 0;

/**
 * Bearer-token gate.
 *
 * Answers in OpenAI's error shape, because the clients on the other side already
 * know how to surface that and a bespoke body would just be rendered as "unknown
 * error" in somebody's UI.
 */
export function requireKey(keys: Map<string, Caller>): RequestHandler {
  return (req, res, next) => {
    if (isOpen(keys)) {
      // No keys configured: attribute to the request's own customer, or the
      // house default. Unauthenticated, and the startup banner says so.
      res.locals.caller = { customerId: req.body?.customerId ?? "aiotlab", userId: "anonymous" } satisfies Caller;
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
    res.locals.caller = caller;
    return next();
  };
}

/** The caller a guarded handler is running for. Present because `requireKey` ran. */
export const callerOf = (res: { locals: Record<string, unknown> }): Caller => res.locals.caller as Caller;
