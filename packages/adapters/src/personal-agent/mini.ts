import { CostEstimator } from "@hive/shared";
import type { ExecResult } from "../types.js";
import {
  listMailbox,
  readPersonalFile,
  searchMailbox,
  walkFiles,
  type MailMessage,
} from "./sandbox.js";

const CONTEXT_BUDGET_CHARS = 6000;
const DOC_SNIPPET_CHARS = 900;
const MAX_TOOL_ROUNDS = 4;

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
 * most relevant to the request (falling back to the most recent), and snippets
 * of the most relevant text documents/notes. This is what makes the mini agent
 * genuinely answer from the user's local data instead of hallucinating, without
 * relying on a small local model to drive tool calls correctly.
 */
export function buildPersonalContext(dataDir: string, query: string): string {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 2))];
  const files = walkFiles(dataDir, { maxFiles: 100, maxDepth: 3 });
  const sections: string[] = [];

  if (files.length) sections.push(`Personal data files available:\n${files.map((f) => `- ${f}`).join("\n")}`);

  // Email: relevant first, else the most recent handful.
  let mail = searchMailbox(dataDir, query);
  if (mail.length === 0) mail = listMailbox(dataDir).slice(-6);
  if (mail.length) {
    sections.push(`Email messages:\n${mail.slice(0, 6).map(fmtMail).join("\n---\n")}`);
  }

  // Text documents and notes, ranked by keyword overlap (most recent-agnostic;
  // include the top few so a query with no keyword hit still gets material).
  const docs = files.filter((f) => TEXT_EXT.test(f) && !STRUCTURED.has(f));
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
    .filter((d) => d.body)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (scored.length) {
    sections.push(
      `Documents and notes:\n${scored
        .map((d) => `--- ${d.f} ---\n${d.body.slice(0, DOC_SNIPPET_CHARS)}`)
        .join("\n\n")}`,
    );
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
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

const SYSTEM = (dataDir: string) =>
  `You are the user's personal assistant. You have access to their local personal data ` +
  `(email, files, calendar, notes) rooted at ${dataDir}. Answer using only that data; ` +
  `if something isn't present, say so rather than inventing it.`;

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
    signal: AbortSignal.timeout(timeoutMs),
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

function usage(instruction: string, context: string, output: string, data?: { prompt_eval_count?: number; eval_count?: number }): ExecResult {
  return {
    ok: true,
    output,
    inputTokens: data?.prompt_eval_count ?? CostEstimator.roughTokens(`${context}\n${instruction}`),
    outputTokens: data?.eval_count ?? CostEstimator.roughTokens(output),
    runtimeUsed: "personal-mini",
    modelUsed: undefined,
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

  if (opts.toolLoop) {
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM(dataDir) },
        { role: "user", content: instruction },
      ];
      let last: Awaited<ReturnType<typeof ollamaChat>> | undefined;
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        last = await ollamaChat(ollamaUrl, model, messages, timeoutMs, TOOLS);
        const msg = last.message;
        if (!msg) break;
        const calls = msg.tool_calls ?? [];
        if (calls.length === 0) {
          return usage(instruction, "", msg.content ?? "", last);
        }
        messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
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
    } catch {
      // Any tool-loop failure degrades to the deterministic path.
    }
  }

  const context = buildPersonalContext(dataDir, query);
  const messages: ChatMessage[] = [
    { role: "system", content: `${SYSTEM(dataDir)}\n\nHere is the relevant personal data:\n\n${context}` },
    { role: "user", content: instruction },
  ];
  const data = await ollamaChat(ollamaUrl, model, messages, timeoutMs);
  return usage(instruction, context, data.message?.content ?? "", data);
}
