/**
 * Provider resolution for the `api` runtime (the metered bee).
 *
 * Model ids are the same strings used in llm_model_api_catalog.yaml, so a
 * capability's `model` field both selects the endpoint here and prices the call
 * through CostEstimator. Keep the two in sync: a model id the catalog doesn't
 * know prices at $0, which would silently make a paid call look free.
 */

export type ApiProvider = "openai" | "anthropic" | "google";

/** Env vars checked per provider, in order. First one set wins. */
export const PROVIDER_KEY_ENV: Record<ApiProvider, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

/** Which provider serves a model id, or undefined if we can't tell. */
export function resolveProvider(modelId: string): ApiProvider | undefined {
  if (/^(gpt-|o\d)/.test(modelId)) return "openai";
  if (/^claude-/.test(modelId)) return "anthropic";
  if (/^gemini-/.test(modelId)) return "google";
  return undefined;
}

/** The configured key for a provider, or undefined when none of its env vars are set. */
export function providerKey(provider: ApiProvider): string | undefined {
  for (const name of PROVIDER_KEY_ENV[provider]) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Whether an `api` capability can actually execute on this host: the model id
 * must map to a known provider and that provider's key must be present. Used by
 * the adapter and by the worker's capability preflight.
 */
export function apiCapabilityReady(modelId: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (!modelId) return { ok: false, reason: "no model id on the capability record" };
  const provider = resolveProvider(modelId);
  if (!provider) return { ok: false, reason: `no known API provider for model '${modelId}'` };
  if (!providerKey(provider)) {
    return { ok: false, reason: `${PROVIDER_KEY_ENV[provider].join(" or ")} not set` };
  }
  return { ok: true };
}
