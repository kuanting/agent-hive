import { CostEstimator, type CapabilityRecord, type ChatTurn, type TaskMessage, type ToolCall, type ToolDefinition } from "@hive/shared";
import { splitStablePrefix, type ExecResult, type RuntimeAdapter } from "../types.js";
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
  /** reads task.passthrough directly, so it wants no assembled prompt */
  consumesPassthrough = true;

  async execute(task: TaskMessage, cap: CapabilityRecord, prompt: string): Promise<ExecResult> {
    const model = cap.model;
    const ready = apiCapabilityReady(model);
    if (!ready.ok) return fail(`api capability unavailable: ${ready.reason}`, model);

    const provider = resolveProvider(model!)!;
    if (dryRun()) return stubResult(prompt, model!);

    // Two shapes, one adapter. A task is the hive's own prompt, assembled from a
    // stable prefix and per-task text; a passthrough turn is somebody else's
    // conversation, which the hive must not rewrite. Deciding here keeps every
    // provider method below reading from the same normalized `Turn[]`.
    const turns = task.passthrough
      ? task.passthrough.messages.map(toTurn)
      : taskTurns(prompt);
    const opts: CallOptions = {
      tools: task.passthrough?.tools ?? [],
      toolChoice: task.passthrough?.toolChoice,
      temperature: task.passthrough?.temperature,
      maxOutputTokens: task.passthrough?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      search: cap.search === true,
    };

    try {
      switch (provider) {
        case "openai":
          return await this.viaOpenAI(turns, model!, opts);
        case "anthropic":
          return await this.viaAnthropic(turns, model!, opts);
        case "google":
          return await this.viaGoogle(turns, model!, opts);
      }
    } catch (err) {
      return fail(`${provider} api failed: ${String(err).slice(0, 300)}`, model);
    }
  }

  /** OpenAI chat completions. The gpt-5 / o-series families reject max_tokens. */
  private async viaOpenAI(turns: Turn[], model: string, opts: CallOptions): Promise<ExecResult> {
    const body: Record<string, unknown> = {
      model,
      messages: turns.map((t) => ({
        role: t.role,
        content: t.content,
        ...(t.toolCalls ? { tool_calls: t.toolCalls } : {}),
        ...(t.toolCallId ? { tool_call_id: t.toolCallId } : {}),
      })),
      ...(opts.tools.length ? { tools: opts.tools } : {}),
      ...(opts.tools.length && opts.toolChoice !== undefined ? { tool_choice: opts.toolChoice } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
    if (/^(gpt-5|o\d)/.test(model)) body.max_completion_tokens = opts.maxOutputTokens;
    else body.max_tokens = opts.maxOutputTokens;

    const data = await post<{
      choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>("https://api.openai.com/v1/chat/completions", {
      "content-type": "application/json",
      authorization: `Bearer ${providerKey("openai")}`,
    }, body, "openai");

    const choice = data.choices?.[0];
    const output = choice?.message?.content ?? "";
    const toolCalls = choice?.message?.tool_calls;
    return {
      ok: true,
      output,
      ...(toolCalls?.length ? { toolCalls } : {}),
      finishReason: normalizeFinish(choice?.finish_reason),
      inputTokens: data.usage?.prompt_tokens ?? CostEstimator.roughTokens(joinTurns(turns)),
      outputTokens: data.usage?.completion_tokens ?? CostEstimator.roughTokens(output),
      runtimeUsed: "api:openai",
      modelUsed: model,
    };
  }

  /**
   * Anthropic messages API. max_tokens is required, not optional.
   *
   * `cache_control` on the system block asks for the stable prefix to be cached
   * (cached input reads at roughly a tenth of the base rate, which is what makes
   * level 4 of the ladder worth anything). Two things to know before reading a
   * zero here as a bug:
   *
   * 1. The minimum cacheable prefix is model-dependent and a shorter prefix is
   *    ignored *silently* — 1024 tokens on Sonnet 4.6, 4096 on Haiku 4.5, which
   *    is the Anthropic model this hive's metered bee is configured with. The
   *    stable block is nowhere near 4096 tokens, so on today's configuration this
   *    marker is expected to do nothing at all. It is here so that the day the
   *    block grows — a real operator preamble, a shared tool manual — the
   *    plumbing is already correct, and so the counts below can say which case
   *    we are in instead of leaving it to guesswork.
   * 2. `usage.input_tokens` from this API is the *uncached remainder*, not the
   *    prompt size. See the note on the return value.
   */
  private async viaAnthropic(turns: Turn[], model: string, opts: CallOptions): Promise<ExecResult> {
    // Anthropic keeps the system prompt out of the message list entirely, so the
    // system turns are lifted rather than mapped.
    const system = turns.filter((t) => t.role === "system").map((t) => t.content).join("\n\n");
    const data = await post<{
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    }>("https://api.anthropic.com/v1/messages", {
      "content-type": "application/json",
      "x-api-key": providerKey("anthropic")!,
      "anthropic-version": "2023-06-01",
    }, {
      model,
      max_tokens: opts.maxOutputTokens,
      ...(system
        ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] }
        : {}),
      messages: turns.filter((t) => t.role !== "system").map(toAnthropicTurn),
      ...(opts.tools.length
        ? {
            tools: opts.tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              // Anthropic's name for the same JSON Schema. An absent schema is
              // still a valid tool, so it gets the empty object rather than
              // being dropped.
              input_schema: t.function.parameters ?? { type: "object", properties: {} },
            })),
          }
        : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }, "anthropic");

    const blocks = data.content ?? [];
    const output = blocks
      .filter((b) => b.type === "text" || (b.type === undefined && typeof b.text === "string"))
      .map((b) => b.text ?? "")
      .join("");
    // Anthropic returns tool arguments as a parsed object; OpenAI returns them
    // as a JSON string, and that is the shape the caller is expecting back.
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.type === "tool_use" && b.name)
      .map((b) => ({
        id: b.id ?? "",
        type: "function" as const,
        function: { name: b.name!, arguments: JSON.stringify(b.input ?? {}) },
      }));
    const cacheWrite = data.usage?.cache_creation_input_tokens ?? 0;
    const cacheRead = data.usage?.cache_read_input_tokens ?? 0;
    return {
      ok: true,
      output,
      ...(toolCalls.length ? { toolCalls } : {}),
      finishReason: normalizeFinish(data.stop_reason),
      // Cached tokens are added back in, because `input_tokens` alone is the
      // uncached remainder: total prompt = input + cache_creation + cache_read.
      // Reporting the remainder would make the hive's headline metric — cost per
      // completed task — quietly stop matching the bill the moment a cache ever
      // hits. Pricing them at the full input rate over-states a cache read
      // (really ~0.1x) and under-states a write (~1.25x), which errs toward
      // reporting *more* spend than occurred. That is the safe direction for a
      // ledger whose job is to stop a customer exceeding a cap; the exact rates
      // need a catalog that can express them, which is a separate change.
      inputTokens: (data.usage?.input_tokens ?? CostEstimator.roughTokens(joinTurns(turns))) + cacheWrite + cacheRead,
      outputTokens: data.usage?.output_tokens ?? CostEstimator.roughTokens(output),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      runtimeUsed: "api:anthropic",
      modelUsed: model,
    };
  }

  /**
   * Google Generative Language API. Model id goes in the path, key in a header.
   *
   * This is the one provider that can also *search*. `cap.search` opts a
   * capability into Google Search grounding, which is what makes a literature
   * question answerable with real papers instead of plausible ones. Grounding
   * bills per query rather than per token, so the query count comes back as a
   * count and the worker prices it — the same division of labour as the cache
   * counters.
   */
  private async viaGoogle(turns: Turn[], model: string, opts: CallOptions): Promise<ExecResult> {
    const system = turns.filter((t) => t.role === "system").map((t) => t.content).join("\n\n");
    const data = await post<{
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> };
        finishReason?: string;
        groundingMetadata?: {
          webSearchQueries?: string[];
          groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
        };
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { "content-type": "application/json", "x-goog-api-key": providerKey("google")! },
      {
        contents: turns.filter((t) => t.role !== "system").map(toGoogleTurn),
        // Google's name for the same field; no cache marker, since its implicit
        // caching is not something a request opts into.
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        // Grounding and caller tools are mutually exclusive in this API: one
        // `tools` field, and mixing a retrieval tool with function declarations
        // is rejected. Caller tools win, because a caller mid-loop is waiting
        // for a decision about ITS tools and would otherwise get prose back.
        ...(opts.tools.length
          ? {
              tools: [
                {
                  functionDeclarations: opts.tools.map((t) => ({
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters,
                  })),
                },
              ],
            }
          : opts.search
            ? { tools: [{ google_search: {} }] }
            : {}),
        generationConfig: {
          maxOutputTokens: opts.maxOutputTokens,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        },
      },
      "google",
    );

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    let output = parts.map((p) => p.text ?? "").join("");
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall?.name)
      .map((p, i) => ({
        // Google does not mint call ids; the caller needs one to match its tool
        // result back, so synthesize a stable per-response id.
        id: `call_${i}`,
        type: "function" as const,
        function: { name: p.functionCall!.name!, arguments: JSON.stringify(p.functionCall!.args ?? {}) },
      }));

    // Citations are the point of grounding: an answer that searched but cannot
    // say where it looked is no more checkable than one that did not.
    const sources = (candidate?.groundingMetadata?.groundingChunks ?? [])
      .map((c) => c.web)
      .filter((w): w is { uri?: string; title?: string } => !!w?.uri)
      .map((w) => `- ${w.title ?? w.uri}: ${w.uri}`);
    if (sources.length) output += `\n\nSources:\n${[...new Set(sources)].join("\n")}`;

    const searchQueries = candidate?.groundingMetadata?.webSearchQueries?.length ?? 0;
    const diagnostics: string[] = [];
    if (opts.search && !opts.tools.length && searchQueries === 0) {
      // Asked to ground and did not: the answer came from the weights. Worth
      // saying out loud, because it looks identical to one that searched.
      diagnostics.push("grounding requested but the provider ran no search queries");
    }

    return {
      ok: true,
      output,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
      ...(opts.search ? { searchQueries } : {}),
      finishReason: normalizeFinish(candidate?.finishReason),
      inputTokens: data.usageMetadata?.promptTokenCount ?? CostEstimator.roughTokens(joinTurns(turns)),
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? CostEstimator.roughTokens(output),
      runtimeUsed: "api:google",
      modelUsed: model,
    };
  }
}

/** A provider-neutral turn. Every provider method below maps from this, never from a prompt string. */
interface Turn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

interface CallOptions {
  tools: ToolDefinition[];
  toolChoice?: unknown;
  temperature?: number;
  maxOutputTokens: number;
  search: boolean;
}

const toTurn = (m: ChatTurn): Turn => ({
  role: m.role,
  content: m.content,
  toolCalls: m.tool_calls,
  toolCallId: m.tool_call_id,
});

/**
 * The hive's own assembled prompt, as turns: the stable prefix becomes the
 * system turn (where a cache breakpoint can cover it) and the per-task text
 * becomes the user turn.
 */
function taskTurns(prompt: string): Turn[] {
  const { system, body } = splitStablePrefix(prompt);
  return [...(system ? [{ role: "system" as const, content: system }] : []), { role: "user" as const, content: body }];
}

const joinTurns = (turns: Turn[]): string => turns.map((t) => t.content).join("\n");

/** Anthropic has no `tool` role: a tool result is a user turn carrying a tool_result block. */
function toAnthropicTurn(t: Turn): Record<string, unknown> {
  if (t.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: t.toolCallId, content: t.content }],
    };
  }
  if (t.toolCalls?.length) {
    return {
      role: "assistant",
      content: [
        ...(t.content ? [{ type: "text", text: t.content }] : []),
        ...t.toolCalls.map((c) => ({
          type: "tool_use",
          id: c.id,
          name: c.function.name,
          input: safeParse(c.function.arguments),
        })),
      ],
    };
  }
  return { role: t.role, content: t.content };
}

/** Google calls the assistant "model", and a tool result is a functionResponse part. */
function toGoogleTurn(t: Turn): Record<string, unknown> {
  if (t.role === "tool") {
    return { role: "user", parts: [{ functionResponse: { name: t.toolCallId, response: { content: t.content } } }] };
  }
  if (t.toolCalls?.length) {
    return {
      role: "model",
      parts: t.toolCalls.map((c) => ({ functionCall: { name: c.function.name, args: safeParse(c.function.arguments) } })),
    };
  }
  return { role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    // A model that emitted malformed arguments is the caller's problem to see,
    // not ours to hide behind a thrown request.
    return {};
  }
}

/** Every provider spells this differently; callers only understand OpenAI's four. */
function normalizeFinish(raw?: string): ExecResult["finishReason"] {
  switch (raw) {
    case "tool_calls":
    case "tool_use":
      return "tool_calls";
    case "length":
    case "max_tokens":
    case "MAX_TOKENS":
      return "length";
    case "content_filter":
    case "SAFETY":
      return "content_filter";
    case undefined:
      return undefined;
    default:
      return "stop";
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
