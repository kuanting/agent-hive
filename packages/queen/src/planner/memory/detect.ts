import { missedToolMatch, type ToolInfo } from "../../analyzer.js";
import type { StepOutcome } from "../orchestrator.js";
import type { PlannedTask } from "../types.js";
import { tokenize } from "./recall.js";
import type { Observation } from "./types.js";

/**
 * What reflection gets to look at. Everything here is already held by the
 * Planner at the end of a turn — QueenCore is not modified to feed this.
 */
export interface TurnFacts {
  userMessage: string;
  planned: PlannedTask[];
  outcomes: StepOutcome[];
  /** attempts per taskId, from QueenCore.getTask — public since before this feature */
  attempts: Map<string, number>;
  liveSkills: string[];
  tools: ToolInfo[];
  maxAttempts: number;
  /**
   * The tier the planning itself ran at (3 local, 2 when it escalated to the
   * customer's plannerModel). Lower is stronger, matching the hive's tiers.
   * D5 compares against this — see detectPlaybook.
   */
  plannerTier?: number;
}

/** Content words of the message that caused this turn, capped. Recall gates on these. */
function triggersFrom(message: string, extra: string[] = []): string[] {
  return [...new Set([...extra.map((s) => s.toLowerCase()), ...tokenize(message)])].slice(0, 12);
}

/**
 * D1 — a tool this plan should have hit. The highest-value lesson available:
 * filling the missing key moves the task to tier 4, where it costs no tokens
 * at all. Templated entirely from customers/*.yaml values, so it is free to
 * mint however often it fires.
 */
function detectMissedTool(f: TurnFacts): Observation[] {
  const out: Observation[] = [];
  const seen = new Set<string>();
  for (const o of f.outcomes) {
    if (o.result.tierUsed === 4) continue;
    const miss = missedToolMatch(o.spec, f.tools);
    if (!miss) continue;
    const id = `mt-${miss.toolId}-${[...miss.missingKeys].sort().join("-")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const keys = miss.missingKeys.join(", ");
    out.push({
      id,
      type: "pitfall",
      source: "detector:missed-tool-match",
      name: `Tasks like this match tool ${miss.toolId}; set toolInput.${miss.missingKeys[0]} to run at tier 4 for zero tokens`,
      description: `A task ran at tier ${o.result.tierUsed} although ${miss.toolId} was registered and only ${keys} was missing from toolInput.`,
      triggers: triggersFrom(f.userMessage, o.spec.skills),
      skills: o.spec.skills,
      evidence: [o.taskId],
      body: `The task "${o.title}" ran on an LLM although the ${miss.toolId} tool was registered. Include ${keys} in toolInput on tasks of this shape; the Queen then matches tier 4 and the step costs nothing.`,
    });
  }
  return out;
}

/**
 * D2 — a skill tag no live capability advertises. The planner emits free-form
 * tags, and an unmatched one silently routes to "general" (core.ts falls back
 * there deliberately, so the task is not stranded). Highest-confidence
 * detector: the live skill set is already computed for the prompt.
 */
function detectUnknownSkill(f: TurnFacts): Observation[] {
  if (f.liveSkills.length === 0) return [];
  const live = new Set(f.liveSkills.map((s) => s.toLowerCase()));
  const out: Observation[] = [];
  const seen = new Set<string>();

  for (const t of f.planned) {
    for (const tag of t.skills) {
      const lower = tag.toLowerCase();
      if (live.has(lower) || seen.has(lower)) continue;
      seen.add(lower);
      const nearest = nearestSkill(lower, f.liveSkills);
      out.push({
        id: `us-${slug(lower)}`,
        type: "pitfall",
        source: "detector:unknown-skill",
        name: `The hive has no "${tag}" skill; use ${nearest} instead`,
        description: `Skill tag "${tag}" matches no live capability, so it routes to "general" and the routing hint is wasted.`,
        triggers: triggersFrom(f.userMessage, [lower]),
        skills: [],
        evidence: [],
        body: `No worker advertises "${tag}". Available skills: ${f.liveSkills.join(", ")}. Use ${nearest} for this kind of work.`,
      });
    }
  }
  return out;
}

/**
 * D3 — the DAG stalled. runPlan puts failed-but-completed tasks into `done`,
 * so a short return means only one thing: the ready-set emptied with work left,
 * i.e. a cycle or a dependsOn pointing at a key that was never planned.
 */
function detectDagStall(f: TurnFacts): Observation[] {
  if (f.outcomes.length >= f.planned.length) return [];

  const keys = new Set(f.planned.map((t) => t.key));
  const dangling = f.planned.flatMap((t) => t.dependsOn.filter((d) => !keys.has(d)));
  const isDangling = dangling.length > 0;

  return [
    {
      id: isDangling ? "ds-dangling-dep" : "ds-cycle",
      type: "pitfall",
      source: "detector:dag-stall",
      name: isDangling
        ? "dependsOn must name a task key from the same plan, or the step never runs"
        : "Plans must not contain dependency cycles, or the steps never run",
      description: isDangling
        ? `dependsOn referenced ${dangling.slice(0, 3).join(", ")}, which no task in the plan defines.`
        : "Every remaining task was waiting on another, so none could start.",
      triggers: triggersFrom(f.userMessage),
      skills: [],
      evidence: f.outcomes.slice(0, 1).map((o) => o.taskId),
      body: isDangling
        ? `${f.planned.length - f.outcomes.length} step(s) never ran because dependsOn named ${dangling.slice(0, 3).join(", ")} — keys that do not exist in the plan. Only reference keys defined in the same tasks array.`
        : `${f.planned.length - f.outcomes.length} step(s) never ran because their dependencies formed a cycle. Keep dependsOn pointing strictly backwards.`,
    },
  ];
}

/**
 * D4 — the plan needed the escalation ladder. Raw attempts > 1 is usually a
 * *worker* failure rather than a *planning* failure and would be noisy, so this
 * only fires when the plan itself is implicated: it failed outright, or a lone
 * task had to be retried, which is what under-decomposition looks like.
 */
function detectEscalation(f: TurnFacts): Observation[] {
  const worst = f.outcomes.reduce((n, o) => Math.max(n, f.attempts.get(o.taskId) ?? 1), 1);
  const single = f.planned.length === 1;
  if (worst < f.maxAttempts && !(worst > 1 && single)) return [];

  return [
    {
      id: `esc-${single ? "single" : "multi"}`,
      type: "pitfall",
      source: "detector:escalation",
      name: single
        ? "Requests like this need splitting: one task took several attempts before it succeeded"
        : "Requests like this needed retries; give each step a narrower, self-contained input",
      description: `A task in this plan took ${worst} attempt(s).`,
      triggers: triggersFrom(f.userMessage),
      skills: f.planned.flatMap((t) => t.skills),
      evidence: f.outcomes.slice(0, 2).map((o) => o.taskId),
      body: single
        ? `A single-task plan for this kind of request needed ${worst} attempts. Split it into narrower steps so each one starts at a tier that can finish it.`
        : `Steps here needed ${worst} attempts. Make each task's input self-contained so a cheaper tier can complete it first time.`,
    },
  ];
}

/**
 * D5 — a clean multi-step plan worth reusing. Gated hard: ungated it would mint
 * a playbook every turn and blow the file cap. It is also the only detector
 * whose sentence a model gets to write, so the gate is what keeps reflection
 * near-free.
 *
 * The last gate is the subtle one. Splitting a request only pays when the
 * executor is STRONGER than the planner, or when a step reaches a tool. On a
 * single machine — the common demo setup — the Queen and the local bee are the
 * same small Ollama model, so a 3-task plan is 1 planning call plus 3 worker
 * calls plus 1 synthesis call of *one* 4B model to answer what a single call
 * might have answered, each subtask seeing less context than the whole. If the
 * Queen rewarded that shape it would learn to be slower, more expensive and
 * worse.
 *
 * The comparison is by TIER, not by model name. Model-string inequality gets
 * this exactly backwards on the escalation path: a complex request sends the
 * planning to a cloud model while the steps still run on the local bee, so the
 * names differ, the steps are *weaker* than the planner, and a name check would
 * call that an escape and mint a playbook for it.
 */
function detectPlaybook(f: TurnFacts): Observation[] {
  if (f.planned.length < 2) return [];
  const clean = f.outcomes.length === f.planned.length &&
    f.outcomes.every((o) => o.result.ok && !o.result.degraded && (f.attempts.get(o.taskId) ?? 1) === 1);
  if (!clean) return [];

  // tier 4 is a tool: no model at all, so it always counts as an escape.
  const reachedStronger = f.outcomes.some(
    (o) => o.result.tierUsed === 4 || (f.plannerTier !== undefined && o.result.tierUsed < f.plannerTier),
  );
  if (f.plannerTier !== undefined && !reachedStronger) return [];

  const skills = [...new Set(f.planned.flatMap((t) => t.skills))].sort();
  const depth = Math.max(...f.planned.map((t) => t.dependsOn.length));
  const shape = `${f.planned.length}-${skills.join(".") || "none"}-${depth}`;

  return [
    {
      id: `pb-${slug(shape)}`,
      type: "playbook",
      source: "detector:clean-plan",
      name: `Requests like this work well as ${f.planned.length} steps: ${f.planned.map((t) => t.title).join(" → ")}`,
      description: `A ${f.planned.length}-task plan over [${skills.join(", ")}] completed first try with no degradation.`,
      triggers: triggersFrom(f.userMessage, skills),
      skills,
      evidence: f.outcomes.map((o) => o.taskId),
      body: `Worked first try: ${f.planned.map((t, i) => `${i + 1}. ${t.title}`).join("; ")}.`,
      phrasePrompt: `A user asked: "${f.userMessage.slice(0, 300)}". It was completed cleanly by this plan: ${f.planned
        .map((t, i) => `${i + 1}. ${t.title}`)
        .join("; ")}. Write ONE short sentence (max 25 words) telling a planner how to decompose this KIND of request in future. No preamble.`,
    },
  ];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "x";
}

/** Nearest live skill by token overlap, so the lesson can suggest a real alternative. */
function nearestSkill(tag: string, live: string[]): string {
  const t = tokenize(tag);
  let best = live[0] ?? "general";
  let bestScore = -1;
  for (const s of live) {
    const overlap = [...tokenize(s)].filter((w) => t.has(w)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = s;
    }
  }
  return `"${best}"`;
}

/**
 * Run every detector. Pure, synchronous, zero tokens — nothing here calls a
 * model. When this returns [], the turn ends having spent nothing on learning,
 * which is the common case.
 */
export function detect(f: TurnFacts): Observation[] {
  return [
    ...detectMissedTool(f),
    ...detectUnknownSkill(f),
    ...detectDagStall(f),
    ...detectEscalation(f),
    ...detectPlaybook(f),
  ];
}
