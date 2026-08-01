# A Queen that learns

**YAML is authority, markdown is advice.**

The [customer profiles](/reference/customer-policy) own budget, seats, tools and
routing. Two markdown inputs shape only *how the Queen splits a request into
tasks* — never where those tasks run:

- **Plan guide** — hand-authored, checked in: `customers/plan-guide.md` (house)
  and `customers/<id>.plan-guide.md` (per-customer overlay).
- **Learned memory** — one lesson per file under `data/memory/<customerId>/`,
  written by the Queen itself.

Without them the planner is amnesiac: it rebuilds the same prompt every turn and
re-makes every mistake, so a request that once burned LLM tokens for want of a
`toolInput` key burns them again next week.

## The organizing rule

> **Detectors observe deterministically; the model only phrases.**

Everything about a memory except one sentence is machine-derived from a
structural cause. That is what makes learning near-free, makes dedupe work, and
bounds the injection surface.

## Writing: five detectors, and usually zero cost

At the end of every plan, five pure detectors run over data the planner already
holds, looking for something worth remembering:

1. **A missed tool match** — a task ran on an LLM though a registered tool needed
   only one absent key. The highest-value lesson, because a tool match costs zero
   tokens.
2. **A skill tag no live worker advertises.**
3. **A stalled DAG.**
4. **A plan that needed the escalation ladder.**
5. **A clean multi-step plan worth reusing.**

**If nothing fires, no model is called and the turn costs nothing extra** — and
that is the common case. Four of the five are templated from your YAML values, so
they stay free even when they *do* fire. Only a genuinely novel clean plan spends
one local call, and its dedupe check runs before that call.

## Recall: a trigger-word gate, not embeddings

Deterministic. A set-membership gate on trigger words first, then a score.

The gate matters more than the ranking: a memory with no trigger word in the
message is not considered at all, so most turns inject nothing and cost nothing.
Guide plus memory can never add more than 2000 characters to the system prompt,
and a test asserts it.

## The payoff, in the repo's own currency

Ask for a report over a CSV without a tool hint and it runs on an LLM. The Queen
notices that the `csv-report` tool needed only one absent key, and writes that
down. Ask again in a fresh session and the plan carries `toolInput.csv` — the
step matches tier 4 and costs **zero tokens**.

## Forgetting: a lesson has to keep earning its place

Writing alone would let the corpus only ever become more certain. The fix is that
**detector ids are stable, so re-detection is the verdict**: if a note was
recalled and the same detector fires anyway, the planner was told and ignored it.

That memory's trust falls, it sinks in the ranking, and after three strikes it is
retired — kept on disk for the record, but no longer paid for in prompt budget.

Trust is Laplace-smoothed, `(helped + 1) / (helped + misfired + 2)`, so an
untried lesson sits at exactly 0.5.

### Feedback strength follows falsifiability

| Kind | Graded |
|---|---|
| `pitfall` | both ways — it makes a self-checking claim ("this detector should not fire again") |
| `playbook` | positive-only — re-detection confirms the shape recurred cleanly, but non-detection is ambiguous |
| `fact` | never auto-graded — operator-written |

Grading a playbook's non-detection as failure would be the "the turn went badly,
blame all three notes that shared it" heuristic in disguise.

### Ranking is scored on `helped`, never on `observed`

A distinction that took a rewrite to get right, and the clearest example in the
system of a metric achieving the opposite of its purpose.

`observed` counts how often a *cause* occurred. It is not evidence the *note*
works — and every misfire arrives together with an `observed` bump, because
reflection grades the memory and then records the same re-detected observation.
Ranking on `log2(1 + observed)` therefore had each failure **raise** the memory's
rank, with an unbounded term outrunning a trust term clamped to ±1.

Ranking now uses `log2(1 + helped) + 2 × (trust − 0.5)`, so failure can only ever
cost rank. Eviction has the same shape, for the same reason.

### Two signatures worth knowing

When reading `data/memory/<customer>/INDEX.md`:

- **A lesson being ignored**: `observed` climbing while trust collapses.
- **A lesson that worked**: `observed` frozen — the mistake stopped happening —
  while `helped` climbs.

### Going stale is different from failing

`us-database` says the hive has no `database` skill. The moment a worker
advertises one, that detector id can never be emitted again — so every recall was
a free `helped`, trust climbed toward 1.0, and retirement (needing three
misfires) became unreachable *while the advice was actively false*.

Recalled memories are therefore checked against live state — tools from
`customers/*.yaml`, skills from the registry — and a memory describing a world
that no longer exists is retired outright instead of graded.

## What memory cannot do

**It cannot route.** It reaches the planner prompt only, and `TaskSpec` has no
tier or budget field, so a bad memory produces a bad plan, never a bad bill.

The two planner fields that *do* carry routing meaning — `urgency`, which unlocks
per-token spend, and `sensitivity`, which decides whether work may leave the
machine — are both grounded in the user's own words. A note telling the planner
to mark everything urgent or routine gets overruled.

**A turn touching anything `confidential` writes nothing at all.**

## Turning it off

```bash
HIVE_MEMORY=0        # no recall, no writing
HIVE_PLAN_GUIDE=0    # ignore the hand-authored guides
npm run reset -- --memory   # wipe what was learned
```

Both are what you want for a reproducible demo. Plan guides are hand-authored
configuration and are never removed by a reset.

## One caveat before you point this at anything sensitive

Confidentiality is enforced on the **execution** path, not on the planner's own
escalation. A long or complex message can reach a cloud `plannerModel` before any
task has been marked confidential.

This is open and known; the fix options are written up in
[§10 Known gaps](/DESIGN#_10-known-gaps).

## Full detail

[§5c A Queen that learns](/DESIGN#_5c-a-queen-that-learns-plan-guide-and-memory).
