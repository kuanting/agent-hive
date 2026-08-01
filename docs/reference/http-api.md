# HTTP API

Everything outside the hive talks to the Queen over this API. Workers do not —
bees reach the Queen over the message broker and never call an HTTP endpoint, so
nothing here is on the data plane.

## Before anything else: this API is unauthenticated

The Queen binds **loopback only** by default (`QUEEN_HOST=127.0.0.1`,
`QUEEN_PORT=4100`), and that is not a development convenience — it is the
authorization model. There is no user authentication yet, so *locality* is what
stands in for it: admin capability stops at the hive's own host.

What that protects, concretely:

- `GET /status` returns **every task's title and `input`**, confidential ones
  included.
- `POST /chat` spends the customer's budget.
- `POST /shutdown` stops the entire fleet, across every machine.

Setting `QUEEN_HOST=0.0.0.0` puts all of that on the network. The Queen prints a
warning at startup when you do, and it means what it says. See
[Roles: admins operate the hive, users give it jobs](/DESIGN#_1-goals-and-non-goals).

Request bodies are JSON, capped at **256 kB** (`express.json({ limit: "256kb" })`).
Large inputs belong in the artifact store and travel by reference — that is what
`TaskSpec.artifacts` is for.

## Endpoints at a glance

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/tasks` | Submit one structured task |
| `GET` | `/tasks/:id` | Read a task's state |
| `GET` | `/status` | Bees, budgets, seat windows, planner spend |
| `POST` | `/chat` | Talk to the Queen (SSE stream) |
| `GET` | `/sessions/:id` | Read a chat session |
| `GET` | `/events` | The whole hive's live narration (SSE) |
| `POST` | `/shutdown` | Stop the fleet — loopback only |

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
