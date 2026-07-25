import { join } from "node:path";
import { ArtifactStore, TaskSpec } from "@hive/shared";
import type { QueenCore } from "../core.js";
import { scoreDifficulty, userAskedUrgent, userImpliedConfidential } from "../analyzer.js";
import { PlannerModel, type PlannerContext } from "./model.js";
import { runPlan, type StepOutcome, type StepProgress } from "./orchestrator.js";
import { SessionStore, type ConversationState } from "./session.js";
import { loadGuide } from "./guide.js";
import { MemoryStore } from "./memory/store.js";
import { renderMemories, selectMemories } from "./memory/recall.js";
import { reflect, type LearnedMemory } from "./memory/reflect.js";
import { trustOf, type MemoryRecord } from "./memory/types.js";
import type { PlannedTask } from "./types.js";

export type ChatEvent =
  | { type: "planner"; model: string; tier: number; decision: string; costUsd: number }
  | { type: "clarify"; question: string }
  | { type: "plan"; rationale: string; tasks: Array<{ key: string; title: string; skills: string[]; sensitivity: string }> }
  | { type: "task"; key: string; taskId?: string; phase: StepProgress["phase"]; tier?: number; runtime?: string; model?: string; costUsd?: number; degraded?: boolean }
  | { type: "recall"; memories: Array<{ id: string; type: string; name: string }>; chars: number }
  | { type: "learned"; memories: LearnedMemory[]; costUsd: number }
  | { type: "answer"; text: string }
  | { type: "session"; sessionId: string };

export { SessionStore };
export type { ConversationState };

/**
 * Kill switch for the whole learning loop. Off means no recall and no writes,
 * which restores byte-reproducible planning — worth having for a demo run or
 * for bisecting whether memory caused a behavior change.
 */
const MEMORY_ENABLED = process.env.HIVE_MEMORY !== "0";

/**
 * Conversational front-end to the hive. Turns chat into structured TaskSpecs and
 * narrates results. It proposes; QueenCore disposes. The planner never sets tier
 * or budget, and it meters its own model spend through the core.
 *
 * It also carries the Queen's experience: a hand-authored plan guide and memory
 * it writes itself. Both are advice that shapes decomposition, and both live on
 * this side of the wall — QueenCore is untouched by them.
 */
export class Planner {
  readonly sessions = new SessionStore();
  readonly memory: MemoryStore;
  private readonly model: PlannerModel;
  private readonly artifacts: ArtifactStore;

  constructor(
    private core: QueenCore,
    private readonly root: string,
    escalationModel?: string,
  ) {
    this.artifacts = new ArtifactStore(join(root, "artifacts"));
    this.model = new PlannerModel((m, i, o) => core.estimatePlannerCost(m, i, o), escalationModel);
    this.memory = new MemoryStore(join(root, "data", "memory"));
    this.memory.reconcile(core.customers.map((c) => c.customerId));
  }

  private liveSkills(): string[] {
    return [...new Set(this.core.registry.liveCapabilities().flatMap((c) => c.skills))];
  }

  private context(customerId: string, guide: string, memories: string): PlannerContext {
    const tools = this.core.tools.map((t) => ({ toolId: t.toolId, requiredKeys: t.requiredKeys }));
    return { skills: this.liveSkills(), tools, guide, memories };
  }

  /** Read-only view for GET /status. */
  snapshot() {
    return this.core.customers.map((c) => ({
      customerId: c.customerId,
      guideChars: loadGuide(this.root, c.customerId).length,
      memories: this.memory.load(c.customerId).map((m) => ({
        id: m.id,
        type: m.type,
        name: m.name,
        observed: m.observed,
        lastSeen: m.lastSeen,
        trust: trustOf(m),
        helped: m.helped,
        misfired: m.misfired,
        retired: m.retired,
      })),
    }));
  }

  async turn(session: ConversationState, userMessage: string, emit: (ev: ChatEvent) => void): Promise<string> {
    session.messages.push({ role: "user", content: userMessage });

    // KNOWN GAP (docs/DESIGN.md §10): this escalation has no confidentiality
    // gate. When `escalate` is true and the customer sets `plannerModel`, the
    // whole conversation goes to that model, which may be in the cloud —
    // before any task has been marked confidential, because sensitivity is
    // something the planner assigns to tasks it has not emitted yet. The
    // worker path is gated (tierMapper + allowedByConfidentiality); this one
    // is not. Do not widen this path without fixing it.
    const probe = TaskSpec.parse({ customerId: session.customerId, title: userMessage.slice(0, 60), input: userMessage });
    const escalate = scoreDifficulty(probe) === "complex";

    const guide = loadGuide(this.root, session.customerId);
    const recalled = MEMORY_ENABLED ? selectMemories(this.memory.load(session.customerId), userMessage) : [];
    const rendered = renderMemories(recalled);
    if (recalled.length > 0) {
      emit({
        type: "recall",
        memories: recalled.map((r) => ({ id: r.record.id, type: r.record.type, name: r.record.name })),
        chars: rendered.length,
      });
    }

    const turn = await this.model.plan(session.messages, this.context(session.customerId, guide, rendered), escalate);
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
        const tasks = this.groundSensitivity(this.groundUrgency(turn.decision.tasks, userMessage), userMessage);
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

        // Learn last, after the user already has their answer.
        await this.learn(
          session.customerId,
          userMessage,
          tasks,
          outcomes,
          turn.degraded === true,
          turn.tier,
          recalled.map((r) => r.record),
          emit,
        );
        break;
      }
    }

    session.messages.push({ role: "assistant", content: assistant });
    return assistant;
  }

  /**
   * Turn a finished plan into memory. Detectors are pure code, so a turn where
   * nothing notable happened — the common case — spends nothing at all here.
   */
  private async learn(
    customerId: string,
    userMessage: string,
    tasks: PlannedTask[],
    outcomes: StepOutcome[],
    plannerDegraded: boolean,
    plannerTier: number,
    recalled: MemoryRecord[],
    emit: (ev: ChatEvent) => void,
  ): Promise<void> {
    if (!MEMORY_ENABLED) return;

    const { learned, costUsd } = await reflect(
      {
        customerId,
        userMessage,
        planned: tasks,
        outcomes,
        attempts: new Map(outcomes.map((o) => [o.taskId, this.core.getTask(o.taskId)?.attempts ?? 1])),
        liveSkills: this.liveSkills(),
        tools: this.core.tools,
        maxAttempts: 3,
        plannerTier,
        recalled,
        confidential: tasks.some((t) => t.sensitivity === "confidential"),
        plannerDegraded,
      },
      this.memory,
      (p) => this.model.phraseLesson(p),
    );
    this.core.recordPlannerCost(costUsd);
    if (learned.length > 0) emit({ type: "learned", memories: learned, costUsd });
  }

  /**
   * urgency is the one PlannedTask field with routing consequences the schema
   * wall does not catch: tierMapper only spends per-token API dollars on urgent
   * work, and only urgent work skips waiting for a prepaid seat. So the planner
   * may propose it, but a deterministic check on the user's own words disposes.
   * Without this, a hallucination — or a learned note saying "mark tasks
   * urgent" — could reach capabilities the customer is paying to avoid.
   */
  private groundUrgency(tasks: PlannedTask[], userMessage: string): PlannedTask[] {
    if (userAskedUrgent(userMessage)) return tasks;
    return tasks.map((t) => (t.urgency === "urgent" ? { ...t, urgency: "normal" as const } : t));
  }

  /**
   * The same discipline applied to the stronger lever. sensitivity decides
   * whether work may leave the machine at all, and it was resting purely on
   * the planner's self-label — so a hallucination, or a learned note saying
   * "lab work is routine", could clear it.
   *
   * One-way by construction: this can only ADD confidentiality. The planner
   * may still mark anything confidential on its own; nothing here or in a
   * memory can unmark it.
   */
  private groundSensitivity(tasks: PlannedTask[], userMessage: string): PlannedTask[] {
    if (!userImpliedConfidential(userMessage)) return tasks;
    return tasks.map((t) => (t.sensitivity === "confidential" ? t : { ...t, sensitivity: "confidential" as const }));
  }
}
