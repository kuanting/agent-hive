import { randomUUID } from "node:crypto";
import { ArtifactStore, TaskSpec, type TaskResult } from "@hive/shared";
import type { SubmitOutcome } from "../core.js";
import type { PlannedTask } from "./types.js";

/** The slice of QueenCore the orchestrator needs, so it can be tested with a fake. */
export interface OrchestratorCore {
  submitTask(spec: TaskSpec): SubmitOutcome;
  awaitResult(taskId: string): Promise<TaskResult>;
}

export interface StepProgress {
  key: string;
  taskId?: string;
  phase: "submitted" | "done" | "failed";
  result?: TaskResult;
}

export interface StepOutcome {
  key: string;
  title: string;
  taskId: string;
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
  const submitted = new Set<string>();

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
        onProgress({ key: t.key, taskId: outcome.taskId, phase: "submitted" });

        const result = outcome.cached && outcome.result ? outcome.result : await core.awaitResult(outcome.taskId);
        done.set(t.key, result);
        onProgress({ key: t.key, taskId: outcome.taskId, phase: result.ok ? "done" : "failed", result });
      }),
    );
  }

  return planned
    .filter((t) => done.has(t.key))
    .map((t) => ({ key: t.key, title: t.title, taskId: taskIds.get(t.key)!, result: done.get(t.key)! }));
}
