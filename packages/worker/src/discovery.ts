import { apiCapabilityReady, hermesCmd, hermesOnPath, openclawUp } from "@hive/adapters";
import type { HostInventory, HostModel } from "@hive/shared";
import { onPath } from "./preflight.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

/**
 * Take stock of what this machine could run. Reports, never registers.
 *
 * This replaced an auto-discovery step that turned every installed Ollama model
 * into an advertised capability. That was the wrong default twice over: it
 * stamped one configured runtime onto every model, so a host with seven models
 * and no opencode advertised seven opencode capabilities it could not serve; and
 * it meant `ollama pull` silently changed what the hive promised its customers.
 * A hive manages agents an operator harnessed, so the operator declares them and
 * this only says what raw material is lying around.
 *
 * Everything here is probed with the same helpers preflight uses, so the Setup
 * view and the drop reasons can never disagree about what is installed.
 */
export async function probeHost(): Promise<HostInventory> {
  const [[models, ollamaUp], openclaw, hermes] = await Promise.all([
    ollamaModels(),
    openclawUp(),
    hermesOnPath(),
  ]);

  const runtimes = [
    { name: "hermes", present: hermes, detail: hermesCmd() },
    { name: "openclaw", present: openclaw, detail: process.env.OPENCLAW_URL ?? "http://localhost:18789" },
    { name: "opencode", present: onPath("opencode") },
    { name: "claude", present: onPath("claude") },
    { name: "codex", present: onPath("codex") },
    { name: "ollama", present: ollamaUp, detail: OLLAMA_URL },
    ...(["gpt-5-mini", "claude-opus-4-6", "gemini-3-flash-preview"] as const).map((probe) => {
      // One representative model per provider: apiCapabilityReady only checks
      // whether that provider's key is set, so the id is a stand-in for "is
      // this provider usable at all".
      const ready = apiCapabilityReady(probe);
      const provider = probe.startsWith("gpt") ? "OpenAI" : probe.startsWith("claude") ? "Anthropic" : "Google";
      return { name: provider, present: ready.ok, detail: ready.ok ? undefined : ready.reason };
    }),
  ];

  return { ollamaUrl: OLLAMA_URL, ollamaUp, models, runtimes, drops: [], notes: [] };
}

/** Installed models, plus whether the daemon answered at all. */
async function ollamaModels(): Promise<[HostModel[], boolean]> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [[], false];
    const data = (await res.json()) as {
      models?: Array<{ name: string; capabilities?: string[] }>;
    };
    const models = (data.models ?? []).map((m) => ({
      name: m.name,
      cloud: /cloud/.test(m.name),
      // Hermes always advertises tools, so a model without them cannot serve it.
      // Older daemons omit the field; absent is reported as unknown-so-false.
      tools: (m.capabilities ?? []).includes("tools"),
    }));
    return [models, true];
  } catch {
    return [[], false];
  }
}
