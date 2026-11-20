import type { Express } from "express";
import { TaskSpec } from "@hive/shared";
import { callerOf, loadApiKeys, requireKey } from "../auth.js";
import type { QueenCore } from "../core.js";

/**
 * Structured intake: hand the hive a `TaskSpec` and read it back.
 *
 * Lifted out of index.ts, which mounted every other route group through a
 * function and kept these two inline — so they were the only routes whose auth
 * you had to read `main()` to discover, and the only ones no test could drive
 * without starting a Queen.
 */
export function mountTaskRoutes(app: Express, core: QueenCore, keys = loadApiKeys()): void {
  const guard = requireKey(keys);

  /**
   * Guarded, and the customer comes from the key rather than the body.
   *
   * `TaskSpec` requires a `customerId` and this route parsed the request straight
   * into one, so an unkeyed caller named whose USD cap to spend and whose tier-4
   * tools could fire. Overriding rather than validating, because there is no case
   * where a caller's own claim about which customer they are should win over the
   * key they authenticated with.
   *
   * With no keys configured `requireKey` falls back to the body's own customerId,
   * so the loopback default and `demo/agent-loop.py` behave exactly as before.
   */
  app.post("/tasks", guard, (req, res) => {
    const caller = callerOf(res);
    const parsed = TaskSpec.safeParse({ ...req.body, customerId: caller.customerId });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const outcome = core.submitTask(parsed.data, undefined, undefined, { userId: caller.userId });
    if (outcome.cached) return res.json({ ...outcome, status: "done" });
    return res.status(202).json(outcome);
  });

  /**
   * The whole task state, to whoever submitted it.
   *
   * This returns `spec.input`, `result.output` and every attempt in `history`, for
   * an eight-hex id that the caller of `/v1/chat/completions` is handed in
   * `x_hive.task_id`. Ungated, that was a transcript read for anyone who could
   * guess one.
   *
   * 404 rather than 403 on a mismatch, so a response never confirms an id exists.
   * Tasks the planner submits internally, and any predating identity, have no
   * caller and stay readable at the customer level — locking an operator out of
   * their own hive's history would be the wrong trade.
   */
  app.get("/tasks/:id", guard, (req, res) => {
    const state = core.getTask(req.params.id);
    if (!state) return res.status(404).json({ error: "unknown task" });
    const caller = callerOf(res);
    const owned =
      state.spec.customerId === caller.customerId &&
      (state.caller?.userId === undefined || state.caller.userId === caller.userId);
    if (!owned) return res.status(404).json({ error: "unknown task" });
    return res.json(state);
  });
}
