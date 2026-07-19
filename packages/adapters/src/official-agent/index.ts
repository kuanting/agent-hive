import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapabilityRecord, TaskMessage } from "@hive/shared";
import type { ExecResult, RuntimeAdapter } from "../types.js";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = Number(process.env.HIVE_EXEC_TIMEOUT_MS ?? 300_000);

/**
 * Tier 1: official agents on frontier models.
 * Claude Code runs headless (`claude -p --output-format json`) and reports real
 * token usage and cost. On a subscription seat the marginal USD is 0; tokens
 * still count against the seat's quota window, which the worker reports so the
 * Queen can meter the seat.
 */
export class OfficialAgentAdapter implements RuntimeAdapter {
  runtimes = ["claude-code", "codex"];

  async execute(task: TaskMessage, cap: CapabilityRecord, prompt: string): Promise<ExecResult> {
    if (cap.runtime === "codex") {
      // Roadmap stub: same interface, not yet wired to a Codex seat.
      return {
        ok: false,
        output: "",
        error: "codex adapter not implemented (roadmap stub)",
        inputTokens: 0,
        outputTokens: 0,
        runtimeUsed: "codex",
      };
    }
    return this.viaClaudeCode(prompt, cap);
  }

  private async viaClaudeCode(prompt: string, cap: CapabilityRecord): Promise<ExecResult> {
    const args = ["-p", prompt, "--output-format", "json", "--max-turns", "12"];
    if (cap.model) args.push("--model", cap.model);
    try {
      const { stdout } = await execFileAsync("claude", args, {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      const data = JSON.parse(stdout) as {
        result?: string;
        is_error?: boolean;
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      return {
        ok: !data.is_error,
        output: data.result ?? "",
        error: data.is_error ? "claude-code reported error" : undefined,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        // subscription seats have no marginal USD; API-billed seats report real cost
        reportedUsd: cap.billing === "subscription" ? 0 : data.total_cost_usd,
        runtimeUsed: "claude-code",
        modelUsed: cap.model,
      };
    } catch (err) {
      return {
        ok: false,
        output: "",
        error: `claude-code failed: ${String(err).slice(0, 300)}`,
        inputTokens: 0,
        outputTokens: 0,
        runtimeUsed: "claude-code",
        modelUsed: cap.model,
      };
    }
  }
}
