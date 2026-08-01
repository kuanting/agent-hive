import "@hive/shared/env"; // must stay first: loads .env before env-reading modules initialize
import express from "express";
import { resolve } from "node:path";
import { TaskSpec } from "@hive/shared";
import { QueenCore } from "./core.js";
import { checkPlannerModel } from "./planner/model.js";
import { mountChatRoutes } from "./routes/chat.js";
import { mountEventRoutes } from "./routes/events.js";

const ROOT = resolve(process.env.HIVE_ROOT ?? ".");
const PORT = Number(process.env.QUEEN_PORT ?? 4100);

async function main() {
  // Say up front whether the Queen can actually think. Checked at boot, not on
  // the first chat turn, so a misconfigured planner is visible before anyone
  // relies on it — and never silently papered over with a different model.
  // Ahead of the bus connection on purpose: it is a pure local probe, and an
  // operator debugging a broker outage should still learn about this one.
  await checkPlannerModel();

  const core = await QueenCore.create(ROOT);

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // ---- structured intake (unchanged behavior) ----
  app.post("/tasks", (req, res) => {
    const parsed = TaskSpec.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const outcome = core.submitTask(parsed.data);
    if (outcome.cached) return res.json({ ...outcome, status: "done" });
    return res.status(202).json(outcome);
  });

  app.get("/tasks/:id", (req, res) => {
    const state = core.getTask(req.params.id);
    if (!state) return res.status(404).json({ error: "unknown task" });
    return res.json(state);
  });

  app.get("/status", (_req, res) => res.json(core.status()));

  // ---- stop the whole hive, on purpose ----
  //
  // The only thing in the hive that stops other machines, so it is the only
  // route that is guarded. Two cheap gates rather than an auth system (DESIGN §1
  // lists auth as a non-goal): loopback only, so it is not reachable from the
  // network a fleet is spread across, and an explicit confirm field, so no stray
  // curl, browser preflight or link-prefetch can trip it.
  //
  // Note what does NOT do this: the Queen's own SIGINT. Restarting the control
  // plane must leave the fleet running — see QueenCore.shutdownHive.
  app.post("/shutdown", async (req, res) => {
    const addr = req.socket.remoteAddress ?? "";
    const local = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
    if (!local) {
      return res.status(403).json({ error: "shutdown is loopback-only", from: addr });
    }
    if (req.body?.confirm !== "shutdown") {
      return res.status(400).json({ error: 'send {"confirm":"shutdown"} to stop the hive' });
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : undefined;

    // Answer before leaving: the caller is about to lose the server it is
    // talking to, and "connection reset" is a poor way to learn it worked.
    const outcome = await core.shutdownHive(reason);
    res.json({ stopped: true, ...outcome });
    res.on("finish", () => setTimeout(() => process.exit(0), 100).unref());
  });

  // ---- conversational Queen ----
  mountChatRoutes(app, core, ROOT);

  // ---- live narration for the console's Activity view ----
  mountEventRoutes(app, core);

  app.listen(PORT, () => console.log(`[queen] intake API + chat on :${PORT}`));
}

main().catch((err) => {
  console.error("[queen] fatal:", err);
  process.exit(1);
});
