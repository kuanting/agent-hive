import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CostEstimator, type CapabilityRecord, type Passthrough, type TaskMessage, type ToolCall } from "@hive/shared";
import { hermesArgs, hermesCmd, splitHermesOutput } from "../hermes.js";
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
    // A turn in someone else's agent loop has to go straight to the model. The
    // agent harnesses above (`opencode run`, the Hermes CLI) each run their OWN
    // loop with their own tools and hand back finished prose — there is no way
    // to ask them "which of THESE tools would you call". So passthrough takes
    // the direct chat path regardless of which agent the record names, and says
    // so in `runtimeUsed` rather than pretending the harness was used.
    if (task.passthrough) {
      return await this.viaOllamaDirect(prompt, model, "ollama-chat", task.passthrough);
    }
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
    const { stdout, stderr } = await execFileAsync(hermesCmd(), hermesArgs(prompt, model), {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    // Quiet mode does not keep stdout to the answer alone; see splitHermesOutput.
    const { answer, diagnostics } = splitHermesOutput(stdout, stderr);
    // Nothing left after separating the chatter means nothing to report — treat
    // it as a failed run and let ollama-direct answer instead.
    if (!answer) {
      throw new Error(`hermes produced no answer${diagnostics.length ? `: ${diagnostics.join(" / ")}` : ""}`);
    }
    const res = roughUsage(prompt, answer, "hermes", model);
    if (diagnostics.length) res.diagnostics = diagnostics;
    return res;
  }

  private async viaOllamaDirect(
    prompt: string,
    model: string,
    label = "ollama-direct",
    passthrough?: Passthrough,
  ): Promise<ExecResult> {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: passthrough
          ? passthrough.messages.map((m) => ({
              role: m.role,
              content: m.content,
              // Ollama wants `arguments` as an OBJECT; OpenAI carries it as a
              // JSON string, and that is the shape callers send. Forwarding the
              // string verbatim is not a harmless type difference: the model
              // reads its own previous turn as malformed, decides the tool was
              // never really called, and calls it again — so a two-turn loop
              // never terminates and the answer never arrives.
              ...(m.tool_calls
                ? {
                    tool_calls: m.tool_calls.map((c) => ({
                      function: { name: c.function.name, arguments: parseArgs(c.function.arguments) },
                    })),
                  }
                : {}),
              ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            }))
          : [{ role: "user", content: prompt }],
        ...(passthrough?.tools.length ? { tools: passthrough.tools } : {}),
        ...(passthrough?.temperature !== undefined || passthrough?.maxOutputTokens !== undefined
          ? {
              options: {
                ...(passthrough.temperature !== undefined ? { temperature: passthrough.temperature } : {}),
                ...(passthrough.maxOutputTokens !== undefined ? { num_predict: passthrough.maxOutputTokens } : {}),
              },
            }
          : {}),
        stream: false,
      }),
      signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as {
      message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const output = data.message?.content ?? "";
    // Ollama returns arguments already parsed; callers expect OpenAI's JSON
    // string, and it does not mint call ids at all.
    const toolCalls: ToolCall[] = (data.message?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c, i) => ({
        id: `call_${i}`,
        type: "function" as const,
        function: { name: c.function!.name!, arguments: JSON.stringify(c.function!.arguments ?? {}) },
      }));
    return {
      ok: true,
      output,
      ...(toolCalls.length ? { toolCalls, finishReason: "tool_calls" as const } : {}),
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

/**
 * A tool call's arguments as an object. A model that emitted malformed JSON is
 * the caller's problem to see rather than ours to hide behind a failed request,
 * so this degrades to an empty object instead of throwing.
 */
function parseArgs(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function trim(err: unknown): string {
  return String(err).slice(0, 200);
}
