import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CostEstimator, type CapabilityRecord, type TaskMessage } from "@hive/shared";
import { hermesArgs, hermesCmd } from "../hermes.js";
import type { ExecResult, RuntimeAdapter } from "../types.js";

const execFileAsync = promisify(execFile);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OPENCLAW_URL = process.env.OPENCLAW_URL ?? "http://localhost:18789";
const EXEC_TIMEOUT_MS = Number(process.env.HIVE_EXEC_TIMEOUT_MS ?? 300_000);

/**
 * Tiers 2 and 3: open-source agents on Ollama-served models.
 * Provisioning belongs to Ollama (`ollama launch opencode|openclaw`); this
 * adapter only executes non-interactively through each runtime's interface.
 * If a runtime is not installed, it falls back to a direct Ollama chat call so
 * a bare Ollama host can still serve tier 3 (result is marked ollama-direct).
 *
 * `runtime: ollama` asks for that same direct call deliberately, and reports as
 * `ollama`. The distinction is worth keeping: `ollama` is a host that harnessed
 * no agent, `ollama-direct` is a host that meant to and the binary was missing.
 */
export class OllamaAgentAdapter implements RuntimeAdapter {
  runtimes = ["opencode", "openclaw", "hermes", "ollama"];

  async execute(task: TaskMessage, cap: CapabilityRecord, prompt: string): Promise<ExecResult> {
    const model = cap.model ?? "qwen3.5:4b";
    try {
      switch (cap.runtime) {
        case "opencode":
          return await this.viaOpenCode(prompt, model);
        case "openclaw":
          return await this.viaOpenClaw(prompt, model);
        case "hermes":
          return await this.viaHermes(prompt, model);
        case "ollama":
          // Asked for by name, so it reports as `ollama` — a deliberate choice,
          // not the `ollama-direct` degradation below, which means an agent was
          // expected and missing. Same call, different thing to know.
          return await this.viaOllamaDirect(prompt, model, "ollama");
        default:
          throw new Error(`unsupported runtime ${cap.runtime}`);
      }
    } catch (err) {
      // Runtime missing or broken: degrade to a raw Ollama chat call.
      try {
        const fallback = await this.viaOllamaDirect(prompt, model);
        fallback.output = `${fallback.output}\n\n[note: ${cap.runtime} unavailable (${trim(err)}), executed via ollama-direct]`;
        return fallback;
      } catch (inner) {
        return fail(`${cap.runtime} failed: ${trim(err)}; ollama-direct failed: ${trim(inner)}`, cap.runtime, model);
      }
    }
  }

  /** OpenCode: non-interactive `opencode run`, model addressed as ollama/<model>. */
  private async viaOpenCode(prompt: string, model: string): Promise<ExecResult> {
    const { stdout } = await execFileAsync(
      "opencode",
      ["run", prompt, "--model", `ollama/${model}`],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    return roughUsage(prompt, stdout.trim(), "opencode", model);
  }

  /** OpenClaw: local gateway HTTP (OpenAI-compatible chat surface). */
  private async viaOpenClaw(prompt: string, model: string): Promise<ExecResult> {
    const res = await fetch(`${OPENCLAW_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`openclaw gateway ${res.status}`);
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const output = data.choices?.[0]?.message?.content ?? "";
    return {
      ok: true,
      output,
      inputTokens: data.usage?.prompt_tokens ?? CostEstimator.roughTokens(prompt),
      outputTokens: data.usage?.completion_tokens ?? CostEstimator.roughTokens(output),
      runtimeUsed: "openclaw",
      modelUsed: model,
    };
  }

  /** Hermes: non-interactive CLI (configurable), same Ollama backend. */
  private async viaHermes(prompt: string, model: string): Promise<ExecResult> {
    const { stdout } = await execFileAsync(hermesCmd(), hermesArgs(prompt, model), {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = stdout.trim();
    // Quiet mode prints the answer alone, so nothing on stdout means nothing to
    // report — treat it as a failed run and let ollama-direct answer instead.
    if (!output) throw new Error("hermes produced no output");
    return roughUsage(prompt, output, "hermes", model);
  }

  private async viaOllamaDirect(prompt: string, model: string, label = "ollama-direct"): Promise<ExecResult> {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
      signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      ok: true,
      output: data.message?.content ?? "",
      inputTokens: data.prompt_eval_count ?? CostEstimator.roughTokens(prompt),
      outputTokens: data.eval_count ?? 0,
      runtimeUsed: label,
      modelUsed: model,
    };
  }
}

function roughUsage(prompt: string, output: string, runtime: string, model: string): ExecResult {
  return {
    ok: true,
    output,
    inputTokens: CostEstimator.roughTokens(prompt),
    outputTokens: CostEstimator.roughTokens(output),
    runtimeUsed: runtime,
    modelUsed: model,
  };
}

function fail(error: string, runtime: string, model: string): ExecResult {
  return { ok: false, output: "", error, inputTokens: 0, outputTokens: 0, runtimeUsed: runtime, modelUsed: model };
}

function trim(err: unknown): string {
  return String(err).slice(0, 200);
}
