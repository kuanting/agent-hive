import { join } from "node:path";
import { ArtifactStore, TaskSpec } from "@hive/shared";
import type { QueenCore } from "../core.js";
import { scoreDifficulty } from "../analyzer.js";
import { PlannerModel, type PlannerContext } from "./model.js";
import { runPlan, type StepProgress } from "./orchestrator.js";
import { SessionStore, type ConversationState } from "./session.js";

export type ChatEvent =
  | { type: "planner"; model: string; tier: number; decision: string; costUsd: number }
  | { type: "clarify"; question: string }
  | { type: "plan"; rationale: string; tasks: Array<{ key: string; title: string; skills: string[]; sensitivity: string }> }
  | { type: "task"; key: string; taskId?: string; phase: StepProgress["phase"]; tier?: number; runtime?: string; model?: string; costUsd?: number; degraded?: boolean }
  | { type: "answer"; text: string }
  | { type: "session"; sessionId: string };

export { SessionStore };
export type { ConversationState };

/**
 * Conversational front-end to the hive. Turns chat into structured TaskSpecs and
 * narrates results. It proposes; QueenCore disposes. The planner never sets tier
 * or budget, and it meters its own model spend through the core.
 */
export class Planner {
  readonly sessions = new SessionStore();
  private readonly model: PlannerModel;
  private readonly artifacts: ArtifactStore;

  constructor(
    private core: QueenCore,
    root: string,
    escalationModel?: string,
  ) {
    this.artifacts = new ArtifactStore(join(root, "artifacts"));
    this.model = new PlannerModel((m, i, o) => core.estimatePlannerCost(m, i, o), escalationModel);
  }

  private context(): PlannerContext {
    const skills = [...new Set(this.core.registry.liveCapabilities().flatMap((c) => c.skills))];
    const tools = this.core.tools.map((t) => ({ toolId: t.toolId, requiredKeys: t.requiredKeys }));
    return { skills, tools };
  }

  async turn(session: ConversationState, userMessage: string, emit: (ev: ChatEvent) => void): Promise<string> {
    session.messages.push({ role: "user", content: userMessage });

    const probe = TaskSpec.parse({ customerId: session.customerId, title: userMessage.slice(0, 60), input: userMessage });
    const escalate = scoreDifficulty(probe) === "complex";

    const turn = await this.model.plan(session.messages, this.context(), escalate);
    this.core.recordPlannerCost(turn.usage.costUsd);
    emit({ type: "planner", model: turn.modelUsed, tier: turn.tier, decision: turn.decision.kind, costUsd: turn.usage.costUsd });

    let assistant: string;
    switch (turn.decision.kind) {
      case "clarify":
        assistant = turn.decision.question;
        emit({ type: "clarify", question: assistant });
        break;
      case "answer":
        assistant = turn.decision.text;
        emit({ type: "answer", text: assistant });
        break;
      case "plan": {
        const tasks = turn.decision.tasks;
        emit({
          type: "plan",
          rationale: turn.decision.rationale,
          tasks: tasks.map((t) => ({ key: t.key, title: t.title, skills: t.skills, sensitivity: t.sensitivity })),
        });
        const outcomes = await runPlan(this.core, session.customerId, tasks, this.artifacts, (p) => {
          const r = p.result;
          emit({
            type: "task",
            key: p.key,
            taskId: p.taskId,
            phase: p.phase,
            tier: r?.tierUsed,
            runtime: r?.runtime,
            model: r?.model,
            costUsd: r?.usage.costUsd,
            degraded: r?.degraded,
          });
        });
        for (const o of outcomes) session.taskKeys[o.key] = o.taskId;

        if (outcomes.length === 1) {
          assistant = outcomes[0].result.output;
        } else if (outcomes.length === 0) {
          assistant = "I could not complete any of the planned steps.";
        } else {
          const syn = await this.model.synthesize(
            userMessage,
            outcomes.map((o) => ({ title: o.title, output: o.result.output })),
          );
          this.core.recordPlannerCost(syn.costUsd);
          assistant = syn.text;
        }
        emit({ type: "answer", text: assistant });
        break;
      }
    }

    session.messages.push({ role: "assistant", content: assistant });
    return assistant;
  }
}
