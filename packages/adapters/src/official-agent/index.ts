import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    // Codex is deliberately left cold. Its session flags are not verified here
    // (see the note on viaCodex about its event shapes), and guessing at a resume
    // flag would trade a known cold start for an unknown failure mode. Claude
    // Code only until someone can test the codex path against a real install.
    if (cap.runtime === "codex") return this.viaCodex(prompt, cap);
    return this.viaClaudeCode(prompt, cap, task.resumeSession);
  }

  /**
   * Claude Code, headless.
   *
   * Two things about the session, because they are easy to conflate. The prompt
   * cache is server-side and outlives the process, so exiting the CLI does not
   * throw it away — what a cold `-p` throws away is the *session*, the thing that
   * would reproduce the same prefix and hit that cache. So we name the session
   * ourselves with `--session-id` and hand the id back to the Queen; a follow-up
   * arrives with `resumeSession` and continues it via `--resume`.
   *
   * We generate the uuid rather than only reading `session_id` off the response:
   * the id is then known even if the JSON shape changes, and the flag requires a
   * valid uuid, which `randomUUID` gives us. The echoed value still wins when
   * present, since the CLI is the authority on what it actually used.
   */
  private async viaClaudeCode(prompt: string, cap: CapabilityRecord, resume?: string): Promise<ExecResult> {
    const sessionId = randomUUID();
    const args = ["-p", prompt, "--output-format", "json", "--max-turns", "12"];
    // --resume names an existing session; --session-id names a new one. Passing
    // both is contradictory, so a resume run reuses the id it was given.
    if (resume) args.push("--resume", resume);
    else args.push("--session-id", sessionId);
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
        session_id?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      const cacheWrite = data.usage?.cache_creation_input_tokens ?? 0;
      const cacheRead = data.usage?.cache_read_input_tokens ?? 0;
      return {
        ok: !data.is_error,
        output: data.result ?? "",
        error: data.is_error ? "claude-code reported error" : undefined,
        // `input_tokens` here is the UNCACHED REMAINDER, not the prompt size, and
        // on this runtime the gap is enormous rather than marginal: a measured
        // resumed turn reported input_tokens: 2 against cache_read: 35202. Summing
        // is not bookkeeping pedantry — on a subscription seat the Queen meters
        // the quota window on inputTokens + outputTokens, so reporting the
        // remainder made a seat that had consumed 35k tokens look like it had
        // consumed two, and the window would read as empty until it abruptly
        // wasn't. Marginal USD is still 0 on a seat; what is being counted here is
        // quota, which is the currency that actually runs out.
        inputTokens: (data.usage?.input_tokens ?? 0) + cacheWrite + cacheRead,
        outputTokens: data.usage?.output_tokens ?? 0,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        // subscription seats have no marginal USD; API-billed seats report real cost
        reportedUsd: cap.billing === "subscription" ? 0 : data.total_cost_usd,
        runtimeUsed: "claude-code",
        modelUsed: cap.model,
        sessionRef: data.session_id ?? resume ?? sessionId,
      };
    } catch (err) {
      // A resume that fails is not a failed task: the session may have been
      // pruned, or belong to another working directory. Fall back to one cold
      // run before giving up, the same posture the ollama adapter takes toward a
      // missing binary — affinity is an optimization and must never cost a task.
      if (resume) {
        return this.viaClaudeCode(prompt, cap);
      }
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
