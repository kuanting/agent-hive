import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface ModelPrice {
  provider: string;
  id: string;
  /** USD per 1M tokens */
  input: number;
  cachedInput?: number;
  output: number;
}

interface CatalogFile {
  providers: Record<
    string,
    {
      models: Array<{
        id: string;
        pricing: Record<string, Record<string, unknown>>;
      }>;
    }
  >;
}

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

  /** rough chars/4 token estimate for pre-dispatch budgeting */
  static roughTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
