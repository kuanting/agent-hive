import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, TaskSpec, type TaskResult } from "@hive/shared";
import { PlannedTask, PlannerDecision } from "../src/planner/types.js";
import { runPlan, type OrchestratorCore } from "../src/planner/orchestrator.js";

describe("planner decision parsing", () => {
  it("accepts a clarify decision", () => {
    const d = PlannerDecision.parse({ kind: "clarify", question: "Which line?" });
    expect(d.kind).toBe("clarify");
  });

  it("accepts a plan with tasks", () => {
    const d = PlannerDecision.parse({
      kind: "plan",
      tasks: [{ key: "t1", title: "x", input: "do x" }],
    });
    expect(d.kind === "plan" && d.tasks[0].key).toBe("t1");
  });

  it("accepts an answer decision", () => {
    expect(PlannerDecision.parse({ kind: "answer", text: "hello" }).kind).toBe("answer");
  });

  it("rejects a plan with no tasks", () => {
    expect(PlannerDecision.safeParse({ kind: "plan", tasks: [] }).success).toBe(false);
  });

  it("rejects an unknown decision kind", () => {
    expect(PlannerDecision.safeParse({ kind: "spawn", foo: 1 }).success).toBe(false);
  });

  it("tolerates out-of-vocab enum values from small models instead of dropping the plan", () => {
    // a small local planner model emitted urgency:"high"; the whole plan must not be discarded
    const d = PlannerDecision.parse({
      kind: "plan",
      tasks: [{ key: "t1", title: "x", input: "y", urgency: "high", skills: "coding" }],
    });
    expect(d.kind === "plan" && d.tasks[0].urgency).toBe("normal");
    expect(d.kind === "plan" && d.tasks[0].skills).toEqual(["coding"]);
  });

  it("still honors an explicit confidential flag (safety gate never loosens)", () => {
    const d = PlannedTask.parse({ key: "t", title: "x", input: "y", sensitivity: "confidential" });
    expect(d.sensitivity).toBe("confidential");
  });
});

describe("planner cannot force tier or budget", () => {
  it("strips any tier/budget fields a model tries to inject", () => {
    const planned = PlannedTask.parse({
      key: "t1",
      title: "sneaky",
      input: "run this",
      tier: 1,
      maxUsd: 999,
      billing: "per-token",
    } as Record<string, unknown>);
    expect("tier" in planned).toBe(false);
    expect("maxUsd" in planned).toBe(false);
    expect("billing" in planned).toBe(false);
  });

  it("TaskSpec has no tier field, so the mapper is the only tier authority", () => {
    const spec = TaskSpec.parse({ customerId: "aiotlab", title: "t", input: "x" });
    expect("tier" in spec).toBe(false);
    expect("maxUsd" in spec).toBe(false);
  });
});

function fakeResult(taskId: string, output: string): TaskResult {
  return {
    kind: "task.result",
    taskId,
    agentId: "fake",
    customerId: "aiotlab",
    ok: true,
    output,
    tierUsed: 3,
    runtime: "fake",
    billing: "local",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    degraded: false,
    durationMs: 1,
  };
}

describe("orchestrator DAG ordering", () => {
  it("runs a dependent task only after its parent result, passing it by reference", async () => {
    const submitOrder: string[] = [];
    const artifacts = new ArtifactStore(join(tmpdir(), `hive-test-${Date.now()}`));

    const core: OrchestratorCore = {
      submitTask(spec: TaskSpec) {
        submitOrder.push(spec.title);
        // child must carry the parent's output as an artifact reference, not inline
        if (spec.title === "child") {
          expect(spec.artifacts.length).toBe(1);
          expect(spec.input).not.toContain("PARENT_OUTPUT");
        }
        return { taskId: `id-${spec.title}`, status: "dispatched" as const, difficulty: "simple" as const, reason: "" };
      },
      async awaitResult(taskId: string) {
        return fakeResult(taskId, taskId === "id-parent" ? "PARENT_OUTPUT" : "child-done");
      },
    };

    const tasks = [
      PlannedTask.parse({ key: "p", title: "parent", input: "do parent" }),
      PlannedTask.parse({ key: "c", title: "child", input: "use parent result", dependsOn: ["p"] }),
    ];

    const out = await runPlan(core, "aiotlab", tasks, artifacts, () => {});
    expect(submitOrder).toEqual(["parent", "child"]);
    expect(out.map((o) => o.key)).toEqual(["p", "c"]);
  });

  it("a confidential step's output does not travel to a normal child", async () => {
    // The leak this fences: a parent's output is written to an artifact and
    // attached to every step that depends on it, but routing filters on the
    // CHILD's sensitivity. So a confidential parent feeding a normal child
    // handed that output to a cloud bee — with the decision that forbade it
    // sitting correctly in the log. Taint follows the edge.
    const artifacts = new ArtifactStore(join(tmpdir(), `hive-taint-${Date.now()}`));
    const submittedAs = new Map<string, string>();

    const core: OrchestratorCore = {
      submitTask(spec: TaskSpec) {
        submittedAs.set(spec.title, spec.sensitivity);
        return {
          taskId: `id-${spec.title}`,
          status: "dispatched" as const,
          difficulty: "simple" as const,
          reason: "",
          sensitivity: spec.sensitivity,
        };
      },
      async awaitResult(taskId: string) {
        return fakeResult(taskId, "THE SECRET NUMBERS");
      },
    };

    const tasks = [
      PlannedTask.parse({ key: "p", title: "read", input: "the data", sensitivity: "confidential" }),
      PlannedTask.parse({ key: "c", title: "write", input: "a summary", dependsOn: ["p"] }),
    ];

    await runPlan(core, "aiotlab", tasks, artifacts, () => {});
    expect(submittedAs.get("read")).toBe("confidential");
    expect(submittedAs.get("write")).toBe("confidential");
  });

  it("taint follows the edge transitively, and a clean sibling stays clean", async () => {
    // Confidentiality that stops after one hop is not confidentiality; but it
    // must not spread sideways either, or one sensitive step drags a whole plan
    // onto local models and the decomposition stops being worth making.
    const artifacts = new ArtifactStore(join(tmpdir(), `hive-taint2-${Date.now()}`));
    const submittedAs = new Map<string, string>();

    const core: OrchestratorCore = {
      submitTask(spec: TaskSpec) {
        submittedAs.set(spec.title, spec.sensitivity);
        return {
          taskId: `id-${spec.title}`,
          status: "dispatched" as const,
          difficulty: "simple" as const,
          reason: "",
          sensitivity: spec.sensitivity,
        };
      },
      awaitResult: async (taskId: string) => fakeResult(taskId, "out"),
    };

    const tasks = [
      PlannedTask.parse({ key: "a", title: "secret", input: "x", sensitivity: "confidential" }),
      PlannedTask.parse({ key: "b", title: "downstream", input: "y", dependsOn: ["a"] }),
      PlannedTask.parse({ key: "c", title: "grandchild", input: "z", dependsOn: ["b"] }),
      PlannedTask.parse({ key: "s", title: "sibling", input: "w" }),
    ];

    await runPlan(core, "aiotlab", tasks, artifacts, () => {});
    expect(submittedAs.get("downstream")).toBe("confidential");
    expect(submittedAs.get("grandchild")).toBe("confidential");
    expect(submittedAs.get("sibling")).toBe("normal");
  });

  it("inherits an upgrade the core applied, not just the one the planner labelled", async () => {
    // submitTask can add confidentiality the caller never asked for, from the
    // task's own wording. If the orchestrator propagated only the planner's
    // label it would miss exactly those, which are the cases nobody noticed.
    const artifacts = new ArtifactStore(join(tmpdir(), `hive-taint3-${Date.now()}`));
    const submittedAs = new Map<string, string>();

    const core: OrchestratorCore = {
      submitTask(spec: TaskSpec) {
        submittedAs.set(spec.title, spec.sensitivity);
        // stands in for the core's own one-way grounding
        const grounded = spec.input.includes("unpublished") ? "confidential" : spec.sensitivity;
        return {
          taskId: `id-${spec.title}`,
          status: "dispatched" as const,
          difficulty: "simple" as const,
          reason: "",
          sensitivity: grounded as TaskSpec["sensitivity"],
        };
      },
      awaitResult: async (taskId: string) => fakeResult(taskId, "out"),
    };

    const tasks = [
      PlannedTask.parse({ key: "p", title: "read", input: "the unpublished results" }),
      PlannedTask.parse({ key: "c", title: "share", input: "a summary", dependsOn: ["p"] }),
    ];

    await runPlan(core, "aiotlab", tasks, artifacts, () => {});
    expect(submittedAs.get("read")).toBe("normal"); // as the planner labelled it
    expect(submittedAs.get("share")).toBe("confidential"); // as the core grounded it
  });

  it("runs independent tasks in the same wave", async () => {
    const artifacts = new ArtifactStore(join(tmpdir(), `hive-test2-${Date.now()}`));
    const core: OrchestratorCore = {
      submitTask: (spec) => ({ taskId: `id-${spec.title}`, status: "dispatched", difficulty: "simple", reason: "" }),
      awaitResult: async (taskId) => fakeResult(taskId, "ok"),
    };
    const tasks = [
      PlannedTask.parse({ key: "a", title: "a", input: "x" }),
      PlannedTask.parse({ key: "b", title: "b", input: "y" }),
    ];
    const out = await runPlan(core, "aiotlab", tasks, artifacts, () => {});
    expect(out.length).toBe(2);
  });
});
