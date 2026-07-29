import type { Express } from "express";
import { atLeast, LogLevel } from "@hive/shared";
import type { QueenCore } from "../core.js";

/**
 * The hive's live narration, for the console's Activity view.
 *
 * A GET rather than a POST, unlike /chat — which matters more than it looks.
 * /chat has to be a POST (it carries a message), so the browser cannot use
 * EventSource for it and apps/web hand-rolls a stream reader instead. A feed has
 * no body to send, so making it a GET buys the browser's own SSE client and,
 * with it, automatic reconnection. That is exactly what a debug view wants: leave
 * the tab open, restart the Queen, and the feed picks itself back up.
 *
 * Reconnection is why every entry carries `seq`. On connect the buffer is
 * replayed so a freshly-opened tab is not blank, and the client drops the seqs it
 * already holds. Replay is bounded by the ring, so it cannot become a firehose.
 *
 * Scope note: this stream is the whole hive, not one customer's slice. It is an
 * operator surface — the same audience and the same content as the terminal the
 * Queen is running in, which is why it needs no narrowing that the terminal
 * doesn't already have.
 */
export function mountEventRoutes(app: Express, core: QueenCore): void {
  app.get("/events", (req, res) => {
    const parsed = LogLevel.safeParse(req.query.level);
    const level = parsed.success ? parsed.data : "info";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Proxies that buffer would defeat the point of a live feed.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    for (const entry of core.log.recent(level)) send(entry);

    const unsubscribe = core.log.subscribe((entry) => {
      if (atLeast(entry.level, level)) send(entry);
    });

    // A comment frame keeps idle connections alive through proxies that would
    // otherwise time them out. A quiet hive is the normal case here, so an
    // idle-timeout disconnect would be the common one, not the rare one.
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
    keepAlive.unref();

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  });
}
