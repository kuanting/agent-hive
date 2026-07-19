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
}

export interface RuntimeAdapter {
  /** runtimes this adapter can execute */
  runtimes: string[];
  execute(task: TaskMessage, capability: CapabilityRecord, prompt: string): Promise<ExecResult>;
}

/**
 * Token minimization level 3: assemble the smallest useful prompt.
 * Artifacts are passed by reference over the broker; here we inline only a
 * capped slice of each. Escalations carry the failure summary, never the
 * lower-tier transcript.
 */
export function buildPrompt(
  task: TaskMessage,
  readArtifact: (ref: string) => string,
  artifactBudgetChars = 6000,
): string {
  const parts = [`Task: ${task.spec.title}`, task.spec.input];
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
