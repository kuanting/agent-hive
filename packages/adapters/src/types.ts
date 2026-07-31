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
 * The unchanging head of every bee prompt — level 4 of the token-optimization
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
 *
 * On the wording: this used to say "do the task described below and nothing
 * beyond it", which is the right instruction for scope and the wrong one for
 * method. A bee is a tuned expert — it knows how to list a directory, read the
 * file a task names, call its tool twice. Told not to go beyond the task, a model
 * can read that as "do not go looking", and a task whose completion *requires*
 * looking then gets refused with a tidy explanation of what was missing. Scope
 * discipline is about not inventing extra deliverables, never about withholding
 * the work the deliverable needs. See DESIGN.md §7, "trust the tuned bee".
 */
export const STABLE_PROMPT_PREFIX = [
  "You are a worker bee in an AI agent hive. You execute exactly one task and return its result.",
  "",
  "How to work:",
  "- Deliver exactly what the task asks for — no extra deliverables, no adjacent work.",
  "- Getting there is yours to decide. Read the paths the task names, search, and call your tools as many times as the job needs.",
  "- Material given to you is a starting point, not a boundary. If the task names a source you have not been given, go to it.",
  "",
  "How to answer:",
  "- Return the result itself, not a description of how you would produce it.",
  "- No preamble, no restatement of the task, no closing summary.",
  "- Say a task cannot be completed only when you have tried and something is genuinely unavailable, and then name what it was.",
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
 * How much of each artifact is inlined into a prompt. Tunable because the
 * default is a cost choice, not a correctness one: an artifact whose decisive
 * detail sits past the cap makes its task unanswerable at *every* tier, so it
 * fails identically on all three attempts and looks like a capable-model
 * problem. Raising this is the correct response to that, which requires it to
 * be raisable.
 */
const ARTIFACT_BUDGET_CHARS = Number(process.env.HIVE_ARTIFACT_BUDGET_CHARS ?? 6000);

/** What `buildPrompt` had to leave out, so a caller can report it rather than guess. */
export interface PromptBuildInfo {
  prompt: string;
  /** artifacts clipped to the budget, with how much was dropped */
  truncated: Array<{ ref: string; keptChars: number; droppedChars: number }>;
  /** artifacts that could not be read at all */
  unavailable: string[];
}

/**
 * Token optimization level 3: assemble the smallest *sufficient* prompt.
 * Artifacts are passed by reference over the broker; here we inline a capped
 * slice of each.
 *
 * Ordering is load-bearing: stable content first, per-task content last. See
 * STABLE_PROMPT_PREFIX.
 */
export function buildPrompt(
  task: TaskMessage,
  readArtifact: (ref: string) => string,
  artifactBudgetChars = ARTIFACT_BUDGET_CHARS,
): string {
  return buildPromptWithInfo(task, readArtifact, artifactBudgetChars).prompt;
}

/**
 * `buildPrompt`, plus what it had to drop.
 *
 * Truncation used to be invisible — the prompt said "(may be truncated)" and
 * nothing recorded whether it actually was. That makes the one failure this cap
 * can cause unattributable: a task that fails at every tier because its evidence
 * was clipped looks exactly like a task that is simply too hard. The counts here
 * reach the episode log, so the difference is answerable from data.
 */
export function buildPromptWithInfo(
  task: TaskMessage,
  readArtifact: (ref: string) => string,
  artifactBudgetChars = ARTIFACT_BUDGET_CHARS,
): PromptBuildInfo {
  const parts = [STABLE_PROMPT_PREFIX, `Task: ${task.spec.title}`, task.spec.input];
  const truncated: PromptBuildInfo["truncated"] = [];
  const unavailable: string[] = [];

  if (task.escalation) {
    parts.push(`A previous attempt failed. Summary: ${task.escalation.failureSummary}`);
    // What the failed attempt actually produced, when the Queen parked it. Read
    // under the same budget as any other artifact: a retry that cannot see its
    // predecessor's work is free to repeat it, which is how an escalation ladder
    // gets spent converging on the same dead end.
    const ref = task.escalation.priorOutputRef;
    if (ref) {
      try {
        const full = readArtifact(ref);
        const content = full.slice(0, artifactBudgetChars);
        const dropped = full.length - content.length;
        if (dropped > 0) truncated.push({ ref, keptChars: content.length, droppedChars: dropped });
        parts.push(
          `--- what the previous attempt produced${dropped > 0 ? ` (truncated: ${dropped} chars omitted)` : ""} ---\n` +
            `${content}\n\nDo not simply repeat it. Treat it as evidence about what did not work.`,
        );
      } catch {
        unavailable.push(ref);
      }
    }
  }
  for (const ref of task.spec.artifacts) {
    try {
      const full = readArtifact(ref);
      const content = full.slice(0, artifactBudgetChars);
      const dropped = full.length - content.length;
      if (dropped > 0) {
        truncated.push({ ref, keptChars: content.length, droppedChars: dropped });
        parts.push(`--- artifact ${ref} (truncated: ${dropped} chars omitted) ---\n${content}`);
      } else {
        parts.push(`--- artifact ${ref} ---\n${content}`);
      }
    } catch {
      unavailable.push(ref);
      parts.push(`--- artifact ${ref} unavailable ---`);
    }
  }
  return { prompt: parts.join("\n\n"), truncated, unavailable };
}
