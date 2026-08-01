# The capability ladder

The hive organizes every capability into a four-tier ladder and always reaches
for the cheapest rung that is still adequate.

## Cost and capability are separate axes

This is the idea the whole router rests on, and it is easy to skim past.

**Tier** describes *composition*: which kind of agent is paired with which kind
of model. **Billing** describes *cost*. They are not the same ordering, and the
Queen ranks by billing.

| Tier | Composition | Typical billing |
|---|---|---|
| 1 | Official agent + paid frontier model | `subscription` |
| 2 | Paid model, per call | `per-token`, or `subscription` for an Ollama cloud plan |
| 3 | Open-source agent + local model | `local` (~0) |
| 4 | Hardcoded tool, no LLM | `free` |

Because subscription seats are prepaid, their marginal token cost inside the
quota window is ~0. So the cost ranking, cheapest first, is:

> **free tools → local models → Ollama cloud seat → frontier seat → per-token API**

Tier 1 sits *ahead of* tier 2. Per-token is the true last resort.

For complex tasks the frontier seat outranks the mid seat, because both are
prepaid — at equal cost class, capability wins.

## Which tiers are adequate

Difficulty is scored deterministically, and it decides which rungs are even
eligible:

| Difficulty | Adequate tiers |
|---|---|
| `simple` | 4, 3, 2, 1 |
| `standard` | 3, 2, 1 |
| `complex` | 1, 2 |

A simple task can be served by a tier-4 tool for free. A complex one cannot be
served locally at all — so the ladder for it starts at the prepaid seat.

## Confidentiality is a gate, not a preference

```ts
/** Confidential work never leaves the premises. */
export function allowedByConfidentiality(cap, sensitivity) {
  if (sensitivity !== "confidential") return true;
  return cap.billing === "local" || cap.billing === "free";
}
```

Only `local` and `free` capabilities may serve a confidential task. Not "prefer
local" — *only*. And the sensitivity that feeds it is a one-way ratchet: it can
be raised by the hive when the request reads as confidential, and a caller's
explicit `confidential` is never cleared.

::: warning One open gap
Confidentiality is enforced on the **execution** path, not on the planner's own
escalation. A long or complex message can reach a cloud `plannerModel` before any
task has been marked confidential. This is known, open, and written up with its
fix options in [§10 Known gaps](/DESIGN#_10-known-gaps).
:::

## Urgency is what unlocks dollars

Per-token capabilities are dispatched only for **urgent** work. A non-urgent task
that could only run on a paid API defers until a prepaid window resets instead of
paying retail.

Together with confidentiality, `urgency` is one of only two planner-settable
fields that carry routing meaning — which is why both are grounded in the user's
own words rather than taken at face value from a plan.

## When everything adequate is blocked

The customer decides, via `policy.onBudgetBlock`:

- **`wait`** — hold for a seat window to reset. Full quality, higher latency. The
  task shows `deferred`, which is not an error.
- **`degrade`** — run now on a local model, and mark the result `degraded`.

Either way the hive keeps producing: tiers 3 and 4 cost nothing marginal, so a
customer whose USD is spent and whose every seat is empty still gets answers,
just at lower capability.

## Routing preference: cost-first or completion-first

`policy.routing` defaults to `cost-first`: take the cheapest adequate capability
and escalate only after a failure.

`completion-first` extends the "capability wins at equal cost class" reasoning
from complex tasks to every difficulty — among free tools, local models and seats
already paid for, prefer the more capable one. The argument is that a task
completing at tier 1 on attempt 1 costs the customer no more than the same task
failing at tier 3 first, minus the wasted attempt.

**It can never reach per-token billing**, which stays last and urgent-only, so
the knob cannot turn a preference into a bill.

The default stays `cost-first` deliberately: the episode log is what will say
whether the trade pays, and changing the default before that data exists would
pre-empt the question.

## Four levels of token optimization

In order of impact:

1. **Never spend the token.** Tool-match-first, local-first, and a result cache
   keyed on a normalized input hash that answers repeated tasks with zero
   dispatch.
2. **Quota before dollars.** Prepaid seats absorb the heavy agentic work.
   Non-urgent overflow waits for a window reset rather than paying retail.
3. **Send less per call.** Artifacts travel as references; workers inline a
   capped slice. An escalation carries a failure summary plus the prior attempt's
   output *by reference*, not a transcript.
4. **Pay less per token.** Stable prompt prefixes for provider cache hits,
   smallest adequate model, batch API for non-urgent per-token work.

### A cost cap is safe; a capability cap is a bug

Levels 1 and 2 are pure wins — a cache hit and a prepaid seat cost nothing but
cost. Levels 3 and 4 are where saving can cross into sabotage, and the line is
whether the cap can change the **outcome** rather than the price.

Truncating an artifact past the decisive detail, cutting an agentic tool loop off
at round four, or clamping what an agent may read makes a task unachievable at
any budget. It then fails identically at every tier, burns the whole escalation
ladder, and looks like a *hard* task rather than a *starved* one.

Those caps stay — they are good defaults — but every one is tunable, and every
one **reports when it bites** (`PromptBuildInfo.truncated`,
`ExecResult.diagnostics`), so the failure is attributable instead of mysterious.

### Trust the tuned bee

The hive decides *what* to do and *who pays*; the bee decides *how*. A bee is an
expert agent someone configured on purpose — it knows how to find a local file,
call its tools, reach the user's data — so a prompt that narrows it below its
competence is a defect, not thrift.

## The metric, and how it can be gamed

Cost per **completed** task, per customer, from telemetry. It should fall as tool
and local coverage grows.

The denominator is watched too: a fall in cost that comes from tasks failing
earlier is the metric being gamed rather than met.

Full treatment in [§7 Token optimization](/DESIGN#_7-token-optimization),
including the two honest caveats about prompt-prefix caching that have not paid
off yet and why.
