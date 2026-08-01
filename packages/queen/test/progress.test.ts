import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, TaskProgress, TaskSpec, type TaskResult } from "@hive/shared";
import type { TaskEvent } from "../src/core.js";
import { PlannedTask } from "../src/planner/types.js";
import { runPlan, type OrchestratorCore, type StepProgress } from "../src/planner/orchestrator.js";

function fakeResult(taskId: string): TaskResult {
  return {
    kind: "task.result",
    taskId,
    agentId: "local-bee-1",
    customerId: "aiotlab",
    ok: true,
    output: "done",
    tierUsed: 3,
    runtime: "opencode",
    billing: "local",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    degraded: false,
    durationMs: 4200,
  };
}

function progressFor(taskId: string) {
  return TaskProgress.parse({
    kind: "task.progress",
    taskId,
    agentId: "local-bee-1",
    at: Date.now(),
    elapsedMs: 5000,
    tier: 3,
    agent: "opencode",
    runtime: "opencode",
    model: "gemma4:12b",
  });
}

/**
 * A core that lets the test decide when a task finishes, so a liveness tick can
 * be delivered while the step is genuinely mid-flight — which is the only window
 * where `running` means anything.
 */
function controllableCore() {
  const listeners: Array<(ev: TaskEvent) => void> = [];
  const finishers = new Map<string, (r: TaskResult) => void>();
  const core: OrchestratorCore = {
    submitTask: (spec: TaskSpec) => ({
      taskId: `id-${spec.title}`,
      status: "dispatched" as const,
      difficulty: "simple" as const,
      reason: "",
      sensitivity: spec.sensitivity,
    }),
    awaitResult: (taskId) => new Promise<TaskResult>((resolve) => finishers.set(taskId, resolve)),
    onTaskEvent(cb) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  return {
    core,
    listenerCount: () => listeners.length,
    tick: (taskId: string) => listeners.forEach((cb) => cb({ kind: "progress", taskId, progress: progressFor(taskId) })),
    finish: async (taskId: string) => {
      // wait a macrotask for submitTask's promise chain to register the finisher
      while (!finishers.has(taskId)) await new Promise((r) => setTimeout(r, 0));
      finishers.get(taskId)!(fakeResult(taskId));
    },
  };
}

const artifacts = () => new ArtifactStore(join(tmpdir(), `hive-progress-${Date.now()}-${Math.random()}`));

describe("a step reports that it is running, not just that it started", () => {
  it("emits running between submitted and done, carrying the bee that has it", async () => {
    const { core, tick, finish } = controllableCore();
    const seen: StepProgress[] = [];
    const tasks = [PlannedTask.parse({ key: "t1", title: "slow", input: "think hard" })];

    const run = runPlan(core, "aiotlab", tasks, artifacts(), (p) => {
      seen.push(p);
      if (p.phase === "submitted") {
        tick("id-slow");
        void finish("id-slow");
      }
    });
    await run;

    expect(seen.map((p) => p.phase)).toEqual(["submitted", "running", "done"]);
    const running = seen[1];
    expect(running.key).toBe("t1");
    expect(running.elapsedMs).toBe(5000);
    expect(running.runningOn).toMatchObject({ agentId: "local-bee-1", tier: 3, runtime: "opencode", model: "gemma4:12b" });
  });

  it("ignores ticks for tasks belonging to another turn", async () => {
    const { core, tick, finish } = controllableCore();
    const seen: StepProgress[] = [];
    const tasks = [PlannedTask.parse({ key: "t1", title: "mine", input: "x" })];

    await runPlan(core, "aiotlab", tasks, artifacts(), (p) => {
      seen.push(p);
      if (p.phase === "submitted") {
        // A concurrent chat turn's task. Two turns share one core, so an
        // unscoped listener would narrate someone else's work onto this card.
        tick("id-someone-elses");
        void finish("id-mine");
      }
    });

    expect(seen.map((p) => p.phase)).toEqual(["submitted", "done"]);
  });

  it("unsubscribes when the turn ends, so a listener is not leaked per request", async () => {
    const { core, listenerCount, finish } = controllableCore();
    const tasks = [PlannedTask.parse({ key: "t1", title: "quick", input: "x" })];
    await runPlan(core, "aiotlab", tasks, artifacts(), (p) => {
      if (p.phase === "submitted") void finish("id-quick");
    });
    expect(listenerCount()).toBe(0);
  });

  it("still works against a core with no event hook at all", async () => {
    // The optional onTaskEvent is what keeps every existing fake compiling.
    const seen: StepProgress[] = [];
    const core: OrchestratorCore = {
      submitTask: (spec) => ({ taskId: `id-${spec.title}`, status: "dispatched", difficulty: "simple", reason: "" }),
      awaitResult: async (taskId) => fakeResult(taskId),
    };
    await runPlan(core, "aiotlab", [PlannedTask.parse({ key: "t1", title: "a", input: "x" })], artifacts(), (p) =>
      seen.push(p),
    );
    expect(seen.map((p) => p.phase)).toEqual(["submitted", "done"]);
  });
});
