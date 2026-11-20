/**
 * A bee embedded in another app: the desktop app's own process for one
 * signed-in employee.
 *
 * Runs as an Electron utilityProcess. It receives its config from the parent
 * over `process.parentPort` instead of from a file, and sends back what the
 * app's UI needs: approval requests to show as a card, and status for the
 * floating character's bubble. The parent sets the environment (broker URL,
 * Ollama URL, HIVE_ROOT) when it forks, before any of this loads.
 *
 * Protocol (parent <-> this process), all plain objects:
 *   parent -> { type: "start", config }           start the bee
 *   parent -> { type: "approval", taskId, answer } the person's decision ("run" | "decline")
 *   parent -> { type: "stop", reason }            drain and say goodbye
 *   this   -> { type: "ready", agentId }
 *   this   -> { type: "approval-request", taskId, title, input }
 *   this   -> { type: "task", update }            see TaskUpdate
 *   this   -> { type: "stopped" } | { type: "error", message }
 */
import { WorkerConfig } from "./config.js";
import { runWorker, type WorkerHandle } from "./run.js";

interface ParentPort {
  on(event: "message", cb: (e: { data: any }) => void): void;
  postMessage(msg: unknown): void;
}

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parent) {
  console.error("[embedded-worker] must be started as an Electron utilityProcess");
  process.exit(1);
}

const pending = new Map<string, (answer: "run" | "decline") => void>();
let handle: WorkerHandle | undefined;

parent.on("message", async ({ data }) => {
  try {
    if (data?.type === "start" && !handle) {
      const cfg = WorkerConfig.parse(data.config);
      handle = await runWorker(
        cfg,
        {
          beforeExecute: (msg) =>
            new Promise((resolve) => {
              pending.set(msg.taskId, resolve);
              parent.postMessage({
                type: "approval-request",
                taskId: msg.taskId,
                title: msg.spec.title,
                // Shown on the employee's own screen, inside their own app. It
                // is their task; this never leaves the machine.
                input: msg.spec.input.slice(0, 2_000),
              });
            }),
          onTaskUpdate: (update) => parent.postMessage({ type: "task", update }),
        },
        { handleSignals: false, exitOnStop: false },
      );
      parent.postMessage({ type: "ready", agentId: cfg.agentId });
    } else if (data?.type === "approval") {
      pending.get(data.taskId)?.(data.answer === "run" ? "run" : "decline");
      pending.delete(data.taskId);
    } else if (data?.type === "stop") {
      // Anything still waiting on the person is declined rather than left hanging.
      for (const resolve of pending.values()) resolve("decline");
      pending.clear();
      await handle?.stop(data.reason ?? "stopped by the app");
      parent.postMessage({ type: "stopped" });
      process.exit(0);
    }
  } catch (err) {
    parent.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
});
