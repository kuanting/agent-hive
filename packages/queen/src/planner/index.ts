import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { adequateTiers, ArtifactStore, TaskSpec } from "@hive/shared";
import type { QueenCore } from "../core.js";
import { scoreDifficulty, userAskedUrgent, userImpliedConfidential } from "../analyzer.js";
import { modeAllows, toEpisodeAttempt, toMetadata, toTaskLevel, type EpisodeRecord, type EpisodeTask } from "../episode.js";
import { PlannerModel, type PlannerContext } from "./model.js";
import { runPlan, type StepOutcome, type StepProgress } from "./orchestrator.js";
import { SessionStore, windowMessages, type ConversationState } from "./session.js";
import { loadGuide } from "./guide.js";
import { MemoryStore } from "./memory/store.js";
import { renderMemories, selectMemories } from "./memory/recall.js";
import { reflect, type LearnedMemory } from "./memory/reflect.js";
import { trustOf, type MemoryRecord } from "./memory/types.js";
import type { PlannedTask } from "./types.js";

/**
 * What the Queen is doing right now, in the order she does it.
 *
 * Turn phases, not streamed tokens, and that is a deliberate choice rather than a
 * shortcut. The planner call runs with Ollama's `format: "json"`, so streaming it
 * would type out JSON syntax — the appearance of thinking without the substance.
 * Real reasoning text would need a thinking-capable model and Ollama's `think`
 * flag, which would silently narrow which models can be the Queen's brain. These
 * phases cost nothing, work on every model, and answer the question someone
 * actually has while they wait: which part is taking the time.
 */
export type TurnPhase =
  | "recalling"
  | "planning"
  | "decided"
  | "dispatching"
  | "waiting"
  | "synthesizing"
  | "learning"
  | "complete";

export type ChatEvent =
  | { type: "phase"; name: TurnPhase; elapsedMs: number; detail?: string }
  | { type: "planner"; model: string; tier: number; decision: string; costUsd: number }
  | { type: "clarify"; question: string }
  | { type: "plan"; rationale: string; tasks: Array<{ key: string; title: string; skills: string[]; sensitivity: string }> }
  | {
      type: "task";
      key: string;
      taskId?: string;
      phase: StepProgress["phase"];
      tier?: number;
      agent?: string;
      agentId?: string;
      runtime?: string;
      model?: string;
      costUsd?: number;
      degraded?: boolean;
      /** on `running`: elapsed as reported by the bee; on `done`/`failed`: the result's own durationMs */
      elapsedMs?: number;
    }
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

  /**
   * What each live bee says it is for, for the planner's prompt only. Built from
   * the same registry snapshot as `liveSkills`, so the tags and the sentences
   * describing them can never disagree about which fleet is running.
   */
  private capabilityNotes(): Array<{ skills: string[]; description: string }> {
    return this.core.registry
      .liveCapabilities()
      .filter((c) => c.description)
      .map((c) => ({ skills: c.skills, description: c.description! }));
  }

  private context(customerId: string, guide: string, memories: string): PlannerContext {
    const tools = this.core.toolsFor(customerId).map((t) => ({ toolId: t.toolId, requiredKeys: t.requiredKeys }));
    return { skills: this.liveSkills(), tools, guide, memories, capabilityNotes: this.capabilityNotes() };
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
    const t0 = Date.now();
    // Phase boundaries were already emitted for the console; timing them costs a
    // subtraction and turns "the Queen feels slow" into a number per phase. That
    // is the measurement the planning-overhead question needs — see DESIGN.md §7,
    // "planning is overhead".
    const phaseMs: Record<string, number> = {};
    let phaseName: string | undefined;
    let phaseAt = t0;
    const phase = (name: TurnPhase, detail?: string) => {
      const now = Date.now();
      if (phaseName) phaseMs[phaseName] = (phaseMs[phaseName] ?? 0) + (now - phaseAt);
      phaseName = name;
      phaseAt = now;
      emit({ type: "phase", name, elapsedMs: now - t0, detail });
    };

    // KNOWN GAP (docs/DESIGN.md §10): this escalation has no confidentiality
    // gate. When `escalate` is true and the customer sets `plannerModel`, the
    // whole conversation goes to that model, which may be in the cloud —
    // before any task has been marked confidential, because sensitivity is
    // something the planner assigns to tasks it has not emitted yet. The
    // worker path is gated (tierMapper + allowedByConfidentiality); this one
    // is not. Do not widen this path without fixing it.
    const probe = TaskSpec.parse({ customerId: session.customerId, title: userMessage.slice(0, 60), input: userMessage });
    const escalate = scoreDifficulty(probe) === "complex";

    let episodeTasks: EpisodeTask[] = [];
    let planRationale: string | undefined;

    phase("recalling");
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

    // Named before the call, not after: this is the phase that takes the time,
    // and the model is the fact worth showing while it does — a turn stuck on a
    // cold local model looks the same as a fast one until you know which is running.
    const { model: plannerModel } = this.model.chooseModel(escalate);
    phase("planning", plannerModel);
    const plannerAt = Date.now();
    // Windowed, not the whole transcript: see windowMessages. The full history
    // stays on the session for GET /sessions/:id and the console.
    const turn = await this.model.plan(
      windowMessages(session.messages),
      this.context(session.customerId, guide, rendered),
      escalate,
    );
    const plannerMs = Date.now() - plannerAt;
    this.core.recordPlannerCost(turn.usage.costUsd);
    phase("decided", turn.decision.kind);
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

        // A plan can still be refused before it costs anything. Nothing has been
        // dispatched at this point, so turning it back into a question is free.
        const question = clarifyInsteadOfSpending(tasks, session.customerId);
        if (question) {
          assistant = question;
          emit({ type: "clarify", question });
          break;
        }

        emit({
          type: "plan",
          rationale: turn.decision.rationale,
          tasks: tasks.map((t) => ({ key: t.key, title: t.title, skills: t.skills, sensitivity: t.sensitivity })),
        });
        phase("dispatching", `${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
        let waiting = false;
        // The taskId this turn may continue is read before the plan runs, since
        // the line below overwrites it with this turn's own outcome.
        const continuesFrom = session.lastTaskId;
        const outcomes = await runPlan(this.core, session.customerId, tasks, this.artifacts, (p) => {
          // The first bee to report back is the moment the turn stops being about
          // the Queen and starts being about the hive. Announce it once, not per
          // tick — `running` repeats every few seconds by design.
          if (p.phase === "running" && !waiting) {
            waiting = true;
            phase("waiting");
          }
          const r = p.result;
          emit({
            type: "task",
            key: p.key,
            taskId: p.taskId,
            phase: p.phase,
            tier: r?.tierUsed ?? p.runningOn?.tier,
            // agent = what the bee was configured to run, runtime = what ran,
            // agentId = which bee. The console needs all three to label a task
            // by its owner and still show a substitution.
            agent: r?.agent ?? p.runningOn?.agent,
            agentId: r?.agentId ?? p.runningOn?.agentId,
            runtime: r?.runtime ?? p.runningOn?.runtime,
            model: r?.model ?? p.runningOn?.model,
            costUsd: r?.usage.costUsd,
            degraded: r?.degraded,
            elapsedMs: r?.durationMs ?? p.elapsedMs,
          });
        }, continuesFrom);
        for (const o of outcomes) session.taskKeys[o.key] = o.taskId;

        // Remember a continuation point only when this turn produced exactly one
        // task. With several, "the task this conversation continues" has no
        // single answer, and picking one arbitrarily would warm the wrong bee.
        session.lastTaskId = outcomes.length === 1 && outcomes[0].result.ok ? outcomes[0].taskId : undefined;

        if (outcomes.length === 1) {
          assistant = outcomes[0].result.output;
        } else if (outcomes.length === 0) {
          assistant = "I could not complete any of the planned steps.";
        } else {
          phase("synthesizing", `${outcomes.length} results`);
          const syn = await this.model.synthesize(
            userMessage,
            outcomes.map((o) => ({ title: o.title, output: o.result.output })),
          );
          this.core.recordPlannerCost(syn.costUsd);
          assistant = syn.text;
        }
        emit({ type: "answer", text: assistant });

        // Learn last, after the user already has their answer — and off the
        // turn's critical path, not merely after it. Awaiting reflection held the
        // SSE connection open across a model call the user was not waiting for,
        // which is latency multiplied by every concurrent user. `pendingLearn`
        // keeps it awaitable for tests and for a graceful shutdown.
        phase("learning");
        this.pendingLearn = this.learn(
          session.customerId,
          userMessage,
          tasks,
          outcomes,
          turn.degraded === true,
          turn.tier,
          recalled.map((r) => r.record),
          emit,
        ).catch((err) => {
          console.warn(`[queen] reflection failed: ${String(err).slice(0, 200)}`);
        });
        episodeTasks = outcomes.map((o) => this.episodeTask(o));
        planRationale = turn.decision.rationale;
        break;
      }
    }

    phase("complete");
    session.messages.push({ role: "assistant", content: assistant });

    this.recordEpisode({
      session,
      userMessage,
      assistant,
      decision: turn.decision.kind,
      escalate,
      difficulty: scoreDifficulty(probe),
      plannerModel: turn.modelUsed,
      plannerTier: turn.tier,
      plannerUsage: turn.usage,
      plannerMs,
      recalled: recalled.map((r) => r.record.id),
      recalledChars: rendered.length,
      phaseMs,
      tasks: episodeTasks,
      planRationale,
      wallMs: Date.now() - t0,
    });

    return assistant;
  }

  /**
   * Reflection in flight, if any. Awaitable so a test or a shutdown can wait for
   * the learning that deliberately does not block a turn.
   */
  pendingLearn?: Promise<void>;

  /**
   * One task's contribution to an episode, including every attempt it took.
   *
   * The attempt chain is read from the core rather than from the StepOutcome: an
   * outcome carries only the final result, so a task that failed at tier 3 and
   * succeeded at tier 1 would record as a clean tier-1 success — erasing the one
   * transition that says the difficulty scorer was wrong.
   */
  private episodeTask(o: StepOutcome): EpisodeTask {
    const history = this.core.attemptHistory(o.taskId);
    const results = history.length ? history : [o.result];
    return {
      key: o.key,
      taskId: o.taskId,
      title: o.title,
      skills: o.spec.skills,
      // Declared since this record existed and never written, which left the
      // corpus without the one column it was collected to label: what the
      // scorer *said* before the attempt chain showed what was actually needed.
      difficulty: scoreDifficulty(o.spec),
      sensitivity: o.spec.sensitivity,
      // Names only, and kept at every mode — this is what `missedToolMatch`
      // reasons about, so it is the difference between a corpus that can see
      // "one key away from tier 4" and one that cannot.
      toolInputKeys: o.spec.toolInput ? Object.keys(o.spec.toolInput).sort() : undefined,
      toolInput: o.spec.toolInput,
      ok: o.result.ok,
      input: o.spec.input,
      output: o.result.output,
      attempts: results.map(toEpisodeAttempt),
    };
  }

  /**
   * Write the turn down, at whatever fidelity the customer allowed.
   *
   * Confidentiality is decided here rather than at the call sites: one place
   * that can downgrade a record cannot disagree with itself, and the check is
   * one-way — a confidential task anywhere in the turn strips the text from all
   * of it, including the user message that produced it.
   */
  private recordEpisode(args: {
    session: ConversationState;
    userMessage: string;
    assistant: string;
    decision: string;
    escalate: boolean;
    difficulty: string;
    plannerModel?: string;
    plannerTier?: number;
    plannerUsage: { inputTokens: number; outputTokens: number; costUsd: number };
    plannerMs: number;
    recalled: string[];
    recalledChars: number;
    phaseMs: Record<string, number>;
    tasks: EpisodeTask[];
    planRationale?: string;
    wallMs: number;
  }): void {
    const customerId = args.session.customerId;
    const mode = this.core.episodeMode(customerId);
    if (mode === "off") return;

    const attempts = args.tasks.flatMap((t) => t.attempts);
    let rec: EpisodeRecord = {
      turnId: randomUUID(),
      customerId,
      at: Date.now(),
      mode,
      planner: {
        model: args.plannerModel,
        tier: args.plannerTier,
        decision: args.decision,
        escalated: args.escalate,
        difficulty: args.difficulty,
        inputTokens: args.plannerUsage.inputTokens,
        outputTokens: args.plannerUsage.outputTokens,
        costUsd: args.plannerUsage.costUsd,
        latencyMs: args.plannerMs,
      },
      recall: args.recalled.length ? { ids: args.recalled, chars: args.recalledChars } : undefined,
      routing: this.core.routingPolicy(customerId),
      phaseMs: args.phaseMs,
      tasks: args.tasks,
      totals: {
        inputTokens: attempts.reduce((s, a) => s + a.inputTokens, args.plannerUsage.inputTokens),
        outputTokens: attempts.reduce((s, a) => s + a.outputTokens, args.plannerUsage.outputTokens),
        costUsd: attempts.reduce((s, a) => s + a.costUsd, args.plannerUsage.costUsd),
        wallMs: args.wallMs,
        attempts: attempts.length,
      },
      outcome: { ok: args.tasks.every((t) => t.ok), answerChars: args.assistant.length },
      userMessage: args.userMessage,
      planRationale: args.planRationale,
      answer: args.assistant,
    };

    // Ordered so the ratchet always wins: confidential work is stripped to
    // metadata whatever rung the customer chose, and only then does the chosen
    // rung decide how much of what is left survives.
    if (!modeAllows(mode, "tasks")) {
      rec = toMetadata(rec, "customer profile does not opt into recording task text");
    } else if (args.tasks.some((t) => t.sensitivity === "confidential")) {
      rec = toMetadata(rec, "turn contained confidential work");
    } else if (mode === "tasks") {
      rec = toTaskLevel(rec);
    }
    this.core.episodes.append(rec, (msg) => console.warn(`[queen] ${msg}`));
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
        tools: this.core.toolsFor(customerId),
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

/** A task whose brief is too thin to be worth a frontier seat. */
function thinSpec(task: PlannedTask): boolean {
  const input = task.input.trim();
  // Either almost nothing was written, or the "input" is just the title again —
  // which is what a planner produces when it had nothing to work with.
  return input.length < THIN_INPUT_CHARS || input.toLowerCase() === task.title.trim().toLowerCase();
}

/** Under this many characters, a task brief is not a brief. */
const THIN_INPUT_CHARS = 40;

/**
 * The third deterministic check, in the same shape as the two above: ask before
 * spending, when there is nothing to spend it on.
 *
 * `clarify` rested entirely on the planner model's judgment ("Use clarify when
 * the request is too vague to act on"), which is the one instruction a small
 * local model is least reliable about — it would rather produce a plan. The cost
 * of that asymmetry is not symmetric: a vague request scored `complex` routes to
 * tiers [1, 2] (adequateTiers), which is a frontier seat or per-token dollars
 * spent on a task whose entire brief is a sentence fragment. One free local turn
 * asking what was meant is strictly cheaper than one wrong expensive run.
 *
 * Deliberately narrow. It fires only when the work is BOTH expensive-by-routing
 * and thin-by-content, so a short-but-clear task ("restart the pump logger")
 * still runs, and a long vague one still runs — this is not a quality filter,
 * it is a spend guard on the one combination that cannot be worth it.
 *
 * @returns a question to ask instead of the plan, or undefined to proceed.
 */
export function clarifyInsteadOfSpending(tasks: PlannedTask[], customerId: string): string | undefined {
  const expensiveAndThin = tasks.filter((t) => {
    const spec = TaskSpec.parse({ customerId, title: t.title, input: t.input, skills: t.skills });
    const tiers = adequateTiers(scoreDifficulty(spec));
    return tiers.every((tier) => tier <= 2) && thinSpec(t);
  });
  if (expensiveAndThin.length === 0) return undefined;
  const titles = expensiveAndThin.map((t) => `"${t.title}"`).join(", ");
  return (
    `Before I put ${expensiveAndThin.length === 1 ? "this" : "these"} on an expensive model I want to get ${titles} right. ` +
    `Could you say a little more about what the result should contain, and what it is for?`
  );
}
