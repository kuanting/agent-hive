import type { Express, Response } from "express";
import { callerOf, loadApiKeys, requireKey } from "../auth.js";
import type { QueenCore } from "../core.js";
import { Planner, type ChatEvent } from "../planner/index.js";

function sse(res: Response, event: ChatEvent | { type: "done" } | { type: "error"; message: string }): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Conversational surface. POST /chat streams the whole turn over SSE: the
 * planner decision, any clarifying question, live task cards as worker bees run,
 * and the final synthesized answer.
 */
export function mountChatRoutes(app: Express, core: QueenCore, root: string, keys = loadApiKeys()): void {
  const guard = requireKey(keys);
  const escalationModel = core.customers[0]?.plannerModel;
  const planner = new Planner(core, root, escalationModel);
  // memory belongs to the brain; /status just borrows a read-only view of it
  core.registerStatusSection("memory", () => planner.snapshot());

  /**
   * Guarded, and the customer comes from the key rather than the body.
   *
   * This route used to be ungated *and* read `customerId` from the request, which
   * together meant any caller who could reach it chose whose USD cap to spend,
   * whose tier-4 tools `matchTool` could fire, and whose learned memory was
   * recalled into the planner's prompt. That is a wider hole than it looks, and
   * the reason DESIGN §10 lists "the same gate on /chat" as the last of the four
   * things real tenancy needs.
   *
   * With no keys configured `requireKey` still reads `req.body.customerId`, so
   * the loopback default and `npm run solo` behave exactly as before.
   */
  app.post("/chat", guard, async (req, res) => {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message required" });
    const caller = callerOf(res);
    const session = planner.sessions.getOrCreate(req.body?.sessionId, caller.customerId, caller.userId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    sse(res, { type: "session", sessionId: session.sessionId });

    try {
      await planner.turn(session, message, (ev) => sse(res, ev));
      sse(res, { type: "done" });
    } catch (err) {
      console.error("[queen] chat turn failed:", err);
      sse(res, { type: "error", message: String(err).slice(0, 300) });
    } finally {
      res.end();
    }
  });

  /**
   * A conversation, to whoever it belongs to.
   *
   * Session ids are eight hex characters — a fine handle and a poor secret — and
   * a session holds the whole transcript, so this returned another caller's
   * conversation to anyone who guessed one. Now that a session records who
   * created it, the check is four lines.
   *
   * 404 rather than 403 on a mismatch, so the response does not confirm that an
   * id exists. Sessions created before anyone was identified have no owner and
   * stay readable: locking an operator out of their own history to close a hole
   * that only exists once identity is configured would be the wrong trade.
   */
  app.get("/sessions/:id", guard, (req, res) => {
    const session = planner.sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "unknown session" });
    const caller = callerOf(res);
    const owned =
      session.customerId === caller.customerId && (session.userId === undefined || session.userId === caller.userId);
    if (!owned) return res.status(404).json({ error: "unknown session" });
    return res.json(session);
  });
}
