import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { CostEstimator, type CapabilityRecord, type TaskMessage } from "@hive/shared";
import { hermesArgs, hermesCmd } from "../hermes.js";
import type { ExecResult, RuntimeAdapter } from "../types.js";
import { buildPersonalContext, runMiniAgent } from "./mini.js";

const execFileAsync = promisify(execFile);

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OPENCLAW_URL = process.env.OPENCLAW_URL ?? "http://localhost:18789";
const EXEC_TIMEOUT_MS = Number(process.env.HIVE_EXEC_TIMEOUT_MS ?? 300_000);
const PROBE_TIMEOUT_MS = 2_500;
const PROBE_TTL_MS = 30_000;

export interface PersonalAgentOptions {
  /** absolute path the bee is allowed to read personal data from */
  dataDir: string;
}

/**
 * Tier 3: the user's personal agent, operating on local personal data.
 *
 * It prefers a real personal-agent runtime if one is installed — an OpenClaw
 * gateway or a Hermes CLI — and otherwise falls back to a built-in mini agent
 * (a local Ollama model over a sandboxed view of the personal-data directory),
 * so the personal path always works on a bare Ollama host. Whichever backend
 * runs, the actual value is reported in `runtimeUsed`.
 *
 * All backends are handed a deterministic snapshot of the relevant local data
 * (via buildPersonalContext) so the answer is grounded in the user's real files
 * regardless of whether the external runtime does its own file access.
 */
export class PersonalAgentAdapter implements RuntimeAdapter {
  runtimes = ["personal"];
  private readonly dataDir: string;
  private probe?: { at: number; openclaw: boolean; hermes: boolean };

  constructor(opts: PersonalAgentOptions) {
    this.dataDir = opts.dataDir;
  }

  async execute(task: TaskMessage, cap: CapabilityRecord, prompt: string): Promise<ExecResult> {
    const model = await this.resolveModel(cap);
    const query = `${task.spec.title} ${task.spec.input}`;
    const context = buildPersonalContext(this.dataDir, query);
    const preamble =
      `You are the user's personal assistant with access to their local personal data ` +
      `rooted at ${this.dataDir}. Answer using only that data.\n\n` +
      `Relevant personal data:\n${context}`;

    const backends = await this.availableBackends();
    const chain: Array<{ name: string; run: () => Promise<ExecResult> }> = [];
    if (backends.openclaw) chain.push({ name: "openclaw", run: () => this.viaOpenClaw(preamble, prompt, model) });
    if (backends.hermes) chain.push({ name: "hermes", run: () => this.viaHermes(preamble, prompt, model) });
    chain.push({
      name: "personal-mini",
      run: () =>
        runMiniAgent({
          dataDir: this.dataDir,
          model,
          ollamaUrl: OLLAMA_URL,
          timeoutMs: EXEC_TIMEOUT_MS,
          instruction: prompt,
          query,
          toolLoop: process.env.PERSONAL_TOOL_LOOP === "1",
        }),
    });

    const notes: string[] = [];
    for (const step of chain) {
      try {
        const r = await step.run();
        if (notes.length) r.output = `${r.output}\n\n[note: ${notes.join("; ")}]`;
        return r;
      } catch (err) {
        notes.push(`${step.name} unavailable (${trim(err)})`);
      }
    }
    return {
      ok: false,
      output: "",
      error: `personal agent failed: ${notes.join("; ")}`,
      inputTokens: 0,
      outputTokens: 0,
      runtimeUsed: "personal",
      modelUsed: model,
    };
  }

  /**
   * PERSONAL_MODEL > configured model > first installed local Ollama model.
   * An explicit choice wins only if it is actually installed — otherwise a
   * static yaml default (e.g. qwen3:8b) would 404 on a host that has different
   * models, so we fall back to whatever local model exists.
   */
  private async resolveModel(cap: CapabilityRecord): Promise<string> {
    const explicit = process.env.PERSONAL_MODEL ?? cap.model;
    let installed: string[] = [];
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name?: string }> };
        installed = (data.models ?? []).map((m) => m.name).filter((n): n is string => !!n);
      }
    } catch {
      /* Ollama may be absent when an external backend serves the task */
    }
    if (explicit && (installed.length === 0 || installed.includes(explicit))) return explicit;
    return installed[0] ?? explicit ?? "qwen3:8b";
  }

  private async availableBackends(): Promise<{ openclaw: boolean; hermes: boolean }> {
    const now = Date.now();
    if (this.probe && now - this.probe.at < PROBE_TTL_MS) {
      return { openclaw: this.probe.openclaw, hermes: this.probe.hermes };
    }
    const [openclaw, hermes] = await Promise.all([openclawUp(), hermesOnPath()]);
    this.probe = { at: now, openclaw, hermes };
    return { openclaw, hermes };
  }

  /** OpenClaw: local OpenAI-compatible gateway. */
  private async viaOpenClaw(system: string, prompt: string, model: string): Promise<ExecResult> {
    const res = await fetch(`${OPENCLAW_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`openclaw gateway ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const output = data.choices?.[0]?.message?.content ?? "";
    return {
      ok: true,
      output,
      inputTokens: data.usage?.prompt_tokens ?? CostEstimator.roughTokens(`${system}\n${prompt}`),
      outputTokens: data.usage?.completion_tokens ?? CostEstimator.roughTokens(output),
      runtimeUsed: "openclaw",
      modelUsed: model,
    };
  }

  /** Hermes: non-interactive CLI (configurable via HERMES_CMD). */
  private async viaHermes(system: string, prompt: string, model: string): Promise<ExecResult> {
    const { stdout } = await execFileAsync(hermesCmd(), hermesArgs(`${system}\n\n${prompt}`, model), {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = stdout.trim();
    // -Q prints the answer and nothing else, so empty stdout means Hermes ran
    // but produced nothing — fall through instead of returning a blank answer.
    if (!output) throw new Error("hermes produced no output");
    return {
      ok: true,
      output,
      inputTokens: CostEstimator.roughTokens(`${system}\n${prompt}`),
      outputTokens: CostEstimator.roughTokens(output),
      runtimeUsed: "hermes",
      modelUsed: model,
    };
  }
}

/** Probe helpers, exported so preflight/detection can share exactly this logic. */
export async function openclawUp(): Promise<boolean> {
  try {
    const res = await fetch(`${OPENCLAW_URL}/v1/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return false;
    // "Something is listening" is not enough. OpenClaw's control UI serves its
    // single-page app on the same port and answers 200 with HTML for any GET
    // path, /v1/models included — so a bare reachability check reports a
    // gateway that has no chat surface at all, and (being first in the chain)
    // silently shadows Hermes. Require an OpenAI-compatible JSON reply.
    return (res.headers?.get("content-type") ?? "").includes("json");
  } catch {
    return false;
  }
}

export async function hermesOnPath(): Promise<boolean> {
  const cmd = hermesCmd();
  // Walk PATH directly rather than shelling out — no subprocess, no quoting.
  return (process.env.PATH ?? "").split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function trim(err: unknown): string {
  return String(err).slice(0, 200);
}
