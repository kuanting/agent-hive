import type { Express, Response } from "express";
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
export function mountChatRoutes(app: Express, core: QueenCore, root: string): void {
  const defaultCustomer = core.customers[0]?.customerId ?? "default";
  const escalationModel = core.customers[0]?.plannerModel;
  const planner = new Planner(core, root, escalationModel);

  app.post("/chat", async (req, res) => {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message required" });
    const customerId = String(req.body?.customerId ?? defaultCustomer);
    const session = planner.sessions.getOrCreate(req.body?.sessionId, customerId);

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

  app.get("/sessions/:id", (req, res) => {
    const session = planner.sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "unknown session" });
    return res.json(session);
  });
}
