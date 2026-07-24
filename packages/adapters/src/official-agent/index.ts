import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapabilityRecord, TaskMessage } from "@hive/shared";
import type { ExecResult, RuntimeAdapter } from "../types.js";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = Number(process.env.HIVE_EXEC_TIMEOUT_MS ?? 300_000);

/**
 * Tier 1: official agents on frontier models — Claude Code and Codex.
 * Both run headless and report token usage. On a subscription seat (Claude Max,
 * ChatGPT Pro/Plus) the marginal USD is 0; tokens still count against the seat's
 * quota window, which the worker reports so the Queen can meter the seat.
 */
export class OfficialAgentAdapter implements RuntimeAdapter {
  runtimes = ["claude-code", "codex"];

  async execute(task: TaskMessage, cap: CapabilityRecord, prompt: string): Promise<ExecResult> {
    if (cap.runtime === "codex") return this.viaCodex(prompt, cap);
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

  /**
   * Codex CLI, headless: `codex exec --json` streams JSONL events; the final
   * agent message is the last message event and a `turn.completed` event carries
   * token usage. On a subscription seat (ChatGPT Pro/Plus) marginal USD is 0; for
   * per-token billing Codex reports no cost, so we leave reportedUsd undefined and
   * let the worker's CostEstimator price it from tokens (same as the ollama path).
   *
   * NOTE: confirm the exact event/field names against your installed codex version
   * (`codex exec --help`); the parser is defensive across message shapes.
   */
  private async viaCodex(prompt: string, cap: CapabilityRecord): Promise<ExecResult> {
    const args = ["exec", "--json"];
    if (cap.model) args.push("--model", cap.model);
    args.push(prompt);
    try {
      const { stdout } = await execFileAsync("codex", args, {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      let output = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let failed = false;
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt: Record<string, any>;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue; // ignore any non-JSON lines
        }
        const type = String(evt.type ?? "");
        if (type === "turn.completed" && evt.usage) {
          inputTokens = Number(evt.usage.input_tokens ?? 0);
          outputTokens = Number(evt.usage.output_tokens ?? 0);
        } else if (type === "error" || type.includes("fail")) {
          failed = true;
        } else {
          // keep the latest complete agent message across possible shapes
          const text = evt.text ?? evt.message ?? evt.item?.text ?? evt.item?.message;
          if (typeof text === "string" && text.length > 0) output = text;
        }
      }
      return {
        ok: !failed,
        output,
        error: failed ? "codex reported error" : undefined,
        inputTokens,
        outputTokens,
        reportedUsd: cap.billing === "subscription" ? 0 : undefined,
        runtimeUsed: "codex",
        modelUsed: cap.model,
      };
    } catch (err) {
      return {
        ok: false,
        output: "",
        error: `codex failed: ${String(err).slice(0, 300)}`,
        inputTokens: 0,
        outputTokens: 0,
        runtimeUsed: "codex",
        modelUsed: cap.model,
      };
    }
  }
}
