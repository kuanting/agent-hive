import "@hive/shared/env"; // must stay first: loads .env before env-reading modules initialize
import express from "express";
import { resolve } from "node:path";
import { TaskSpec } from "@hive/shared";
import { QueenCore } from "./core.js";
import { checkPlannerModel } from "./planner/model.js";
import { mountChatRoutes } from "./routes/chat.js";

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

  // ---- conversational Queen ----
  mountChatRoutes(app, core, ROOT);

  app.listen(PORT, () => console.log(`[queen] intake API + chat on :${PORT}`));
}

main().catch((err) => {
  console.error("[queen] fatal:", err);
  process.exit(1);
});
