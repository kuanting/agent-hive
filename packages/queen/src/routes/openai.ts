import { createHash } from "node:crypto";
import type { Express, Response } from "express";
import {
  agentLabel,
  ChatTurn,
  Passthrough,
  TaskSpec,
  ToolDefinition,
  type CapabilityRecord,
  type CapabilitySelector,
  type TaskResult,
} from "@hive/shared";
import { z } from "zod";
import { callerOf, isOpen, loadApiKeys, requireKey } from "../auth.js";
import type { QueenCore } from "../core.js";
import type { CapabilityRequirement } from "../tierMapper.js";

/**
 * The hive as an LLM.
 *
 * Any client that speaks OpenAI — a script, a web UI, another agent — points its
 * base URL here and hands over work. The stateless shape of a chat completion is
 * doing real architectural work rather than just being familiar: the caller
 * re-sends its transcript every turn, so the caller owns conversation, memory
 * and workflow *because the protocol leaves it nowhere else to put them*, and
 * the hive is left owning dispatch, routing, budgets and confidentiality. That
 * is a cleaner split than the Queen's own chat surface can promise, whose
 * sessions live in memory and die with the process.
 *
 * Nothing here executes anything. Every request goes through `core.submitTask`
 * and `core.awaitResult`, the same two calls the planner uses, so routing, the
 * ledger, the result cache, retries and the confidentiality gate all apply
 * exactly as they do to any other task.
 */

/** The prefix that marks a model id as ours, so `hive/local` cannot collide with a real model name. */
const PREFIX = "hive/";
/** The router's own choice, and the default when a caller does not care. */
const AUTO = "hive/auto";

const ChatCompletionRequest = z.object({
  model: z.string(),
  messages: z.array(ChatTurn).min(1),
  tools: z.array(ToolDefinition).default([]),
  tool_choice: z.unknown().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  stream: z.boolean().default(false),
  /**
   * OpenAI's end-user field. Recorded as a hash, for attribution and for telling
   * one caller's agent loop from another's — not, despite what this said before,
   * as a stickiness key. Nothing routes on it.
   */
  user: z.string().optional(),
});

/**
 * What every live capability is called as a model.
 *
 * Built from the agent label the rest of the hive already uses, so an id in
 * `/v1/models` is the same word the console shows on the task card — a caller
 * that picks `hive/gemini-search` can find its own request in the Activity feed
 * without a translation table.
 *
 * Computed over the whole list rather than one record at a time, because
 * uniqueness is a property of the list. `agentLabel` disambiguates on model, and
 * two records can share an agent AND a model while differing by seat — a real
 * Claude Max window and a tiny demo one. Two entries with one id would let a
 * caller name a capability and be served by its twin, so the seat (then a skill,
 * then position) is appended until the ids are distinct. A model id has to
 * identify exactly one capability or naming one means nothing.
 */
function modelIds(caps: CapabilityRecord[]): string[] {
  // People type these. `agentLabel` is written for a console chip and produces
  // `tool [csv-report]`; punctuation and spaces have no business in a model id
  // that ends up in a shell command and a config file.
  const slug = (s: string) =>
    s
      .replace(/[^A-Za-z0-9._:-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const base = caps.map((c) => PREFIX + slug(agentLabel(c, caps)));
  const counts = new Map<string, number>();
  for (const id of base) counts.set(id, (counts.get(id) ?? 0) + 1);
  return base.map((id, i) => {
    if ((counts.get(id) ?? 0) < 2) return id;
    const cap = caps[i];
    const suffix = cap.quotaWindow?.seatId ?? cap.skills[0] ?? String(i);
    return `${id}/${suffix}`;
  });
}

/** The capability a model id names, or undefined. Ids are unique, so this is unambiguous. */
function findByModelId(caps: CapabilityRecord[], id: string): CapabilityRecord | undefined {
  const index = modelIds(caps).indexOf(id);
  return index === -1 ? undefined : caps[index];
}

function errorBody(message: string, type = "invalid_request_error", code?: string) {
  return { error: { message, type, ...(code ? { code } : {}) } };
}

export function mountOpenAiRoutes(app: Express, core: QueenCore): void {
  const keys = loadApiKeys();
  const guard = requireKey(keys);
  if (isOpen(keys)) {
    console.warn(
      "[queen] /v1 is UNAUTHENTICATED: set HIVE_API_KEYS=key:customerId[:userId] before exposing it beyond loopback.",
    );
  }

  /** Every live capability, plus the router itself. Reflects the fleet right now, not the config. */
  const liveModels = () => {
    const caps = core.registry.liveCapabilities();
    const ids = modelIds(caps);
    return caps.map((cap, i) => ({
      id: ids[i],
      object: "model" as const,
      created: 0,
      owned_by: "agent-hive",
      hive: {
        tier: cap.tier,
        billing: cap.billing,
        agent: cap.agent ?? cap.runtime,
        runtime: cap.runtime,
        model: cap.model,
        skills: cap.skills,
        description: cap.description,
        /**
         * Advertised rather than discovered by failing. `claude-code` and
         * `codex` are agents that execute tools themselves and return prose, so
         * they can never answer a turn in someone else's loop; a client that
         * needs tool calls has to be able to see that before it sends any.
         */
        supports_tools: cap.supportsTools,
        search: cap.search,
        /**
         * Whether output arrives incrementally. `claude -p` is a buffered
         * subprocess, so a stream from it is phase narration and then the whole
         * answer — which callers should know before setting a short timeout.
         */
        streams_incrementally: false,
      },
    }));
  };

  app.get("/v1/models", guard, (_req, res) => {
    res.json({
      object: "list",
      data: [
        {
          id: AUTO,
          object: "model",
          created: 0,
          owned_by: "agent-hive",
          hive: {
            description:
              "The Queen: scores the request, then routes it to the cheapest capability that can do it. Cannot serve tool calls.",
            supports_tools: false,
            search: false,
            streams_incrementally: false,
          },
        },
        ...liveModels(),
      ],
    });
  });

  app.post("/v1/chat/completions", guard, async (req, res) => {
    const parsed = ChatCompletionRequest.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(errorBody(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
    }
    const body = parsed.data;
    const caller = callerOf(res);

    // Resolve the model id to a hard capability requirement. `hive/auto` sets
    // none, which is what makes it the router's own choice.
    let require: CapabilityRequirement | undefined;
    if (body.model !== AUTO) {
      const caps = core.registry.liveCapabilities();
      const match = findByModelId(caps, body.model);
      if (!match) {
        return res.status(404).json(
          errorBody(
            `unknown model '${body.model}'. GET /v1/models lists what this hive is serving right now.`,
            "invalid_request_error",
            "model_not_found",
          ),
        );
      }
      const selector: CapabilitySelector = {
        label: body.model,
        agent: match.agent ?? match.runtime,
        runtime: match.runtime,
        model: match.model,
        // The seat is what tells two otherwise identical records apart, so it
        // has to be in the selector as well as in the id.
        seatId: match.quotaWindow?.seatId,
        skills: [],
      };
      require = {
        selector,
        remedy: `GET /v1/models to see what is live, or use ${AUTO} to let the hive choose`,
      };
    }

    // A caller's tools can only be served by a capability that can answer with
    // tool calls. Refusing here — before any spend — beats dispatching to an
    // agent that would helpfully do the work itself and return prose, which is
    // an answer to a question the caller did not ask.
    if (body.tools.length) {
      const caps = core.registry.liveCapabilities();
      const ids = modelIds(caps);
      const capable = caps.filter((c, i) => c.supportsTools && (!require || ids[i] === body.model));
      if (!capable.length) {
        const named = body.model !== AUTO ? `'${body.model}' cannot serve tool calls` : "no live capability can serve tool calls";
        return res.status(400).json(
          errorBody(
            `${named}. The hive takes tasks; only some of its bees can answer a turn in your own agent loop — ` +
              `agent runtimes such as claude-code run their own tools and return prose. ` +
              `GET /v1/models and pick one with hive.supports_tools = true.`,
            "invalid_request_error",
            "tools_unsupported",
          ),
        );
      }
      // With no model named, narrow `auto` to the capable ones rather than
      // failing: the caller asked for tools, not for a particular bee.
      if (!require) {
        require = {
          selector: { label: "tool calling", skills: [], supportsTools: true },
          remedy: "start a bee whose model supports tool calls, or drop `tools` from the request",
        };
      }
    }

    const passthrough = Passthrough.parse({
      messages: body.messages,
      tools: body.tools,
      toolChoice: body.tool_choice,
      temperature: body.temperature,
      maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
    });

    const last = [...body.messages].reverse().find((m) => m.role === "user");
    const spec = TaskSpec.parse({
      customerId: caller.customerId,
      // Titles are read by humans in the console and the log, so this is a
      // label, never the content: the transcript itself rides in `passthrough`.
      title: `chat ${body.model}`,
      // `input` still carries the last user turn because everything that reads a
      // task — difficulty scoring, the confidentiality heuristic, the result
      // cache — reads this field. A passthrough turn whose input were empty
      // would score `simple` and cache against every other empty one.
      input: last?.content ?? "",
      skills: [],
      // No `continues`, and so no session affinity on this path. A comment here
      // used to claim stickiness "rides on `continues` below" — there was no
      // `continues` below, and there is no mechanism. Wiring one is a real
      // design question rather than an omission: `continues` names a predecessor
      // taskId, which a stateless completion does not have, and resuming a bee's
      // session while also forwarding the caller's whole transcript would hand
      // the model the conversation twice. Recorded in DESIGN §10 instead of
      // described here as though it worked.
    });

    // Attribution, not routing: who asked, for the recorded row. The end-user
    // field is hashed rather than stored — it is only ever wanted as a grouping
    // key, and callers put anything in it, up to and including an email address.
    const outcome = core.submitTask(spec, require, passthrough, {
      userId: caller.userId,
      endUserHash: body.user ? createHash("sha1").update(body.user).digest("hex").slice(0, 12) : undefined,
    });
    const result = outcome.cached && outcome.result ? outcome.result : await core.awaitResult(outcome.taskId);

    if (body.stream) return streamCompletion(res, body.model, result);
    return res.json(completionBody(body.model, result));
  });
}

/** Map a hive result onto the response shape every OpenAI client already parses. */
function completionBody(model: string, result: TaskResult) {
  const finish = result.toolCalls?.length ? "tool_calls" : (result.finishReason ?? (result.ok ? "stop" : "stop"));
  return {
    id: `chatcmpl-${result.taskId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.ok ? result.output : `The hive could not run this: ${result.error ?? "unknown error"}`,
          ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}),
        },
        finish_reason: finish,
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    },
    /**
     * What no other gateway can tell you: which bee answered, on which tier, and
     * what it actually cost. A zero here next to a real answer is the hive's
     * whole thesis — a tool match, or a prepaid seat inside its window.
     */
    x_hive: {
      task_id: result.taskId,
      tier: result.tierUsed,
      agent: result.agent ?? result.runtime,
      runtime: result.runtime,
      model: result.model,
      billing: result.billing,
      cost_usd: result.usage.costUsd,
      degraded: result.degraded,
      duration_ms: result.durationMs,
      ...(result.ok ? {} : { refused: result.error }),
    },
  };
}

/**
 * The same body, delivered as a stream of one content chunk.
 *
 * Honest rather than theatrical: the hive's adapters run one buffered call per
 * task and have no incremental output to forward (see the note in TaskProgress),
 * so slicing a finished answer into fake deltas would only imitate progress that
 * did not happen. Streaming is supported because clients set `stream: true` by
 * default and would otherwise fail; `/v1/models` says `streams_incrementally:
 * false` so nobody plans around it.
 */
function streamCompletion(res: Response, model: string, result: TaskResult): void {
  const full = completionBody(model, result);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const id = full.id;
  const created = full.created;
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );

  chunk({ role: "assistant" }, null);
  const message = full.choices[0].message;
  if (message.content) chunk({ content: message.content }, null);
  if (message.tool_calls) chunk({ tool_calls: message.tool_calls }, null);
  chunk({}, full.choices[0].finish_reason);
  // Usage and the hive block ride a final data frame before [DONE], the same
  // place OpenAI puts stream_options usage, so a streaming caller is not the
  // one client that cannot see what its request cost.
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: full.usage, x_hive: full.x_hive })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}
