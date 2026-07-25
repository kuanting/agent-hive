import type { Difficulty, TaskSpec } from "@hive/shared";

export interface ToolInfo {
  toolId: string;
  skills: string[];
  /** top-level keys the tool's input schema requires */
  requiredKeys: string[];
}

/**
 * Tier-4 tool match: a registered tool whose skill tags overlap the task and
 * whose required input keys are all present in spec.toolInput.
 * An exact tool match beats any LLM (free and deterministic).
 */
export function matchTool(spec: TaskSpec, tools: ToolInfo[]): ToolInfo | undefined {
  if (!spec.toolInput) return undefined;
  const keys = new Set(Object.keys(spec.toolInput));
  return tools.find(
    (t) =>
      t.requiredKeys.every((k) => keys.has(k)) &&
      (t.skills.length === 0 || t.skills.some((s) => spec.skills.includes(s))),
  );
}

/**
 * The inverse of matchTool: a tool this task *should* have hit but didn't,
 * because its required keys were absent from spec.toolInput. The skill overlap
 * is required for the same reason matchTool requires it — without it every task
 * "misses" every tool. Used by planner reflection to learn the single most
 * valuable lesson available: filling these keys moves the task to tier 4, where
 * it costs zero tokens.
 */
export function missedToolMatch(
  spec: TaskSpec,
  tools: ToolInfo[],
): { toolId: string; missingKeys: string[] } | undefined {
  if (matchTool(spec, tools)) return undefined;
  const keys = new Set(Object.keys(spec.toolInput ?? {}));
  const text = `${spec.title}\n${spec.input}`.toLowerCase();
  for (const t of tools) {
    if (t.skills.length > 0 && !t.skills.some((s) => spec.skills.includes(s))) continue;
    const missingKeys = t.requiredKeys.filter((k) => !keys.has(k));
    if (missingKeys.length === 0) continue;
    // Skill overlap alone is not enough. "Write a paragraph explaining the
    // trend" is legitimately tagged `reporting` and legitimately has no
    // toolInput — it is prose, not a table operation — yet it would otherwise
    // count as a missed csv-report match. That produced false lessons, and
    // once memory feedback existed it also punished the very note the planner
    // had just obeyed on a sibling task. Require some sign the task actually
    // has the data the tool wants.
    if (!missingKeys.some((k) => text.includes(k.toLowerCase()))) continue;
    return { toolId: t.toolId, missingKeys };
  }
  return undefined;
}

const URGENT_HINT = /\burgent\b|\basap\b|immediately|right now|\bcritical\b|production (is )?down/i;

/**
 * Did the *user* actually ask for urgency?
 *
 * urgency is the one PlannedTask field with routing consequences the schema
 * wall doesn't catch: tierMapper only spends per-token API dollars on urgent
 * work, and only urgent work skips waiting for a prepaid seat window. So a
 * planner that marks everything urgent — whether it hallucinated, or read a
 * learned note telling it to — can reach capabilities the customer is paying to
 * avoid. The Queen's own principle applies: the planner may propose urgency,
 * this deterministic check disposes.
 */
export function userAskedUrgent(text: string): boolean {
  return URGENT_HINT.test(text);
}

const CONFIDENTIAL_HINT =
  /\bconfidential\b|\bproprietary\b|\bunpublished\b|\bunreleased\b|\binternal only\b|\bdo not share\b|\bnda\b|\bsecret\b|\bprivate\b|\bgrades?\b|\bstudent data\b/i;

/**
 * Did the *user* signal that this material is sensitive?
 *
 * sensitivity is the strongest lever on PlannedTask: it decides whether work
 * may leave the machine at all (tierMapper + allowedByConfidentiality restrict
 * confidential tasks to local/free billing) and whether the turn is allowed to
 * write memory. Unlike urgency it was never grounded, so it rested entirely on
 * the planner's self-label — and a learned note or a hallucination reading
 * "this work is routine, sensitivity normal" was enough to move it.
 *
 * The grounding is deliberately one-way. A hit here can only ever ADD
 * confidentiality; nothing may take it away, because the failure modes are not
 * symmetric — wrongly marking a task confidential costs some capability, while
 * wrongly clearing it leaks. Same principle as the exact-word enum in
 * planner/types.ts: the safety gate never loosens by accident.
 */
export function userImpliedConfidential(text: string): boolean {
  return CONFIDENTIAL_HINT.test(text);
}

const COMPLEX_HINTS = [
  /refactor|architect|design|migrate|debug|optimi[sz]e|implement|prove/i,
  /multi[- ]step|end[- ]to[- ]end|across (files|modules|services)/i,
];
const CODE_HINT = /```|\bfunction\b|\bclass\b|\bdef\b|\bimport\b|\.ts\b|\.py\b|\.c\b/i;
const STANDARD_HINTS = [/summari[sz]e|translate|extract|classify|convert|rewrite|analy[sz]e/i];

/**
 * Heuristic difficulty scoring. Deliberately cheap: length, code presence,
 * multi-step verbs. A small local Ollama model can be layered on for ambiguous
 * cases; the heuristics alone are enough for the PoC and cost zero tokens.
 */
export function scoreDifficulty(spec: TaskSpec): Difficulty {
  const text = `${spec.title}\n${spec.input}`;
  const long = text.length > 2000 || spec.artifacts.length > 2;
  const code = CODE_HINT.test(text);
  const complex = COMPLEX_HINTS.some((r) => r.test(text));

  if (complex || (code && long)) return "complex";
  if (code || long || STANDARD_HINTS.some((r) => r.test(text))) return "standard";
  return "simple";
}
