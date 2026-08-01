# The four bees

A bee is a worker process that owns exactly **one tier**. The bee names are the
tier ladder, not a second taxonomy on top of it.

| Tier | Bee | What it is | Marginal cost | Needs |
|---|---|---|---|---|
| 1 | 🍯 **honey bee** | Official agent on a prepaid frontier seat (Claude Code on Claude Max, Codex on ChatGPT Pro) | ~0 inside the quota window | `claude` / `codex` on `PATH` |
| 2 | 💵 **metered bee** | A paid model over its provider API (OpenAI, Anthropic, Google), or an Ollama cloud plan | per-token — the true last resort | an API key |
| 3 | 🏠 **local bee** | Open-source agent on a local Ollama model | ~0 (local compute) | Ollama running |
| 3 | 🏡 **personal bee** | The user's agent over local personal data — email, files, calendar, notes | ~0, and never leaves the machine | Ollama, OpenClaw, or Hermes |
| 4 | 🐝 **worker bee** | Hardcoded tool, no LLM at all (parsers, converters, report generators) | free | nothing |

## 🍯 honey bee — tier 1

An official agent driven through its own CLI: `claude -p`, `codex exec`. It needs
**no API key** — Claude Code and Codex authenticate through their own CLI
sessions, which is exactly what makes them prepaid rather than per-token.

Its tokens meter against a [seat](/reference/glossary#seat) with a
[quota window](/reference/glossary#quota-window). Inside that window the marginal
cost is ~0, which is why the Queen reaches for it *before* the metered bee. When
the window empties, tasks either defer until it resets or degrade to a local
model — the customer's `policy.onBudgetBlock` decides which.

## 💵 metered bee — tier 2

A paid model called directly over its provider API. This is the only bee that
spends real dollars per call, and the Queen treats it accordingly: it is
dispatched **only** when the work is urgent, every prepaid seat is empty, and the
customer's USD cap allows it.

Set `HIVE_API_DRYRUN=1` to skip the network but still report realistic token
counts — the ledger, budget guard and USD cap then behave exactly as live, which
is what you want for re-running or recording a demo without spending.

## 🏠 local bee — tier 3

An open-source agent on a local Ollama model. Free, and — because it bills
`local` — allowed to serve [confidential](/reference/glossary#sensitivity) work.

Without OpenCode or OpenClaw installed it falls back to direct Ollama calls,
marked `ollama-direct`. That is expected, not an error.

## 🏡 personal bee — tier 3

The hive's door to data that lives on the user's own machine: email, files,
calendar, notes. It advertises the skills the planner tags personal work with
(`email`, `files`, `calendar`, `daily-report`, `personal`), and because it bills
`local` it is both dispatched ahead of any paid seat **and** permitted to serve
confidential tasks. Personal data never leaves the premises.

Three agents can drive it, and `agent:` names a **preference, not a pin** — the
named agent goes first, and if it is missing on this host the rest of the chain
still answers, with the substitution reported in the result's `runtime` rather
than hidden:

| Name | What it is |
|---|---|
| `hermes` | the `hermes` CLI (override the binary with `$HERMES_CMD`) |
| `openclaw` | a local OpenAI-compatible gateway at `$OPENCLAW_URL` |
| `personal-mini` | the built-in mini agent: a local Ollama model over a sandboxed view of `$PERSONAL_DATA_DIR` |

## 🐝 worker bee — tier 4

A hardcoded tool with no LLM at all. Deterministic, instant, and **free** — this
is the cheapest branch in the entire system.

A tier-4 match happens when a task's `toolInput` supplies every key a registered
tool requires. Reaching that branch more often is, in fact, what the Queen's
[learned memory](/guide/memory) is usually trying to do.

## Why each bee owns exactly one tier

Because it is what lets all of them share the embedded MQTT broker on one
machine. Aedes has no shared subscriptions, so it cannot split one task between
two workers bound to the same tier + skill — but bees with **disjoint** tiers
never contend, and every task has exactly one taker.

That is a constraint on *overlap*, not on worker count. Use the
[`amqp` backend](/guide/distributed) when you want several workers competing on
the same tier.

## Ability is agent × model

One more thing the table above understates: a bee's ability is the pair **agent
type × LLM model**, not the agent type alone. OpenCode on a local 8B and OpenCode
on a cloud frontier model are *different* capabilities with different costs, and
the hive treats them as such. See
[worker configuration](/reference/worker-config).
