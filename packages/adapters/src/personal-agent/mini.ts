import { CostEstimator } from "@hive/shared";
import type { ExecResult } from "../types.js";
import {
  queryTerms,
  readPersonalFile,
  searchMailbox,
  walkFiles,
  type MailMessage,
} from "./sandbox.js";
import { execSignal, reportStep } from "../exec-context.js";

const CONTEXT_BUDGET_CHARS = 6000;
const DOC_SNIPPET_CHARS = 900;
/**
 * How many tool rounds the mini agent may take before falling back to the
 * deterministic prefetch.
 *
 * A round limit is a completion cap wearing a token cap's clothes: an agent that
 * needed one more call to finish gets its work discarded and answers from a
 * snapshot instead. Four is a reasonable default for a small local model that
 * tends to loop rather than converge, but the task that needs a fifth call is
 * exactly the one this must not silently refuse — so it is tunable, and running
 * out is now reported rather than absorbed.
 */
const MAX_TOOL_ROUNDS = Number(process.env.HIVE_TOOL_ROUNDS ?? 4);

const TEXT_EXT = /\.(md|txt|markdown|text)$/i;
const STRUCTURED = new Set(["mailbox.json", "calendar.json"]);

function fmtMail(m: MailMessage): string {
  const head = [m.date && `Date: ${m.date}`, `From: ${m.from}`, m.to && `To: ${m.to}`, `Subject: ${m.subject}`]
    .filter(Boolean)
    .join("\n");
  return `${head}\n\n${m.body}`.slice(0, 1200);
}

function overlapScore(text: string, terms: string[]): number {
  const hay = text.toLowerCase();
  return terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
}

/**
 * Deterministic retrieval over the sandboxed corpus: a file overview, the mail
 * relevant to the request, and snippets of the relevant text documents/notes.
 * This is what makes the mini agent genuinely answer from the user's local data
 * instead of hallucinating, without relying on a small local model to drive tool
 * calls correctly.
 *
 * Every section past the file overview is gated on actual keyword overlap, and
 * the function returns "" when nothing in the corpus is relevant. That empty
 * result is the useful one: a caller that prints "Relevant personal data:" over
 * unrelated material tells the bee its task is unanswerable from data that was
 * never about the task. Withholding leaves a tool-capable backend free to go
 * look for what the task actually named.
 */
export function buildPersonalContext(dataDir: string, query: string): string {
  const terms = queryTerms(query);
  const sections: string[] = [];

  // Email and documents, both gated on overlap. No "most recent handful"
  // fallback: searchMailbox already returns nothing when nothing matches, and
  // overriding that put six unrelated messages in front of every off-topic task.
  const mail = terms.length ? searchMailbox(dataDir, query) : [];
  if (mail.length) {
    sections.push(`Email messages:\n${mail.slice(0, 6).map(fmtMail).join("\n---\n")}`);
  }

  const files = walkFiles(dataDir, { maxFiles: 100, maxDepth: 3 });
  const docs = terms.length ? files.filter((f) => TEXT_EXT.test(f) && !STRUCTURED.has(f)) : [];
  const scored = docs
    .map((f) => {
      let body = "";
      try {
        body = readPersonalFile(dataDir, f);
      } catch {
        /* skip unreadable */
      }
      return { f, body, score: overlapScore(`${f} ${body}`, terms) };
    })
    .filter((d) => d.body && d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (scored.length) {
    sections.push(
      `Documents and notes:\n${scored
        .map((d) => `--- ${d.f} ---\n${d.body.slice(0, DOC_SNIPPET_CHARS)}`)
        .join("\n\n")}`,
    );
  }

  // The file overview is a listing, not a claim of relevance, so it is safe to
  // include — but only alongside material. On its own it is just a directory
  // dump of unrelated personal files, which is exactly what we stopped sending.
  if (sections.length === 0) return "";
  if (files.length) {
    sections.unshift(`Personal data files available:\n${files.map((f) => `- ${f}`).join("\n")}`);
  }

  return sections.join("\n\n").slice(0, CONTEXT_BUDGET_CHARS);
}

interface MiniOptions {
  dataDir: string;
  model: string;
  ollamaUrl: string;
  timeoutMs: number;
  /** the assembled task prompt (title + input + any artifacts) */
  instruction: string;
  /** keyword source for retrieval — the raw task title + input */
  query: string;
  toolLoop: boolean;
  /**
   * The corpus snapshot, when the caller already built one. The adapter builds
   * it to frame the external backends, so accepting it here keeps one walk of
   * the corpus per task instead of two.
   */
  context?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

/**
 * The mini agent's clamp is honest: its tools are sandboxed to `dataDir` and it
 * genuinely cannot read anything else. What it must not do is confuse "outside
 * my reach" with "does not exist" — a task naming a path elsewhere on the
 * machine is one this backend cannot serve, which is a different report from
 * "the data does not mention it" and routes differently.
 */
const SYSTEM = (dataDir: string) =>
  `You are the user's personal assistant. Your file access is limited to their local ` +
  `personal data (email, files, calendar, notes) rooted at ${dataDir}. Answer from that ` +
  `data; never invent what isn't there. If the task asks about a path outside that root, ` +
  `say you have no access to it rather than saying the information does not exist.`;

async function ollamaChat(
  ollamaUrl: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
  tools?: unknown[],
): Promise<{ message?: ChatMessage; prompt_eval_count?: number; eval_count?: number }> {
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false, ...(tools ? { tools } : {}) }),
    signal: execSignal(timeoutMs),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { message?: ChatMessage; prompt_eval_count?: number; eval_count?: number };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_mail",
      description: "Search the user's mailbox. Returns matching messages.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a personal-data file by its relative path.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

function runTool(dataDir: string, name: string, args: Record<string, unknown>): string {
  if (name === "search_mail") {
    return searchMailbox(dataDir, String(args.query ?? ""))
      .map(fmtMail)
      .join("\n---\n")
      .slice(0, 3000) || "(no matching mail)";
  }
  if (name === "read_file") {
    return readPersonalFile(dataDir, String(args.path ?? "")).slice(0, 3000);
  }
  throw new Error(`unknown tool ${name}`);
}

function usage(
  model: string,
  instruction: string,
  context: string,
  output: string,
  data?: { prompt_eval_count?: number; eval_count?: number },
): ExecResult {
  return {
    ok: true,
    output,
    inputTokens: data?.prompt_eval_count ?? CostEstimator.roughTokens(`${context}\n${instruction}`),
    outputTokens: data?.eval_count ?? CostEstimator.roughTokens(output),
    runtimeUsed: "personal-mini",
    // Report the model that actually answered. The mini agent is the fallback
    // path, so this is exactly the case where someone is asking "what ran?".
    modelUsed: model,
  };
}

/**
 * The built-in fallback personal agent. By default it prefetches relevant local
 * data deterministically and makes a single local Ollama call. With
 * PERSONAL_TOOL_LOOP=1 it instead lets the model drive sandboxed tools, falling
 * back to the prefetch path on any error.
 */
export async function runMiniAgent(opts: MiniOptions): Promise<ExecResult> {
  const { dataDir, model, ollamaUrl, timeoutMs, instruction, query } = opts;

  const diagnostics: string[] = [];

  if (opts.toolLoop) {
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM(dataDir) },
        { role: "user", content: instruction },
      ];
      let last: Awaited<ReturnType<typeof ollamaChat>> | undefined;
      let round = 0;
      for (; round < MAX_TOOL_ROUNDS; round++) {
        reportStep("thinking", { n: round + 1, of: MAX_TOOL_ROUNDS });
        last = await ollamaChat(ollamaUrl, model, messages, timeoutMs, TOOLS);
        const msg = last.message;
        if (!msg) break;
        const calls = msg.tool_calls ?? [];
        if (calls.length === 0) {
          return usage(model, instruction, "", msg.content ?? "", last);
        }
        messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
        reportStep("reading-files", { n: round + 1, of: MAX_TOOL_ROUNDS });
        for (const c of calls) {
          let result: string;
          try {
            result = runTool(dataDir, c.function.name, c.function.arguments ?? {});
          } catch (err) {
            result = `error: ${String(err).slice(0, 200)}`;
          }
          messages.push({ role: "tool", content: result });
        }
      }
      // Ran out of rounds without a final answer — fall through to prefetch.
      // Say so: the agent was mid-investigation and got cut off, which is a
      // different (and fixable, via HIVE_TOOL_ROUNDS) reason for a thin answer
      // than "the corpus did not have it".
      if (round >= MAX_TOOL_ROUNDS) {
        diagnostics.push(
          `tool loop stopped after ${MAX_TOOL_ROUNDS} rounds without a final answer; answered from the prefetched snapshot instead (raise HIVE_TOOL_ROUNDS to allow more)`,
        );
      }
    } catch (err) {
      // Any tool-loop failure degrades to the deterministic path.
      diagnostics.push(`tool loop failed (${String(err).slice(0, 200)}); answered from the prefetched snapshot instead`);
    }
  }

  const context = opts.context ?? buildPersonalContext(dataDir, query);
  // No heading over an empty snapshot: "here is the relevant personal data:"
  // followed by nothing reads as "the corpus is empty", which is a claim we have
  // no business making when the truth is that nothing in it matched.
  const system = context
    ? `${SYSTEM(dataDir)}\n\nHere is the relevant personal data:\n\n${context}`
    : `${SYSTEM(dataDir)}\n\nNothing in the personal corpus matched this request.`;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: instruction },
  ];
  reportStep("writing");
  const data = await ollamaChat(ollamaUrl, model, messages, timeoutMs);
  const res = usage(model, instruction, context, data.message?.content ?? "", data);
  if (diagnostics.length) res.diagnostics = diagnostics;
  return res;
}
