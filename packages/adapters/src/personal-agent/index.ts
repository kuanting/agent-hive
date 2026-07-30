import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { CostEstimator, type CapabilityRecord, type TaskMessage } from "@hive/shared";
import { hermesArgs, hermesCmd, splitHermesOutput } from "../hermes.js";
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

/** Backends a personal bee can name in its `agent:` field. */
const KNOWN_BACKENDS = new Set(["openclaw", "hermes", "personal-mini"]);

/**
 * Tier 3: the user's personal agent, operating on local personal data.
 *
 * It prefers a real personal-agent runtime if one is installed — an OpenClaw
 * gateway or a Hermes CLI — and otherwise falls back to a built-in mini agent
 * (a local Ollama model over a sandboxed view of the personal-data directory),
 * so the personal path always works on a bare Ollama host. Whichever backend
 * runs, the actual value is reported in `runtimeUsed`.
 *
 * The capability's `agent` field names which backend to reach for first. It is a
 * preference, never a pin: an unreachable named agent moves aside for the rest
 * of the chain rather than failing the task, and the substitution is recorded in
 * the output note and in `runtimeUsed`, so a degraded run is never silent.
 *
 * Each backend is framed for what it can actually do. A snapshot of the matching
 * local data (via buildPersonalContext) grounds a backend that has no file access
 * of its own; one that harnesses its own tools is told the corpus is available
 * and left free to reach the sources its task names. See groundedFrame and
 * autonomousFrame — the distinction is load-bearing, not cosmetic.
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

    const backends = await this.availableBackends();
    const chain: Array<{ name: string; run: () => Promise<ExecResult> }> = [];
    if (backends.openclaw) {
      chain.push({ name: "openclaw", run: () => this.viaOpenClaw(groundedFrame(this.dataDir, context), prompt, model) });
    }
    if (backends.hermes) {
      chain.push({ name: "hermes", run: () => this.viaHermes(autonomousFrame(this.dataDir, context), prompt, model) });
    }
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
          context,
        }),
    });

    const notes: string[] = [];
    // A configured agent is a preference, not a pin: it goes to the front of the
    // chain, and the rest stays behind it so the personal path still answers on a
    // host where that agent is missing. Note it when the preference cannot be
    // honored — otherwise a bee configured for Hermes would run the mini agent
    // and report nothing, which is the failure mode this whole field exists to
    // end. An unrecognized name is a config typo, and says so.
    const preferred = cap.agent;
    if (preferred && preferred !== "personal") {
      const idx = chain.findIndex((step) => step.name === preferred);
      if (idx > 0) chain.unshift(...chain.splice(idx, 1));
      else if (idx === -1) {
        notes.push(
          KNOWN_BACKENDS.has(preferred)
            ? `${preferred} preferred but unavailable here`
            : `unknown agent "${preferred}" configured (expected one of ${[...KNOWN_BACKENDS].join(", ")})`,
        );
      }
    }
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
   * static yaml default (e.g. qwen3.5:4b) would 404 on a host that has different
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
    return installed[0] ?? explicit ?? "qwen3.5:4b";
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
    const { stdout, stderr } = await execFileAsync(hermesCmd(), hermesArgs(`${system}\n\n${prompt}`, model), {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    // Hermes' stdout is not the answer alone even under -Q; see splitHermesOutput.
    const { answer, diagnostics } = splitHermesOutput(stdout, stderr);
    // Nothing left once the chatter is separated means Hermes ran and produced
    // no answer — fall through to the next backend rather than returning blank.
    // The diagnostics are the interesting part of such a run, so they ride along
    // on the error where the chain's note will surface them.
    if (!answer) {
      throw new Error(`hermes produced no answer${diagnostics.length ? `: ${diagnostics.join(" / ")}` : ""}`);
    }
    return {
      ok: true,
      output: answer,
      inputTokens: CostEstimator.roughTokens(`${system}\n${prompt}`),
      outputTokens: CostEstimator.roughTokens(answer),
      runtimeUsed: "hermes",
      modelUsed: model,
      ...(diagnostics.length ? { diagnostics } : {}),
    };
  }
}

/**
 * How the personal corpus is described to a backend must match what that backend
 * can actually do, because the bee acts on what we tell it.
 *
 * The original single frame said "Answer using only that data" to every backend
 * and pasted a corpus snapshot under the heading "Relevant personal data".
 * Applied to Hermes — which has its own file tools and is not sandboxed by us —
 * that was false twice over: it can read more than the corpus, and the snapshot
 * was frequently not relevant. A task naming an explicit path then had its own
 * instruction contradicted by its system prompt, and whether it got answered
 * came down to which of the two the model chose to believe.
 *
 * So: state the truth per backend, and let a capable bee use its judgement.
 */

/**
 * Frame for a backend with no tools of its own. `viaOpenClaw` posts a plain chat
 * completion, so the snapshot really is all it has, and saying so is accurate
 * rather than limiting. Withholding the snapshot here would leave it with
 * nothing at all.
 */
export function groundedFrame(dataDir: string, context: string): string {
  const head =
    `You are the user's personal assistant. Their personal data (email, files, calendar, ` +
    `notes) lives at ${dataDir}. You have no file access in this call, so the excerpt below ` +
    `is the only material you have.`;
  return context
    ? `${head}\n\nPersonal data matching this request:\n${context}`
    : `${head}\n\nNothing in the personal corpus matched this request. If the task needs ` +
        `material you have not been given, say exactly what is missing.`;
}

/**
 * Frame for a backend that can look things up itself (Hermes and anything else
 * harnessing its own tools). The corpus is offered as a starting point, never as
 * a boundary, and paths named in the task are explicitly in scope — that is what
 * makes a "summarize the code at /some/path" task answerable at all.
 */
export function autonomousFrame(dataDir: string, context: string): string {
  const head =
    `You are the user's personal assistant, working as one bee in an agent hive. Their ` +
    `personal data (email, files, calendar, notes) lives at ${dataDir} and is available to ` +
    `you. You also have your own tools: if the task names a file, directory or path, read ` +
    `it directly rather than assuming it is out of reach. Use your judgement about which ` +
    `sources the task actually needs.`;
  return context
    ? `${head}\n\nA search of the personal corpus turned up this, which may or may not be ` +
        `what the task needs — treat it as a starting point, not the answer:\n${context}`
    : `${head}\n\nA search of the personal corpus turned up nothing matching this request, ` +
        `which is expected when the task is about something else. Go to the sources the task names.`;
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
  const executable = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  // A HERMES_CMD carrying a separator is a location, not a name to look up — and
  // `join(dir, "/opt/hermes/bin/hermes")` yields "<dir>/opt/hermes/bin/hermes",
  // which exists nowhere. So an absolute override used to fail this probe on every
  // host, silently dropping Hermes out of the chain while `hermesCmd()` still
  // reported it — the exact configuration hermes.ts and personal-bee.yaml both
  // document as supported.
  if (cmd.includes("/") || cmd.includes("\\")) return executable(cmd);
  // Walk PATH directly rather than shelling out — no subprocess, no quoting.
  return (process.env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && executable(join(dir, cmd)));
}

function trim(err: unknown): string {
  return String(err).slice(0, 200);
}
