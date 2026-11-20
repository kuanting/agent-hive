# HTTP API

Everything outside the hive talks to the Queen over this API. Workers do not —
bees reach the Queen over the message broker and never call an HTTP endpoint, so
nothing here is on the data plane.

## Before anything else: which routes are guarded {#which-routes-are-guarded}

**Every route takes a bearer key except `/events`, which cannot.**

`HIVE_API_KEYS` maps a token to a customer and a user, comma- or
newline-separated:

```bash
HIVE_API_KEYS=sk-lab-kt:aiotlab:kt,sk-lab-mei:aiotlab:mei
```

`/events` is the exception because the console reads it through `EventSource`,
which cannot send an `Authorization` header at all. The feed carries identifiers
and decisions and never prompt or output text — a property a test enforces across
every call site — so what it exposes is which tasks exist, not what anyone asked.

### A key that calls for other people {#gateway-keys}

The third field is normally a person's name. Set it to `@gateway` instead and the
key becomes a **front end acting for many people**, naming which one per request:

```bash
HIVE_API_KEYS=sk-owui:aiotlab:@gateway
```

```bash
curl -s localhost:4100/v1/chat/completions \
  -H 'authorization: Bearer sk-owui' \
  -H 'x-openwebui-user-id: ada' \
  -H 'content-type: application/json' \
  -d '{"model":"hive/auto","messages":[{"role":"user","content":"hi"}]}'
```

This exists because a front end holds exactly one upstream credential — Open WebUI
has one key per connection — so without it every one of its users would spend, and
be recorded, as the same person. See [Open WebUI](/guide/open-webui).

The header name is `HIVE_USER_HEADER`, defaulting to Open WebUI's own
`x-openwebui-user-id`. Three things about it are deliberate:

- **A key must be marked `@gateway` to assert an identity.** It is a trust
  decision, and a trust decision should not be something an operator discovers.
- **A named key ignores the header entirely.** The header is read inside the
  gateway branch and nowhere else, so a named key is structurally incapable of
  claiming to be someone else — not a check that could be forgotten, but a value
  that is never fetched.
- **A gateway request that names nobody is refused**, with `400
  user_header_required` on `/v1/chat/completions`, naming the setting that fixes
  it. `/v1/models` has no spend to attribute and does not care. An
  `unattributed` bucket would have been easier and is how usage tracking rots: it
  looks like it is working, and by the time anyone reads the report the
  misconfiguration is months old.

The asserted id is bounded to 64 characters and passed through an allowlist —
it becomes a key in the budget ledger and a column in the corpus, and it arrives
over the network: trusted to be *from* the gateway, not trusted to be shaped like
anything.

```bash
curl -s localhost:4100/v1/models -H 'authorization: Bearer sk-lab-kt'
```

A bad or missing token gets `401` in OpenAI's error shape, because the clients on
the other side already know how to surface that. Leave the variable unset and the
gate is open — which is what keeps `npm run solo` working with no configuration
— and the Queen says so at startup rather than implying more.

That gate exists because an OpenAI-compatible endpoint has to be reachable by
other machines to be worth anything, so *locality* stops working as a substitute
for authorization. `customerId` is already the hive's unit of budget and memory,
so identity lands exactly where spending is accounted rather than beside it.

**Keys identify, attribute and scope a caller's own work — they still do not
isolate people from each other.** What a key now buys: the customer on every
intake route comes from the key rather than from the request body, so no caller
can name whose budget to spend; and `GET /tasks/:id` and `GET /sessions/:id`
return `404` to anyone but the person who submitted them, since a transcript
should not be readable by whoever guesses an eight-hex id.

What it still does not buy: `/status` returns every task's `title` and `input` to
any key holder, artifacts are a flat shared directory with no per-task ACL, and
seats are global and first-write-wins — one caller can drain a prepaid window
everyone else is queued behind. **If your users are not colleagues, do not give
them the console and do not expose the Queen**; put a front end in front of it
instead and keep `QUEEN_HOST` on loopback. See [Open WebUI](/guide/open-webui) and
[§10 Known gaps](/DESIGN#_10-known-gaps).

For everything the keys do not cover, **locality is still the authorization
model**. The Queen binds loopback by default (`QUEEN_HOST=127.0.0.1`,
`QUEEN_PORT=4100`), and `POST /shutdown` refuses anything else outright. Setting
`QUEEN_HOST=0.0.0.0` puts the ungated routes on the network — the Queen prints a
warning at startup when you do, and it means what it says. See
[Roles: admins operate the hive, users give it jobs](/DESIGN#_1-goals-and-non-goals).

Request bodies are JSON, capped by `HIVE_MAX_BODY` (default **4 MB**). Large
inputs belong in the artifact store and travel by reference — that is what
`TaskSpec.artifacts` is for.

## Endpoints at a glance

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/tasks` | key | Submit one structured task |
| `GET` | `/tasks/:id` | key, own | Read a task's state |
| `GET` | `/status` | key | Bees, budgets, seat windows, planner spend |
| `POST` | `/chat` | key | Talk to the Queen (SSE stream) |
| `GET` | `/sessions/:id` | key, own | Read a chat session |
| `GET` | `/events` | — | The whole hive's live narration (SSE) |
| `GET` | `/v1/models` | key | What this hive is serving right now |
| `POST` | `/v1/chat/completions` | key | The hive as an OpenAI-compatible LLM |
| `POST` | `/shutdown` | loopback | Stop the fleet |

"own" means the caller who submitted it; anyone else gets `404` rather than `403`,
so a response never confirms that an id exists.

---

## `POST /tasks`

The structured intake path. The body is a [`TaskSpec`](/reference/messages#taskspec);
the Queen scores its difficulty, picks the cheapest adequate tier, sets a budget,
and dispatches — then returns immediately. It does **not** wait for the result.

```bash
curl -s localhost:4100/tasks \
  -H 'content-type: application/json' \
  -d '{
    "customerId": "aiotlab",
    "title": "Tagline for the edge-AI sensor demo",
    "input": "Write a one-line tagline for the lab edge-AI sensor demo.",
    "skills": ["writing"]
  }'
```

**`202 Accepted`** — dispatched:

```json
{
  "taskId": "9f3c1a2b",
  "status": "dispatched",
  "difficulty": "simple",
  "reason": "tier 3 local bee · gemma4:12b"
}
```

`status` is one of `dispatched`, `deferred`, `done`, `failed`. **`deferred` is
not an error** — it means every seat that could do the job is inside an exhausted
quota window and the customer's policy says `wait` rather than `degrade`. The
task will run when the window resets.

**`200 OK`** — served from the result cache. This is the case worth noticing,
because it is the cheapest possible outcome: the task never reaches a bee and
costs zero tokens.

```json
{
  "taskId": "1d7e04ba",
  "status": "done",
  "difficulty": "simple",
  "reason": "cache hit",
  "cached": true,
  "result": { "ok": true, "output": "…", "usage": { "costUsd": 0 }, "…": "…" }
}
```

Note the status code differs: `202` for work that was dispatched, `200` for work
that was already done. `cached: true` is present only on the second.

**`400 Bad Request`** — the body failed `TaskSpec` validation. The `error` field
is zod's `flatten()` output, so it names the offending fields:

```json
{ "error": { "formErrors": [], "fieldErrors": { "customerId": ["Required"] } } }
```

### Sensitivity is grounded, not just accepted

`sensitivity` can only ever be *raised* by the hive, never lowered. If the title
or input reads as confidential ("summarize my inbox") the Queen upgrades the task
to `confidential` even when the caller sent `normal`. A caller's explicit
`confidential` label is never cleared. The cache key is computed *after* that
upgrade, so the grounding cannot be undone by a lookup.

---

## `GET /tasks/:id`

Returns the full `TaskState`: the spec as stored, the routing decision and its
reason, the attempt history, and — once a bee has picked it up — which bee is
running it.

```json
{
  "taskId": "9f3c1a2b",
  "status": "done",
  "difficulty": "simple",
  "attempts": 1,
  "deferrals": 0,
  "reason": "tier 3 local bee · gemma4:12b",
  "startedAt": 1754043600000,
  "dispatchedAt": 1754043600120,
  "finishedAt": 1754043612880,
  "runningOn": { "agentId": "local-bee-1", "tier": 3, "runtime": "ollama", "model": "gemma4:12b" },
  "result": { "…": "…" },
  "history": ["…"]
}
```

Two fields repay attention:

- **`history`** holds every execution oldest-first, including the failed ones
  that `result` overwrote. "Failed at tier 3, then succeeded at tier 1" only
  exists here — `result` alone erases exactly the transition worth learning from.
- **`lastProgressAt`** is the bee's last liveness tick. Its absence means the
  task has not started running; a stale value is how the Queen distinguishes a
  slow task from a dead one.

**`404`** → `{"error":"unknown task"}`.

---

## `GET /status`

The operator view of the whole hive.

```json
{
  "workers": [{ "agentId": "local-bee-1", "site": "lab", "capabilities": ["…"], "lastSeen": 1754043611000 }],
  "budget": { "aiotlab": { "spentUsd": 0.42, "capUsd": 25, "seats": { "…": "…" } } },
  "plannerCostUsd": 0.0031,
  "tasks": [{ "taskId": "9f3c1a2b", "status": "done", "tierUsed": 3, "…": "…" }],
  "memory": { "…": "…" }
}
```

`plannerCostUsd` is there on purpose: the Queen's own reasoning is metered
alongside the workers', so the brain can never become a hidden cost center.

The `memory` section is contributed by the planner rather than the core, through
`registerStatusSection`. That keeps the two halves separate — memory belongs to
the brain, and the deterministic authority stays unaware of it. A contributed
section that throws is dropped silently; it must never be able to break `/status`.

::: warning `/status` returns task inputs
`tasks[].input` is the user's own prompt text, for every task including
confidential ones. This is the single strongest reason the Queen binds loopback.
:::

---

## `POST /chat`

The conversational surface. One request carries one user message; the response is
a **Server-Sent Events stream** covering the entire turn — the planner's
decision, any clarifying question, live task cards as bees run, and the final
synthesized answer.

```jsonc
// request body
{
  "message": "Summarize last week's sensor logs and draft a status note.",
  "customerId": "aiotlab",   // optional; defaults to the first configured customer
  "sessionId": "…"           // optional; omit to start a new session
}
```

The first event is always the session id, so a client that omitted `sessionId`
learns the one it was given:

```
data: {"type":"session","sessionId":"c1a9…"}
data: {"type":"plan","steps":[…]}
data: {"type":"task","taskId":"9f3c1a2b","state":"running","tier":3,…}
data: {"type":"answer","text":"…"}
data: {"type":"done"}
```

A failed turn ends with `{"type":"error","message":"…"}` (truncated to 300
characters) instead of `done`. Either way the stream is closed by the server.

**`400`** → `{"error":"message required"}` when `message` is empty or absent.

### Why this is a POST and `/events` is a GET

`/chat` carries a body, so it must be a POST — which means a browser cannot use
`EventSource` for it, and the console hand-rolls a stream reader instead. That
tradeoff is deliberate and it does not apply to `/events`; see below.

---

## `GET /sessions/:id`

Returns the stored session: its turns, its customer, and what the planner is
carrying forward. **`404`** → `{"error":"unknown session"}`.

---

## `GET /events`

The hive's live narration — the same content as the terminal the Queen is running
in, which is what the console's **Activity** view reads.

```bash
curl -N 'localhost:4100/events?level=debug'
```

`?level=` takes `debug`, `info`, `warn` or `error` and defaults to `info`. An
unparseable value falls back to `info` rather than erroring.

This one is a **GET**, and the reason is worth stating: a feed has no body to
send, so making it a GET buys the browser's own `EventSource` client and with it
**automatic reconnection**. That is exactly what a debug view wants — leave the
tab open, restart the Queen, and the feed picks itself back up.

Reconnection is why every entry carries a **`seq`**. On connect the Queen replays
a bounded ring buffer (`HIVE_LOG_BUFFER`, default 500) so a freshly-opened tab is
not blank, and the client discards the seqs it already holds. Replay is bounded
by the ring, so it can never become a firehose.

Idle connections get a `: ping` comment frame every 25 seconds — a quiet hive is
the normal case here, so an idle-timeout disconnect would be the common failure,
not the rare one. The response also sets `X-Accel-Buffering: no`, because a proxy
that buffers defeats the entire point.

::: info Log lines never carry content
Every entry holds identifiers and decisions — never prompt text, never task
output. Confidentiality is a promise about *where work runs*, and narration must
not become the side door out of it. A test enforces this across every call site.
:::

Scope note: this stream is the whole hive, not one customer's slice. It is an
operator surface with the same audience as the Queen's terminal, which is why it
needs no narrowing the terminal doesn't already have.

---

## `GET /v1/models`

What this hive is serving **right now** — the live fleet, not the configuration.

```json
{
  "object": "list",
  "data": [
    { "id": "hive/auto", "object": "model", "owned_by": "agent-hive",
      "hive": { "description": "The Queen: scores the request, then routes it…", "supports_tools": false } },
    { "id": "hive/gemma4-12b", "object": "model", "owned_by": "agent-hive",
      "hive": { "tier": 3, "billing": "local", "agent": "opencode", "runtime": "ollama-agent",
                "model": "gemma4:12b", "skills": ["writing"], "supports_tools": true,
                "search": false, "streams_incrementally": false } }
  ]
}
```

Ids come from the same `agentLabel` the console shows on a task card, so a caller
that picks `hive/gemini-search` can find its own request in the Activity feed
without a translation table. Two records that share an agent *and* a model still
differ by seat, so the seat (then a skill, then position) is appended until the
ids are distinct — a model id has to identify exactly one capability or naming one
means nothing.

The `hive` block is advertised rather than discovered by failing:

- **`supports_tools`** — `claude-code` and `codex` execute tools themselves and
  return prose, so they can never answer a turn in someone else's loop.
- **`streams_incrementally`** — always `false` today. `claude -p` is a buffered
  subprocess; slicing a finished answer into fake deltas would imitate progress
  that did not happen.

**Tier-4 tools are not listed.** A tool is reached by `matchTool` on the strength
of `spec.toolInput`, which a chat completion does not carry, so naming one could
never work. The listing used to advertise them and a caller who took it at its
word got `no capability is adequate`; advertising less is the honest failure
mode. See [what does not close yet](/guide/breeding#what-does-not-close-yet).

---

## `POST /v1/chat/completions`

The hive as an LLM. Point any OpenAI client's base URL at `/v1` and hand over
work.

```bash
curl -s localhost:4100/v1/chat/completions \
  -H 'authorization: Bearer sk-lab-kt' \
  -H 'content-type: application/json' \
  -d '{"model":"hive/auto","messages":[{"role":"user","content":"Price for LM358N"}]}'
```

The statelessness is doing architectural work rather than being merely familiar:
the caller re-sends its transcript every turn, so the caller owns conversation,
memory and workflow *because the protocol leaves it nowhere else to put them*,
and the hive is left owning dispatch, routing, budgets and confidentiality.

Nothing here executes anything of its own. Every request goes through
`core.submitTask` and `core.awaitResult` — the same two calls the planner uses —
so routing, the ledger, the result cache, retries and the confidentiality gate
all apply exactly as they do to any other task.

| Field | Effect |
|---|---|
| `model` | `hive/auto` lets the Queen choose. Any other id is a **hard requirement**, not a hint: the worker may not substitute. |
| `messages` | Forwarded as a passthrough turn — the bee gets your prompt, not the hive's worker-bee framing. |
| `tools` / `tool_choice` | Only capabilities advertising `supports_tools` may serve these. |
| `temperature`, `max_tokens` / `max_completion_tokens` | Passed through. |
| `stream` | Supported; see below. |
| `user` | Recorded as a hash, for attribution and for telling one agent loop from another. Nothing routes on it. |

Two refusals happen **before** any spend:

- **`404 model_not_found`** — the id is not in `/v1/models`.
- **`400 tools_unsupported`** — you sent `tools` and no live capability can
  answer with tool calls. Dispatching anyway would reach an agent that
  helpfully does the work itself and returns prose, which answers a question you
  did not ask. With `hive/auto`, the request is narrowed to the tool-capable
  bees instead of refused.

The response is an ordinary `chat.completion`, plus one block no other gateway
can give you:

```json
"x_hive": {
  "task_id": "9f3c1a2b", "tier": 4, "agent": "tool", "runtime": "tool:digikey-price",
  "billing": "free", "cost_usd": 0, "degraded": false, "duration_ms": 12
}
```

A zero there next to a real answer is the hive's whole thesis — a tool match, or
a prepaid seat inside its window.

With `stream: true` you get the same body as a short SSE sequence: role, content,
any tool calls, the finish reason, then a final frame carrying `usage` and
`x_hive` before `[DONE]`. That is where OpenAI puts `stream_options` usage, so a
streaming caller is not the one client that cannot see what its request cost.

Every turn is routed cold — there is no session affinity on this path, and the
reasons it is a design question rather than a missing wire are in
[§10 Known gaps](/DESIGN#_10-known-gaps).

---

## `POST /shutdown`

Stops the entire fleet, across every machine. The only route in the hive that can
affect other hosts, and the only one that is guarded.

```bash
curl -s localhost:4100/shutdown \
  -H 'content-type: application/json' \
  -d '{"confirm":"shutdown","reason":"end of demo"}'
```

Two cheap gates rather than an auth system — authentication is an explicit
non-goal for the PoC (see [§1](/DESIGN#_1-goals-and-non-goals)):

1. **Loopback only.** A request from anywhere else gets
   `403 {"error":"shutdown is loopback-only","from":"…"}`. A fleet is spread
   across a network; this route must not be reachable from it.
2. **An explicit confirm field.** Without `{"confirm":"shutdown"}` you get
   `400 {"error":"send {\"confirm\":\"shutdown\"} to stop the hive"}`. No stray
   `curl`, browser preflight, or link prefetch can trip it by accident.

`reason` is optional and truncated to 200 characters. It is shown in each bee's
log, so the reason survives into terminals that outlive the hive.

The Queen answers **before** exiting — the caller is about to lose the server it
is talking to, and "connection reset" is a poor way to learn that it worked:

```json
{ "stopped": true, "beesAsked": 5, "drained": 1, "…": "…" }
```

::: tip Prefer `npm run stop`
`npm run stop` shows you what will stop, tells you whether a task is in flight,
and asks before doing it. The console has no shutdown button at all, deliberately:
a user should be able to give the hive jobs, not stop other people's. See
[Stopping and resetting](/guide/stopping).
:::

### What does *not* stop the hive

The Queen's own `SIGINT`. Restarting the control plane leaves the fleet running,
by design — bees are autonomous consumers, usually on other hosts, and an
operator restarting the Queen should not lose a fleet. Nothing infers a shutdown
from the Queen's absence; only this explicit request causes one.
