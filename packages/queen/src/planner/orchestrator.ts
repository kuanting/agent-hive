import { randomUUID } from "node:crypto";
import { ArtifactStore, TaskSpec, type TaskResult } from "@hive/shared";
import type { SubmitOutcome, TaskEvent } from "../core.js";
import type { PlannedTask } from "./types.js";

/** The slice of QueenCore the orchestrator needs, so it can be tested with a fake. */
export interface OrchestratorCore {
  submitTask(spec: TaskSpec): SubmitOutcome;
  awaitResult(taskId: string): Promise<TaskResult>;
  /**
   * Optional so the existing fakes keep working. A core that provides it lets the
   * caller see a step move while it runs; one that doesn't just reports the two
   * endpoints, exactly as before.
   */
  onTaskEvent?(cb: (ev: TaskEvent) => void): () => void;
}

export interface StepProgress {
  key: string;
  taskId?: string;
  /**
   * `running` repeats — it is a liveness tick from the bee, not a state change,
   * so consumers must treat it as "still true" rather than a transition.
   */
  phase: "submitted" | "running" | "done" | "failed";
  result?: TaskResult;
  /** on `running`: how long the executing bee says it has been at it */
  elapsedMs?: number;
  /** on `running`: which bee, and what it is actually using */
  runningOn?: { agentId: string; tier: number; agent?: string; runtime: string; model?: string };
}

export interface StepOutcome {
  key: string;
  title: string;
  taskId: string;
  /** the spec as actually submitted, so reflection can compare it against the tools it missed */
  spec: TaskSpec;
  result: TaskResult;
}

/**
 * Runs a planner DAG. Ready tasks (all dependencies satisfied) run in parallel
 * waves. A parent's result is written to the artifact store and passed to its
 * children by reference, never inlined into the broker message. This keeps the
 * decomposition cheap in tokens.
 */
export async function runPlan(
  core: OrchestratorCore,
  customerId: string,
  planned: PlannedTask[],
  artifacts: ArtifactStore,
  onProgress: (p: StepProgress) => void,
): Promise<StepOutcome[]> {
  const done = new Map<string, TaskResult>();
  const taskIds = new Map<string, string>();
  const specs = new Map<string, TaskSpec>();
  const submitted = new Set<string>();

  // Watch the core for liveness ticks belonging to this plan's tasks. Scoped by
  // the ids we submitted, so two concurrent chat turns never narrate each other's
  // work, and unsubscribed in the finally below — a turn that kept listening
  // would leak a callback per request into a list the core walks on every event.
  const keyOfTaskId = new Map<string, string>();
  const unsubscribe = core.onTaskEvent?.((ev) => {
    if (ev.kind !== "progress") return;
    const key = keyOfTaskId.get(ev.taskId);
    if (!key) return;
    onProgress({
      key,
      taskId: ev.taskId,
      phase: "running",
      elapsedMs: ev.progress.elapsedMs,
      runningOn: {
        agentId: ev.progress.agentId,
        tier: ev.progress.tier,
        agent: ev.progress.agent,
        runtime: ev.progress.runtime,
        model: ev.progress.model,
      },
    });
  });

  try {
    while (done.size < planned.length) {
      const ready = planned.filter((t) => !submitted.has(t.key) && t.dependsOn.every((d) => done.has(d)));
      if (ready.length === 0) break; // cycle or missing dependency: stop rather than hang

      await Promise.all(
        ready.map(async (t) => {
          submitted.add(t.key);

          const depRefs = t.dependsOn
            .filter((d) => done.has(d))
            .map((d) => artifacts.put(done.get(d)!.output, `${customerId}-${d}-${randomUUID().slice(0, 8)}.txt`));
          const input = depRefs.length
            ? `${t.input}\n\nResults from prior steps are attached as artifacts; use them.`
            : t.input;

          const spec = TaskSpec.parse({
            customerId,
            title: t.title,
            input,
            artifacts: depRefs,
            skills: t.skills,
            sensitivity: t.sensitivity,
            urgency: t.urgency,
            toolInput: t.toolInput,
            dependsOn: t.dependsOn,
          });

          // submitTask is the only authority. The planner never sets tier or budget.
          const outcome = core.submitTask(spec);
          taskIds.set(t.key, outcome.taskId);
          keyOfTaskId.set(outcome.taskId, t.key);
          specs.set(t.key, spec);
          onProgress({ key: t.key, taskId: outcome.taskId, phase: "submitted" });

          const result = outcome.cached && outcome.result ? outcome.result : await core.awaitResult(outcome.taskId);
          done.set(t.key, result);
          onProgress({ key: t.key, taskId: outcome.taskId, phase: result.ok ? "done" : "failed", result });
        }),
      );
    }

    return planned
      .filter((t) => done.has(t.key))
      .map((t) => ({
        key: t.key,
        title: t.title,
        taskId: taskIds.get(t.key)!,
        spec: specs.get(t.key)!,
        result: done.get(t.key)!,
      }));
  } finally {
    unsubscribe?.();
  }
}
