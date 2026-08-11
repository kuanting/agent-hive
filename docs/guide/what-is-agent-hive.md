# What is Agent Hive?

A multi-AI-agent management system built for **token optimization**. Every design
choice — routing, budgets, the capability ladder, even how the Queen itself
thinks — exists to assign tasks to the most efficient worker that can do them and
drive the overall cost down.

Users chat with the **Queen**. She turns the conversation into tasks, scores each
one's difficulty, sets a budget, and dispatches it over a message broker to the
cheapest capability that can complete it. **Bees** execute, through a four-tier
capability ladder: prepaid frontier seats, per-token APIs, local Ollama models,
and hardcoded tools with no LLM at all.

## Optimization, not minimization

The metric is cost per **completed** task — and a task that never completes has
no cost per completed task. It has an undefined one, and in practice an unbounded
one, because the work still has to happen somewhere.

So completion is not a competing goal to be traded off against cost. It is the
denominator. Spend what the job takes, then make it cheaper. The cheapest token
is the one never spent.

## The commercial insight the whole ladder rests on

**Subscription seats are prepaid, so their marginal token cost is ~0 inside the
quota window.**

That single fact inverts what looks like the obvious ordering. A tier-1 honey bee
on a Claude Max seat is *cheaper per task* than a tier-2 metered bee on a
per-token API — despite being more capable. So the cost ranking, cheapest first,
runs:

> worker bees → local bees → Ollama cloud seat → frontier seat → per-token API

Per-token dollars get spent only when the work is urgent, every prepaid seat is
empty, and the customer's USD cap allows it.

This is why the hive ranks capabilities by their **billing** type rather than by
their tier number, and why "tier" in this system describes *composition*, not
cost. See [The capability ladder](/guide/capability-ladder).

## The planner proposes, the core disposes

The Queen's conversational layer is a **planner** that suggests structured tasks.
The deterministic router core still owns every tier, budget and confidentiality
decision.

That separation is a safety property, not tidiness. `TaskSpec` — the only thing a
planner can emit — has no tier field and no budget field. So a bad plan produces
a bad answer, never a bad bill.

The planner also runs on a small local model by default and escalates only for
complex requests, which means the Queen's own reasoning follows the same cost
ladder as the workers'. The brain never becomes a hidden cost center; its spend
shows up in `/status` as `plannerCostUsd` alongside everyone else's.

## The hive manages agents you harnessed, not models it found

A bee advertises the agents named in its config and nothing else. An agent is
something you installed and configured, so the hive never invents capabilities on
your behalf:

```yaml
capabilities:
  - agent: hermes         # what to call it, everywhere in the hive
    runtime: personal     # which adapter drives it
    model: gemma4:12b     # what that agent runs
    tier: 3
    billing: local
    skills: [email, files, calendar]
```

Bees auto-register and advertise only what they can actually run. At startup, a
configured capability whose CLI, API key or model is missing is dropped with the
reason; one that will run but degrade is kept and flagged. Nothing is advertised
that would fail on dispatch — so the same configs work on a fully-equipped laptop
and a bare one.

What the machine merely *could* run — every installed Ollama model, which binaries
are on `PATH` — is reported separately for the console's Setup view. So
`ollama pull` changes what you're offered, never what the hive promises.

## The hive writes down what it did, so work can stop costing anything

Every settled task and every planner turn goes into a local
[usage corpus](/reference/usage-corpus) — which capability ran the work, what it
cost, how many attempts it took, and, when a caller supplies tools, which tools
the model asked for in what order.

That record exists to be read back. `npm run breed` shows which procedures a
caller repeats and what they cost; somebody writes the deterministic tool that
does one of them; the work drops to tier 4 and costs nothing from then on. That
loop is the [breeding](/guide/breeding) idea, and it is the one optimization that
compounds — every other rung of the ladder makes a token cheaper, this one stops
spending it.

## Decentralized on purpose

There is no central proxy in front of every model call. The Queen works at task
granularity; the broker carries only small control and task messages; model calls
happen at the edge, inside each worker.

A single proxy would be a bottleneck, a single point of failure, and a privacy
chokepoint. Central budget control without central execution is the trade: the
Queen sets budgets, workers spend autonomously against a
[lease](/reference/glossary#lease).

## Where to go next

- [The four bees](/guide/bees) — who does the work.
- [Prerequisites](/guide/prerequisites) — what you need installed (spoiler: Node).
- [Getting started](/guide/getting-started) — a running hive in three commands.
- [Finding work a program could do](/guide/breeding) — the breeding loop, end to end.
- [The design document](/DESIGN) — the full architecture, at length.
