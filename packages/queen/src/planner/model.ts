import { PlannerDecision, type PlannerTurn } from "./types.js";
import type { ChatMessage } from "./session.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const DEFAULT_LOCAL_MODEL = process.env.HIVE_PLANNER_MODEL ?? "gemma3:4b";
const PLANNER_TIMEOUT_MS = Number(process.env.HIVE_PLANNER_TIMEOUT_MS ?? 60_000);

export interface PlannerContext {
  /** skills advertised by live workers, for grounding decomposition */
  skills: string[];
  /** tier-4 tools available: id + the keys their toolInput needs */
  tools: Array<{ toolId: string; requiredKeys: string[] }>;
  /** hand-authored plan guide for this customer; "" when absent or disabled */
  guide?: string;
  /** rendered block of recalled memories; "" when nothing was relevant */
  memories?: string;
}

/**
 * Ordered most-stable first, so the longest possible prefix stays identical
 * between turns. That is level 4 of the token minimization ladder (stable
 * prompt prefixes) and it matters on the escalation path, which is the only
 * planner call that spends real money: the static rules and the guide change
 * per deployment, the live skills change per worker registration, and the
 * recalled notes change per turn.
 */
function systemPrompt(ctx: PlannerContext): string {
  const skills = ctx.skills.length ? ctx.skills.join(", ") : "general";
  const tools = ctx.tools.map((t) => `${t.toolId}(needs: ${t.requiredKeys.join(", ")})`).join("; ") || "none";
  return [
    "You are the Queen of an AI agent hive. You talk with the user and decide what work to hand to worker bees.",
    "You do NOT do the work yourself and you do NOT choose which model or tier runs a task. You only shape the request into tasks.",
    "",
    "Reply with a SINGLE JSON object, no prose around it, in exactly one of these shapes:",
    '1. Need more info: {"kind":"clarify","question":"..."}',
    '2. Do work: {"kind":"plan","rationale":"...","tasks":[{"key":"t1","title":"...","input":"...","skills":["coding"],"sensitivity":"normal","urgency":"normal","dependsOn":[]}]}',
    '3. Just answer: {"kind":"answer","text":"..."}',
    "",
    "Rules:",
    "- Use clarify when the request is too vague to act on.",
    "- Use plan for real work. Split multi-step requests into several tasks and set dependsOn to earlier task keys when one needs another's result.",
    "- Set sensitivity to confidential when the request involves proprietary or secret material; such work stays on local models.",
    "- Use answer for greetings, capability questions, or anything needing no worker.",
    "- For a task that matches a tool, put its required keys inside toolInput.",
    "- Keep task input self-contained and concise.",
    ...(ctx.guide ? ["", "--- Planning guide from your operator ---", ctx.guide, "--- end guide ---"] : []),
    "",
    `Worker skills available: ${skills}.`,
    `Deterministic tools available: ${tools}.`,
    ...(ctx.memories ? ["", ctx.memories] : []),
  ].join("\n");
}

/** exported for the prompt-budget regression test */
export { systemPrompt };

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON object in planner output");
  return JSON.parse(text.slice(start, end + 1));
}

async function callOllama(model: string, messages: ChatMessage[], system: string, asJson = true) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      ...(asJson ? { format: "json" } : {}),
      options: { temperature: 0.2 },
      messages: [{ role: "system", content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(PLANNER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ollama planner ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as OllamaChatResponse;
}

/**
 * Tiered planner brain. A small local model handles intake by default. It only
 * escalates to a stronger model (when configured) for requests a cheap
 * heuristic flags as complex, so the Queen's own reasoning follows the same
 * cost ladder as the workers.
 */
export class PlannerModel {
  constructor(
    private priceCall: (modelId: string, inTok: number, outTok: number) => number,
    private escalationModel?: string,
  ) {}

  chooseModel(escalate: boolean): { model: string; tier: number } {
    if (escalate && this.escalationModel) return { model: this.escalationModel, tier: 2 };
    return { model: DEFAULT_LOCAL_MODEL, tier: 3 };
  }

  async plan(messages: ChatMessage[], ctx: PlannerContext, escalate: boolean): Promise<PlannerTurn> {
    const { model, tier } = this.chooseModel(escalate);
    const system = systemPrompt(ctx);

    let raw: OllamaChatResponse;
    let content: string;
    try {
      raw = await callOllama(model, messages, system);
      content = raw.message?.content ?? "";
    } catch (err) {
      // Model unreachable: degrade to a single standard task from the last user turn.
      const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      return {
        decision: { kind: "plan", rationale: `planner model unavailable (${String(err).slice(0, 120)})`, tasks: [{ key: "t1", title: last.slice(0, 60) || "task", input: last, skills: [], sensitivity: "normal", urgency: "normal", dependsOn: [] }] },
        modelUsed: `${model} (unavailable)`,
        tier,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        degraded: true,
      };
    }

    const inTok = raw.prompt_eval_count ?? 0;
    const outTok = raw.eval_count ?? 0;
    const costUsd = this.priceCall(model, inTok, outTok);

    let decision: PlannerDecision;
    const parsed = PlannerDecision.safeParse(tryExtract(content));
    if (parsed.success) {
      decision = parsed.data;
    } else {
      // Malformed structured output: treat the text as a plain answer rather than guessing work.
      decision = { kind: "answer", text: content.trim() || "I could not parse a plan for that. Could you rephrase?" };
    }
    return { decision, modelUsed: model, tier, usage: { inputTokens: inTok, outputTokens: outTok, costUsd } };
  }

  /**
   * Phrase one learned lesson. Always the local model, never the escalation
   * model: reflection must never spend API dollars. Callers always hold a
   * deterministic fallback sentence, so a failure here costs nothing but a
   * slightly blander note.
   */
  async phraseLesson(prompt: string): Promise<{ text: string; costUsd: number }> {
    const model = DEFAULT_LOCAL_MODEL;
    const raw = await callOllama(
      model,
      [{ role: "user", content: prompt }],
      "You write one-sentence lessons for a task planner. Reply with only the sentence.",
      false,
    );
    return {
      text: (raw.message?.content ?? "").trim().slice(0, 300),
      costUsd: this.priceCall(model, raw.prompt_eval_count ?? 0, raw.eval_count ?? 0),
    };
  }

  /** Compose worker results into one user-facing answer. Uses the local model. */
  async synthesize(goal: string, parts: Array<{ title: string; output: string }>): Promise<{ text: string; costUsd: number }> {
    const model = DEFAULT_LOCAL_MODEL;
    const body = parts.map((p, i) => `Result ${i + 1} (${p.title}):\n${p.output.slice(0, 4000)}`).join("\n\n");
    const messages: ChatMessage[] = [
      { role: "user", content: `Goal: ${goal}\n\nWorker results:\n${body}\n\nWrite a concise answer to the goal using these results.` },
    ];
    try {
      const raw = await callOllama(model, messages, "You are the Queen summarizing worker results for the user. Be concise and direct.", false);
      const costUsd = this.priceCall(model, raw.prompt_eval_count ?? 0, raw.eval_count ?? 0);
      return { text: raw.message?.content?.trim() || body, costUsd };
    } catch {
      // Fall back to concatenated raw output rather than failing the turn.
      return { text: parts.map((p) => `${p.title}:\n${p.output}`).join("\n\n"), costUsd: 0 };
    }
  }
}

function tryExtract(content: string): unknown {
  try {
    return extractJson(content);
  } catch {
    return null;
  }
}
