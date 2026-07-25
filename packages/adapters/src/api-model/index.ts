import { CostEstimator, type CapabilityRecord, type TaskMessage } from "@hive/shared";
import type { ExecResult, RuntimeAdapter } from "../types.js";
import { apiCapabilityReady, providerKey, resolveProvider, type ApiProvider } from "./providers.js";

const EXEC_TIMEOUT_MS = Number(process.env.HIVE_EXEC_TIMEOUT_MS ?? 300_000);
/**
 * Output cap for a single API call. Deliberately the same default the worker's
 * budget guard projects with (PROJECTED_OUTPUT_TOKENS), so the pre-flight cost
 * projection and the real bill agree instead of drifting apart.
 */
const MAX_OUTPUT_TOKENS = Number(process.env.HIVE_API_MAX_OUTPUT_TOKENS ?? 2000);
/** Plausible completion length reported in dry-run, so ledger movement stays realistic. */
const DRYRUN_OUTPUT_TOKENS = 800;

const dryRun = (): boolean => process.env.HIVE_API_DRYRUN === "1";

/**
 * Tier 2: paid models called directly over their provider HTTP APIs — the
 * metered bee. This is the only runtime that spends real money per call, which
 * is exactly why the Queen ranks it last (costRank 4) and dispatches it only for
 * urgent overflow, and why the worker re-checks the projected cost before
 * executing.
 *
 * We deliberately leave `reportedUsd` undefined: the provider APIs return real
 * token counts, and the worker prices those through CostEstimator against
 * llm_model_api_catalog.yaml. One pricing path for estimates and actuals.
 */
export class ApiModelAdapter implements RuntimeAdapter {
  runtimes = ["api"];

  async execute(_task: TaskMessage, cap: CapabilityRecord, prompt: string): Promise<ExecResult> {
    const model = cap.model;
    const ready = apiCapabilityReady(model);
    if (!ready.ok) return fail(`api capability unavailable: ${ready.reason}`, model);

    const provider = resolveProvider(model!)!;
    if (dryRun()) return stubResult(prompt, model!);

    try {
      switch (provider) {
        case "openai":
          return await this.viaOpenAI(prompt, model!);
        case "anthropic":
          return await this.viaAnthropic(prompt, model!);
        case "google":
          return await this.viaGoogle(prompt, model!);
      }
    } catch (err) {
      return fail(`${provider} api failed: ${String(err).slice(0, 300)}`, model);
    }
  }

  /** OpenAI chat completions. The gpt-5 / o-series families reject max_tokens. */
  private async viaOpenAI(prompt: string, model: string): Promise<ExecResult> {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: prompt }],
    };
    if (/^(gpt-5|o\d)/.test(model)) body.max_completion_tokens = MAX_OUTPUT_TOKENS;
    else body.max_tokens = MAX_OUTPUT_TOKENS;

    const data = await post<{
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>("https://api.openai.com/v1/chat/completions", {
      "content-type": "application/json",
      authorization: `Bearer ${providerKey("openai")}`,
    }, body, "openai");

    const output = data.choices?.[0]?.message?.content ?? "";
    return {
      ok: true,
      output,
      inputTokens: data.usage?.prompt_tokens ?? CostEstimator.roughTokens(prompt),
      outputTokens: data.usage?.completion_tokens ?? CostEstimator.roughTokens(output),
      runtimeUsed: "api:openai",
      modelUsed: model,
    };
  }

  /** Anthropic messages API. max_tokens is required, not optional. */
  private async viaAnthropic(prompt: string, model: string): Promise<ExecResult> {
    const data = await post<{
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>("https://api.anthropic.com/v1/messages", {
      "content-type": "application/json",
      "x-api-key": providerKey("anthropic")!,
      "anthropic-version": "2023-06-01",
    }, {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }],
    }, "anthropic");

    const output = (data.content ?? [])
      .filter((b) => b.type === "text" || typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");
    return {
      ok: true,
      output,
      inputTokens: data.usage?.input_tokens ?? CostEstimator.roughTokens(prompt),
      outputTokens: data.usage?.output_tokens ?? CostEstimator.roughTokens(output),
      runtimeUsed: "api:anthropic",
      modelUsed: model,
    };
  }

  /** Google Generative Language API. Model id goes in the path, key in a header. */
  private async viaGoogle(prompt: string, model: string): Promise<ExecResult> {
    const data = await post<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { "content-type": "application/json", "x-goog-api-key": providerKey("google")! },
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      },
      "google",
    );

    const output = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    return {
      ok: true,
      output,
      inputTokens: data.usageMetadata?.promptTokenCount ?? CostEstimator.roughTokens(prompt),
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? CostEstimator.roughTokens(output),
      runtimeUsed: "api:google",
      modelUsed: model,
    };
  }
}

async function post<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  provider: ApiProvider,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/**
 * HIVE_API_DRYRUN=1: skip the network but report realistic token counts, so the
 * ledger, the worker budget guard and the USD cap all behave exactly as they
 * would live. Lets the demo be re-run and recorded without spending.
 */
function stubResult(prompt: string, model: string): ExecResult {
  return {
    ok: true,
    output: `[dry-run] HIVE_API_DRYRUN=1, so ${model} was not called. Token usage below is simulated.`,
    inputTokens: CostEstimator.roughTokens(prompt),
    outputTokens: DRYRUN_OUTPUT_TOKENS,
    runtimeUsed: "api:dry-run",
    modelUsed: model,
  };
}

function fail(error: string, model?: string): ExecResult {
  return { ok: false, output: "", error, inputTokens: 0, outputTokens: 0, runtimeUsed: "api", modelUsed: model };
}
