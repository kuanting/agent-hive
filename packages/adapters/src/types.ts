import type { CapabilityRecord, TaskMessage } from "@hive/shared";

export interface ExecResult {
  ok: boolean;
  output: string;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  /** actual USD reported by the runtime, when it knows (e.g. Claude Code API billing) */
  reportedUsd?: number;
  /** what actually executed, e.g. "opencode" or "ollama-direct" fallback */
  runtimeUsed: string;
  modelUsed?: string;
  /**
   * Whatever the runtime said about itself rather than about the task: CLI
   * chatter on stdout, anything it wrote to stderr, a tool-name repair notice.
   *
   * Kept separate from `output` because these are two different things with two
   * different destinations — the answer is the result, this is narration the
   * worker logs against the task id. Separating them is what lets the hive keep
   * both: a runtime's diagnostics used to be either discarded (stderr) or
   * silently prepended to the answer (stdout), so the only way to see one was
   * for it to corrupt a result.
   *
   * Never a place for secrets; adapters redact before filling it.
   */
  diagnostics?: string[];
  /**
   * The runtime's own session id for this run, when it has one, so a follow-up
   * task can resume the same conversation instead of starting cold. An
   * identifier only — never the transcript it refers to.
   */
  sessionRef?: string;
  /**
   * Prompt-cache accounting, when the provider reports it. Counts only.
   *
   * Present so the hive can *check* whether caching is working rather than assume
   * it: a `cache_control` marker on a prefix shorter than the model's minimum is
   * silently ignored, and zero here is the only way to see that.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface RuntimeAdapter {
  /** runtimes this adapter can execute */
  runtimes: string[];
  execute(task: TaskMessage, capability: CapabilityRecord, prompt: string): Promise<ExecResult>;
}

/**
 * The unchanging head of every bee prompt — level 4 of the token-minimization
 * ladder (DESIGN.md §7), which the planner's own prompt already implements and
 * no bee prompt did.
 *
 * Prefix caching is a prefix match, so what matters is not that this text exists
 * but that it sits at byte zero and is byte-identical across tasks. `buildPrompt`
 * used to open with `Task: ${title}`, a per-task string in the first bytes, which
 * makes a hit impossible no matter what the provider supports.
 *
 * Nothing per-task, per-customer, or per-clock may go in here. A date, a task id,
 * or a customer name would each turn one shared prefix into one prefix per
 * request and quietly undo the whole exercise.
 */
export const STABLE_PROMPT_PREFIX = [
  "You are a worker bee in an AI agent hive. You execute exactly one task and return its result.",
  "",
  "How to answer:",
  "- Do the task described below and nothing beyond it.",
  "- Return the result itself, not a description of how you would produce it.",
  "- No preamble, no restatement of the task, no closing summary.",
  "- If the task cannot be completed, say so in one sentence and state what is missing.",
  "- Material provided as an artifact may be truncated; work with what is present and say so if it is not enough.",
].join("\n");

/**
 * Split an assembled prompt back into its stable head and per-task body, for
 * runtimes that take a separate system parameter.
 *
 * The prefix is built into the prompt string because most runtimes take one blob
 * (a CLI's `-p`, Ollama's user turn). The provider APIs take a `system` field,
 * and that is where the stable half belongs: it renders ahead of the messages, so
 * it is the part a cache breakpoint can actually cover. Splitting rather than
 * duplicating — sending it in both places would pay for the same tokens twice.
 */
export function splitStablePrefix(prompt: string): { system?: string; body: string } {
  if (!prompt.startsWith(STABLE_PROMPT_PREFIX)) return { body: prompt };
  return { system: STABLE_PROMPT_PREFIX, body: prompt.slice(STABLE_PROMPT_PREFIX.length).trimStart() };
}

/**
 * Token minimization level 3: assemble the smallest useful prompt.
 * Artifacts are passed by reference over the broker; here we inline only a
 * capped slice of each. Escalations carry the failure summary, never the
 * lower-tier transcript.
 *
 * Ordering is load-bearing: stable content first, per-task content last. See
 * STABLE_PROMPT_PREFIX.
 */
export function buildPrompt(
  task: TaskMessage,
  readArtifact: (ref: string) => string,
  artifactBudgetChars = 6000,
): string {
  const parts = [STABLE_PROMPT_PREFIX, `Task: ${task.spec.title}`, task.spec.input];
  if (task.escalation) {
    parts.push(`A previous attempt failed. Summary: ${task.escalation.failureSummary}`);
  }
  for (const ref of task.spec.artifacts) {
    try {
      const content = readArtifact(ref).slice(0, artifactBudgetChars);
      parts.push(`--- artifact ${ref} (may be truncated) ---\n${content}`);
    } catch {
      parts.push(`--- artifact ${ref} unavailable ---`);
    }
  }
  return parts.join("\n\n");
}
