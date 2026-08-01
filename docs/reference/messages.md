# Message protocol

Every payload on the wire is JSON, validated against a zod schema in
`packages/shared/src/messages.ts`. That file is the contract layer: the Queen and
the bees agree on nothing else.

This page is the **shapes**. For the topology — which exchange carries what, how
the two broker backends differ, and why — see
[§4 Message protocol](/DESIGN#_4-message-protocol) in the design document.

The schemas below are embedded from the source file at build time, comments
included, so they cannot drift from what the code actually validates.

## Exchanges

| Exchange | Routing keys | Messages |
|---|---|---|
| `hive.tasks` | `tasks.t<tier>.<skill>`, `tasks.t4.<toolId>`, `tasks.direct.<agentId>` | `TaskMessage` |
| `hive.control` | `agent.hello`, `agent.goodbye`, `agent.heartbeat`, `queen.rollcall*`, `queen.shutdown`, `budget.request.*`, `budget.grant.*` | `AgentHello`, `AgentGoodbye`, `AgentHeartbeat`, `QueenRollcall`, `QueenShutdown`, `BudgetRequest`, `BudgetGrant` |
| `hive.telemetry` | `task.result.*`, `telemetry.usage.*`, `task.progress.*`, `agent.log.*` | `TaskResult`, `UsageReport`, `TaskProgress`, `AgentLog` |

## `(taskId, attempt)` identifies one execution

Not `taskId` alone — and every dedup in the hive keys on the pair. The
distinction is the whole point:

- A duplicate carrying the **same** attempt is the transport delivering twice.
  It must never re-run the work.
- A **new** attempt is the Queen deliberately paying for a retry.

Without the pair, a late result from a superseded attempt is indistinguishable
from the live one, and the Queen would re-dispatch a task that has already
finished. Workers replay a stored result rather than re-executing
(`packages/worker/src/gate.ts`), and the Queen ignores results for an unknown
task, an already-terminal task, or a superseded attempt — checked *before* the
ledger is touched, since those writes are what a duplicate used to double-charge.

---

## `TaskSpec`

What you submit. The only schema a caller of
[`POST /tasks`](/reference/http-api#post-tasks) needs.

<<< @/../packages/shared/src/messages.ts#taskspec{ts}

Note what is **not** here: no tier, no budget, no model. Those are the Queen's to
compute, and their absence is a security property rather than an omission — it is
why a bad plan can produce a bad answer but never a bad bill.

## `TaskEnvelope`

The Queen's routing and budget decision, attached to every dispatch.

<<< @/../packages/shared/src/messages.ts#taskenvelope{ts}

## `TaskMessage`

What actually goes on the `hive.tasks` exchange: the spec, the envelope, the
difficulty score, and the retry context when there is one.

<<< @/../packages/shared/src/messages.ts#taskmessage{ts}

## `TaskResult`

What a bee publishes when it is done — including when it failed.

<<< @/../packages/shared/src/messages.ts#taskresult{ts}

The `agent` / `runtime` pair is worth reading twice. `agent` is the configured
capability that *owned* the dispatch; `runtime` is what actually executed. So
`agent !== runtime` is precisely a fallback — the bee reached for one thing and
ran another — and keeping both is what lets the console say so instead of quietly
showing whichever is handy.

## `TaskProgress`

Liveness, and nothing else.

<<< @/../packages/shared/src/messages.ts#taskprogress{ts}

## `AgentLog`

One narration line from a bee.

<<< @/../packages/shared/src/messages.ts#agentlog{ts}

::: danger `text` never carries content
Identifiers and decisions only — never `spec.input`, never `result.output`, never
prompt text. This is not a style preference. The hive's confidentiality promise
is that work marked confidential stays on the machine that ran it; a log line
echoing the prompt would publish exactly that content to the broker and on into a
browser tab, defeating the guarantee from the side nobody is watching.

`packages/queen/test/log-privacy.test.ts` fences the rule with a source scan of
every narration call site, so this is enforced rather than merely intended.
:::

## Control and telemetry

The remaining schemas — `AgentHello`, `AgentHeartbeat`, `AgentGoodbye`,
`QueenRollcall`, `QueenShutdown`, `BudgetRequest`, `BudgetGrant`, `UsageReport` —
live in the same file and carry their rationale in their own doc comments. Three
are worth knowing about by name:

- **`QueenRollcall`** — "who is out there?". Registration used to be push-only
  and lossy: a bee published `agent.hello` and hoped. A publish to a topic nobody
  has subscribed to yet is dropped silently, so a hello sent before the Queen's
  control consumer was up simply vanished, and the bee idled forever, invisible.
  A question closes the race that repetition only made less likely.
- **`QueenShutdown`** — an *order*, never an inference. A Queen that dies or
  restarts must leave its bees running; only an explicit request publishes this.
- **`AgentGoodbye`** — a bee's last word, carrying `drained` (tasks finished
  after being told to stop) and `abandoned` (in-flight work dropped because the
  drain cap expired first). It lets the Queen tell "shut down as asked" from
  "vanished".

::: details The full contract file
<<< @/../packages/shared/src/messages.ts{ts}
:::
