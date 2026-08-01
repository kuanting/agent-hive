/**
 * The hive, spoken to exactly the way a third-party benchmark speaks to it.
 *
 * Deliberately a plain `fetch` against `/v1` rather than an in-process call to
 * `QueenCore`. The point of a benchmark run is to measure the thing the outside
 * world touches, including the routing, the refusals and the serialization —
 * calling the core directly would measure a system nobody uses.
 */

export interface HiveMeta {
  task_id: string;
  tier: number;
  agent: string;
  runtime: string;
  model?: string;
  billing: string;
  cost_usd: number;
  degraded: boolean;
  duration_ms: number;
  /** present when the hive declined rather than answered */
  refused?: string;
}

export interface Completion {
  content: string;
  finishReason: string;
  toolCalls?: unknown[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  hive?: HiveMeta;
  /** transport or protocol failure, as opposed to a hive refusal (which is a normal 200) */
  error?: string;
  wallMs: number;
}

export interface ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class HiveClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "http://localhost:4100/v1").replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    // Generously above the hive's own 5-minute adapter cap: a client timeout
    // shorter than the work it is waiting on measures the timeout, not the hive.
    this.timeoutMs = opts.timeoutMs ?? 600_000;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  /** The fleet as the hive is serving it right now — the roster a run record pins. */
  async models(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) throw new Error(`GET /models -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  }

  async complete(body: Record<string, unknown>): Promise<Completion> {
    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const wallMs = Date.now() - started;
      const text = await res.text();
      if (!res.ok) {
        // A 4xx here is the hive declining before dispatch — an unknown model, or
        // tools asked of a bee that cannot serve them. Recorded as an outcome
        // rather than thrown: refusing is a measurable behaviour, not a crash.
        return {
          content: "",
          finishReason: "error",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          error: `${res.status}: ${text.slice(0, 400)}`,
          wallMs,
        };
      }
      const data = JSON.parse(text) as {
        choices: Array<{ message: { content: string; tool_calls?: unknown[] }; finish_reason: string }>;
        usage: Completion["usage"];
        x_hive?: HiveMeta;
      };
      const choice = data.choices?.[0];
      return {
        content: choice?.message?.content ?? "",
        finishReason: choice?.finish_reason ?? "unknown",
        toolCalls: choice?.message?.tool_calls,
        usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        hive: data.x_hive,
        wallMs,
      };
    } catch (err) {
      return {
        content: "",
        finishReason: "error",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        error: String(err).slice(0, 400),
        wallMs: Date.now() - started,
      };
    }
  }
}
