# Customer profiles

One YAML file per customer in `customers/`, loaded by the Queen at startup. The
core is customer-agnostic: everything customer-specific lives here.

**YAML is authority.** These files own the budget, the seats, the tier-4 tools
and the routing policy. The markdown files sitting next to them own none of
that — see [advice, not authority](#advice-not-authority) below.

## Shape

```yaml
customerId: aiotlab
name: AIoT Lab

budget:
  capUsd: 50

policy:
  onBudgetBlock: wait          # or: degrade
  routing: cost-first          # or: completion-first
  recordEpisodes: metadata     # off | metadata | full

plannerModel: claude-sonnet-4  # what the planner escalates TO for hard requests

seats:
  - seatId: claude-max-1
    windowSeconds: 18000
    tokensPerWindow: 1500000

tools:
  - toolId: csv-report
    skills: [reporting]
    requiredKeys: [csv]
```

| Field | Default | Meaning |
|---|---|---|
| `customerId` | — | Key used everywhere: on tasks, in the ledger, in `data/memory/<customerId>/`. |
| `name` | — | Display name only. |
| `budget.capUsd` | — | Hard USD ceiling on per-token spend. Subscription seats do not draw against it — that is the point of them. |
| `policy.onBudgetBlock` | `wait` | What to do when every adequate capability is blocked on budget. |
| `policy.routing` | `cost-first` | See below. |
| `policy.recordEpisodes` | `off` | How much of a turn is written to `data/episodes/`. |
| `plannerModel` | unset | The **stronger** model the planner escalates to for complex requests. Not the default brain — that is `HIVE_PLANNER_MODEL`. |
| `seats` | `[]` | Prepaid quota windows this profile declares. |
| `tools` | `[]` | Tier-4 tools available to this customer. |

A customer profile is hand-edited YAML, so **every field degrades rather than
throws**: an absent or malformed `policy` falls back to the safe default in each
field, and an unrecognized value never silently picks the expensive option.

## `onBudgetBlock`: wait or degrade

The single most visible policy lever. When a task's adequate capabilities are all
blocked — the seats are inside an exhausted quota window, or the USD cap is
reached — the customer decides what happens:

- **`wait`** (default) — hold the task until a seat window resets. Full quality,
  higher latency. The task shows as `deferred`, which is not an error.
- **`degrade`** — run it now on a local model and mark the result `degraded`.
  Lower quality, no waiting, no spend.

`customers/aiotlab.yaml` uses `wait`; `customers/demo-lab.yaml` uses `degrade`.
Submitting the same task to both is the cleanest way to see per-customer routing
policy actually choose.

## `routing`: cost-first or completion-first

`cost-first` (the default) takes the cheapest adequate capability.
`completion-first` extends the reasoning the router already applies to *complex*
tasks — where a prepaid frontier seat beats a prepaid mid-tier seat because both
cost ~0 and capability wins at equal cost class — to every difficulty.

The argument: a task that completes on attempt 1 at tier 1 costs the customer
exactly what a task that fails at tier 3 and then succeeds at tier 1 costs, minus
the failed attempt and its latency.

The safety property is that **this knob cannot reach per-token billing.**
Per-token stays last and stays urgent-only, so `completion-first` can never turn
a preference into a bill. Anything but the exact opt-in string stays `cost-first`,
because completion-first spends more per first attempt and so may only ever be
reached deliberately.

## Seats are global, and first-write-wins

This one has bitten people, so it is worth stating plainly.

Seats are **global infrastructure keyed by `seatId` across the whole ledger**. A
customer's `seats:` block *declares* a seat; it does not scope it. `addSeat` is
first-write-wins, so redeclaring `claude-max-1` in a second profile with a
different window is **silently ignored** — whichever profile loaded first wins.

`demo-lab.yaml` works around this correctly rather than fighting it: it declares
its own `demo-seat-1`, and the honey bee carries a capability pinned to that seat
behind an exclusive `demo-quota` skill. That is what makes exhaustion reachable
inside a demo — one real call spends more than 1000 tokens, so the very first
task on that skill empties a 400-token window.

Also note where the numbers come from: the ledger sizes a seat from the
**customer profile**, so the matching `quotaWindow` on a bee's capability
contributes only its `seatId`.

## Tools

Each entry declares a tier-4 tool from the built-in registry:

```yaml
tools:
  - toolId: csv-report
    skills: [reporting]
    requiredKeys: [csv]
```

`requiredKeys` is what the analyzer matches a task's `toolInput` against. A task
whose `toolInput` supplies every required key can be served by the tool — no LLM,
no tokens, no cost. This is the cheapest branch in the entire system, and it is
also what the Queen's learned memory is usually trying to reach: see
[A Queen that learns](/guide/memory).

## Advice, not authority {#advice-not-authority}

Two markdown files sit in the same directory and are **not** customer profiles:

- `customers/plan-guide.md` — house conventions for decomposition.
- `customers/<id>.plan-guide.md` — a per-customer overlay of the same.

They shape only *how the Queen splits a request into tasks* — never where those
tasks run. They reach the planner's prompt and nothing else, and `TaskSpec` has
no tier or budget field, so a bad guide produces a bad plan, never a bad bill.

They are also **not published to this site**, deliberately: they are prompt
configuration, checked in and reviewed like the YAML beside them, and publishing
them would invite them to be read as documentation. `HIVE_PLAN_GUIDE=0` turns
them off for a reproducible demo.

## Realistic vs. demo numbers

`customers/aiotlab.yaml` holds realistic values: a $50 cap and 5-hour seat
windows. Those are correct, and they make the budget half of the router
impossible to watch — you would wait five hours for a window to reset.

`customers/demo-lab.yaml` is the same schema shrunk until every budget path fires
inside a demo: a $0.50 cap, a 90-second window, 400 tokens. Nothing about it is
special-cased in code.
