import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface ModelPrice {
  provider: string;
  id: string;
  /** USD per 1M tokens */
  input: number;
  cachedInput?: number;
  output: number;
  /**
   * USD per 1000 grounded search queries, when this model has a search profile.
   *
   * Grounding is the one cost in the catalog that is not per token, which is
   * exactly why it needs its own field: pricing a search-heavy answer purely on
   * tokens under-reports the bill, and the ledger's whole job is to stop a
   * customer crossing a cap.
   */
  searchPer1000?: number;
}

interface CatalogFile {
  providers: Record<
    string,
    {
      search_profiles?: Record<string, { extra_costs?: Record<string, unknown> }>;
      models: Array<{
        id: string;
        pricing: Record<string, Record<string, unknown>>;
        search?: { profile?: string };
      }>;
    }
  >;
}

/**
 * Per-1000 search price out of a profile's `extra_costs`.
 *
 * Four spellings across the providers, because each bills a slightly different
 * unit — a grounded *prompt* (Gemini 2.5) versus a search *query* (Gemini 3),
 * and two more names elsewhere. They are close enough to charge alike and far
 * enough apart that only probing the known keys is honest, which is the same
 * thing `loadCatalog` already does for the token prices.
 *
 * `free_quota` is prose, not a number, so it is deliberately not modelled: the
 * estimate over-reports inside a provider's free tier. That is the safe
 * direction for a cap.
 */
const SEARCH_PRICE_KEYS = [
  "overage_usd_per_1000_search_queries",
  "overage_usd_per_1000_grounded_prompts",
  "web_search_calls_usd_per_1000",
  "web_searches_usd_per_1000",
];

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Loads llm_model_api_catalog.yaml and flattens each model's primary price block.
 * Providers store prices under different keys (standard.short_context, base,
 * flat input/output), so we probe the known shapes.
 */
export function loadCatalog(path: string): Map<string, ModelPrice> {
  const raw = parse(readFileSync(path, "utf8")) as CatalogFile;
  const prices = new Map<string, ModelPrice>();
  for (const [provider, def] of Object.entries(raw.providers ?? {})) {
    const searchPrice = (profile?: string): number | undefined => {
      const costs = profile ? def.search_profiles?.[profile]?.extra_costs : undefined;
      if (!costs) return undefined;
      for (const key of SEARCH_PRICE_KEYS) {
        const value = num(costs[key]);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    for (const model of def.models ?? []) {
      const block =
        (model.pricing?.standard as Record<string, unknown> | undefined) ??
        (model.pricing?.base as Record<string, unknown> | undefined);
      if (!block) continue;
      const short = (block as { short_context?: Record<string, unknown> }).short_context ?? block;
      const input = num(short.input) ?? num((block as Record<string, unknown>).input_le_200k) ?? num((block as Record<string, unknown>).input_text_image_video);
      const output = num(short.output) ?? num((block as Record<string, unknown>).output_le_200k) ?? num((block as Record<string, unknown>).output);
      if (input === undefined || output === undefined) continue;
      prices.set(model.id, {
        provider,
        id: model.id,
        input,
        cachedInput: num(short.cached_input),
        output,
        searchPer1000: searchPrice(model.search?.profile),
      });
    }
  }
  return prices;
}

export class CostEstimator {
  constructor(private prices: Map<string, ModelPrice>) {}

  has(modelId: string): boolean {
    return this.prices.get(modelId) !== undefined;
  }

  /**
   * USD for a call. Unknown models (local Ollama, subscription-metered seats)
   * cost 0 marginal USD by design.
   */
  estimate(modelId: string, inputTokens: number, outputTokens: number, cachedInputTokens = 0): number {
    const p = this.prices.get(modelId);
    if (!p) return 0;
    const cachedRate = p.cachedInput ?? p.input;
    const freshInput = Math.max(0, inputTokens - cachedInputTokens);
    return (
      (freshInput * p.input + cachedInputTokens * cachedRate + outputTokens * p.output) / 1_000_000
    );
  }

  /**
   * USD for grounded search queries. Zero for a model with no search profile,
   * which is also the honest answer for one that never searched.
   *
   * Separate from `estimate` rather than folded into it because the unit is
   * different — queries, not tokens — and a caller that reports one without the
   * other should be visibly making that choice.
   */
  estimateSearch(modelId: string, queries: number): number {
    const per1000 = this.prices.get(modelId)?.searchPer1000;
    if (!per1000 || queries <= 0) return 0;
    return (queries * per1000) / 1000;
  }

  /** rough chars/4 token estimate for pre-dispatch budgeting */
  static roughTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
