# Glossary

Agent Hive uses a lot of vocabulary it made up. This is all of it, in one place.

## The bees

### honey bee 🍯 {#honey-bee}
Tier 1. An official agent running on a **prepaid frontier seat** — Claude Code on
Claude Max, Codex on ChatGPT Pro. Marginal cost inside the quota window is ~0,
which is why it is dispatched *ahead of* the more-expensive-sounding metered bee.
Needs `claude` or `codex` on `PATH`, logged in. No API key.

### metered bee 💵 {#metered-bee}
Tier 2. A paid model over its provider API (OpenAI, Anthropic, Google), or an
Ollama cloud plan. **Per-token, and the true last resort.** Reached only when the
work is urgent, every prepaid seat is empty, and the customer's USD cap allows it.

### local bee 🏠 {#local-bee}
Tier 3. An open-source agent on a local Ollama model. Free (local compute), and
allowed to serve confidential work.

### personal bee 🏡 {#personal-bee}
Tier 3. The user's own agent over **local personal data** — email, files,
calendar, notes. Free, and none of it leaves the machine. Runs through Hermes,
an OpenClaw gateway, or the built-in mini agent over a sandboxed view of
`PERSONAL_DATA_DIR`.

### worker bee 🐝 {#worker-bee}
Tier 4. A **hardcoded tool with no LLM at all** — parsers, converters, report
generators. Free, deterministic, and the cheapest branch in the system.

---

## Routing

### tier {#tier}
`1`–`4`. Describes **composition, not cost**: which kind of agent is paired with
which kind of model. Tier 1 is an official agent on a paid frontier model; tier 4
is a tool with no model. The Queen ranks by [billing](#billing), not by tier.

### billing {#billing}
`subscription` | `per-token` | `local` | `free`. What determines **real marginal
cost**, independent of tier. This is the field the cost ranking sorts on, and the
field the confidentiality gate reads.

### capability {#capability}
The pair **agent × model** — not the agent alone. OpenCode on a local 8B and
OpenCode on a cloud frontier model are different capabilities with different
costs. Declared in a [worker config](/reference/worker-config).

### skill tag {#skill-tag}
A free-form string on both a task and a capability (`writing`, `reporting`,
`email`). The Queen routes a task onto a skill the chosen worker actually binds.

### difficulty {#difficulty}
`simple` | `standard` | `complex`. Scored deterministically by the analyzer, and
it decides which tiers are *adequate* — simple work may go anywhere, complex work
only to tiers 1 and 2.

### sensitivity {#sensitivity}
`normal` | `confidential`. Grounded in the user's own words and **only ever
raised**, never lowered: a caller's explicit `confidential` is never cleared, and
a request that reads as confidential is upgraded even when it was sent as normal.
Confidential work may run only on `local` or `free` capabilities.

### urgency {#urgency}
`normal` | `urgent`. The lever that unlocks per-token spend. Non-urgent tasks
defer until a prepaid window resets rather than paying retail.

### degrade vs. wait {#degrade-vs-wait}
The two answers to "every adequate capability is blocked on budget", chosen per
customer by `policy.onBudgetBlock`. **`wait`** holds the task for a seat window
to reset (full quality, higher latency); **`degrade`** runs it now on a local
model and marks the result `degraded`.

### deferred {#deferred}
A task status, and **not an error**. It means every capability that could serve
it is inside an exhausted quota window and the policy says wait. It will run.

### pinned task {#pinned-task}
A task carrying `pinnedAgentId`, dispatched to one named bee through a direct
queue instead of the tier queues. Used for site-bound work. Because direct queues
bypass the tier queues — which is where the confidentiality gate lives — a pin is
separately checked against the same rule before it is honored.

---

## Money

### dual currency {#dual-currency}
The budget has two units that do not convert into each other: **USD** (a hard
per-customer cap on per-token spend) and **seat quota tokens** (prepaid, refilled
per window, worthless outside it). Optimizing means spending the second before
ever touching the first.

### seat {#seat}
A prepaid subscription slot, e.g. a Claude Max seat. Global infrastructure keyed
by `seatId` across the whole ledger — a customer profile *declares* one, it does
not scope it, and declaration is first-write-wins.

### quota window {#quota-window}
A seat's refill period: `windowSeconds` and `tokensPerWindow`. Exhausting it
makes the seat unavailable until it resets, which is what causes deferral.

### lease {#lease}
A time-boxed budget grant from the Queen to a bee (`BudgetGrant`): a USD
allowance, a token share, and a period. It is what lets workers spend
autonomously without the Queen being in the path of every model call.

### wallet {#wallet}
A bee's local view of its lease. `packages/worker/src/wallet.ts`.

### budget guard {#budget-guard}
The worker-side check that refuses a model call which would cost more than the
task's cap allows. The refusal costs nothing, because the call never happens.

### result cache {#result-cache}
A keyed store of finished results. A repeat request is served from it without any
dispatch at all — the cheapest possible outcome. The key is computed *after*
sensitivity grounding, so the upgrade cannot be undone by a lookup.

---

## The Queen's brain

### planner {#planner}
The conversational layer. It turns a message into a proposed set of structured
tasks. **The planner proposes, the core disposes**: every tier, budget and
confidentiality decision still belongs to the deterministic router.

### plan guide {#plan-guide}
Hand-authored markdown, checked in: `customers/plan-guide.md` (house) and
`customers/<id>.plan-guide.md` (overlay). House conventions for *how to
decompose* a request. Advice, never authority.

### learned memory {#learned-memory}
One lesson per file under `data/memory/<customerId>/`, written by the Queen
itself. Reaches the planner's prompt and nothing else.

### detector {#detector}
One of five deterministic checks run at the end of a plan, looking for something
worth remembering: a tool the plan should have matched, a skill tag no worker
advertises, a stalled DAG, a plan that needed retries, a clean multi-step plan
worth reusing. **If none fires, no model is called and the turn costs nothing
extra.**

### trust decay {#trust-decay}
How a memory keeps earning its place. Detector ids are stable, so if a note was
recalled and the same detector fires anyway, the planner was told and ignored it.
That memory's trust falls, it sinks in the ranking, and after three strikes it is
retired — kept on disk for the record, but no longer paid for in prompt budget.

### escalation {#escalation}
Two different things share the word. The **planner** escalates from the small
local brain to a stronger `plannerModel` for complex requests. A **task**
escalates from a failed lower tier to a higher one, carrying a failure summary
and the prior attempt's output by reference.

### session pin / session affinity {#session-affinity}
`TaskSpec.continues` asks that a follow-up resume the same runtime session on the
same bee rather than starting cold. It is a **request, not an instruction**: the
Queen honors it only if the predecessor's bee is still live, still holds the
session, and is allowed to run work at this sensitivity. Nothing fails when it is
refused — the task just runs cold.

### episode {#episode}
A record of a settled task, or of a planner turn, written to the usage corpus at
`data/episodes/episodes.db`. Controlled per customer by `policy.recordEpisodes`
(`off` | `metadata` | `tasks` | `full`). The corpus is queryable — see DESIGN §7.

---

## Plumbing

### the hive log {#hive-log}
The Queen's narration ring buffer, served over
[`GET /events`](/reference/http-api#get-events) and read by the console's
Activity view. Every line carries identifiers and decisions, **never** prompt or
output text.

### artifact / artifact store {#artifact}
Content too large for a broker message, written to disk and passed **by
reference**. Keeps wire messages and prompts small.

### preflight {#preflight}
A bee's startup check of each configured capability against the machine it is on.
Missing CLI, key or model → dropped with a reason. Will-run-but-degraded → kept
and flagged. So nothing is advertised that would fail on dispatch.

### direct queue {#direct-queue}
`tasks.direct.<agentId>` — the routing path for [pinned tasks](#pinned-task),
bypassing the tier queues.

### `(taskId, attempt)` {#task-id-attempt}
The pair that identifies **one execution**. A duplicate with the same attempt is
the transport repeating itself and must never re-run work; a new attempt is the
Queen deliberately paying for a retry.

### lightweight mode {#lightweight-mode}
`HIVE_BROKER=mqtt` — the embedded Aedes broker, one machine, no Docker. Trades
broker delivery guarantees for zero setup: it acks on receipt, so the Queen's own
reaper covers lost dispatches and dead bees. Must be asked for by name.

### bindGeneral {#bind-general}
Whether a bee also binds its tier's `general` fan-in queue. Set `false` for a bee
sharing a tier with another bee but owning a disjoint skill set — Aedes has no
shared subscriptions, so both would otherwise receive and execute the same task.
