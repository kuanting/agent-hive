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
