# Reading what repeats

The [usage corpus](/reference/usage-corpus) is a SQLite file of everything the
hive has settled. `npm run breed` is how you read it without writing SQL — and
the commands split into two kinds, which is the point of the tool rather than an
accident of its growth:

```bash
npm run breed -- flows | steps | shapes | sql   # report facts, offer no opinion
npm run breed -- survey                          # one opinionated reading, frozen
```

Nothing here talks to a running Queen and every connection is read-only, so this
works on a stopped hive and a mistyped `DELETE` fails instead of costing you your
history.

## The fact commands

**`flows`** — which agent tool-call procedures repeat. This is the question the
corpus was built to answer.

```bash
npm run breed -- flows --customer breeder --min 12 --since 30d
```

```
flow                         loops  turns      cost  per loop  last seen
digikey_search -> get_price     40     80     $4.80   $0.1200  1h ago
```

A caller's agent loop arrives as several separate HTTP requests — turn one
returns a tool call, the caller runs it and posts the result as turn two.
`loop_id`, a hash of the stable head of the transcript, stitches them back
together without the caller threading an id.

**`steps`** — the same procedure unrolled, in call order, with the argument key
names each step took:

```bash
npm run breed -- steps --flow "digikey_search -> get_price"
```

**`shapes`** — recurring work on the structured intake (`POST /tasks`), which has
no tool loop to group on. Grouped by skills, difficulty and `toolInput` key
names.

**`sql`** — your own query against the [documented views](/reference/usage-corpus#views-which-are-the-contract),
printed as JSON:

```bash
npm run breed -- sql "SELECT flow, loops, cost_usd FROM v_repeated_flow WHERE loops >= 12"
```

All four take `--json`, and `flows`/`shapes`/`survey` take `--customer`, `--min`
and `--since`. Confidential rows never enter any of them; the count that was
withheld is printed, because an unstated omission reads as completeness.

## The survey, and what it is not

`survey` is the one command that offers a judgement: it groups the corpus into
shapes, runs each through a fixed set of gates, and sorts what came out.

```bash
npm run breed -- survey --customer breeder
```

```
  corpus: 61 task row(s), grouped on structural+title

  shape          verdict         occ    ok   1st  counterfactual       data  skills
  -------------- ------------- ----- ----- ----- --------------  ---------  ------
  8f21c0a4       candidate        18   100%  94%          $1.42       live  sourcing
                   -> the answer changed between asks while keeping its shape — an outside system, read live
  b0c7d915       rejected          6    83%  67%          $0.31     stable  reporting
                   NO frequency: 6 occurrence(s), need 12
                   NO reliability: 83% succeeded, need 90%

  1 candidate(s), 0 unassessable, 1 rejected
  breeding all candidates would stop $1.42 of counterfactual spend recurring.
  (counterfactual = observed tokens re-priced at frontier rates; an estimate, not a bill)
```

**It is frozen, deliberately.** No new gates, no new thresholds. It exists to
demonstrate that this corpus answers a question — it is not the hive's answer to
it. Anyone mining seriously should query the views, which are the documented
interface and will not move underneath them.

Every gate is arithmetic over rows that already exist: no model call, no token,
no network. That is not only thrift. A survey that cost money would be run once
and then trusted for months, and the whole point is that it is cheap enough to
re-run whenever the traffic changes.

## The gates

| Gate | Asks | Fails when |
|---|---|---|
| `frequency` | Does this happen enough to be worth a program? | fewer than `--min` occurrences (default 12) |
| `reliability` | Does the hive get it right today? | success rate below 90% |
| `first-attempt` | Is it easy, or does it need the escalation ladder? | first-attempt success below 80% |
| `procedure` | Are the steps fixed, even when the data is not? | the same request gave differently *shaped* answers, or two different answers seconds apart |
| `template-request` | Is the ask a form with blanks filled in? | masked requests are not similar enough, or not more similar to each other than to other shapes |

Two of those repay explanation.

**`reliability` is about the corpus, not the tool.** You cannot write a spec for
work the hive gets wrong — the corpus would be describing the failure. And a
shape that routinely needs tier 1 after failing at tier 3 is one the hive finds
*hard*, which is a poor bet for a fixed program.

**Only the request side is gated.** Gating the answer rejected exactly the work
most worth breeding: a price lookup has a rigid request and an answer that is
*supposed* to vary. The answer-side template check still runs, but as a signal
rather than a gate.

## Three verdicts, and why `unknown` is one of them

- **`candidate`** — every gate passed.
- **`rejected`** — at least one gate failed.
- **`unassessable`** — nothing failed, but something could not be evaluated.

The content gates are claims about task text, which the default `metadata`
fidelity does not record. Scoring those as passes would promote shapes nobody has
checked; scoring them as failures would mean the survey finds nothing at the
fidelity almost every hive is actually at. So they report that they could not be
evaluated, and the shape is held apart from both piles.

At `metadata` the survey prints exactly that, with the remedy attached: it can
say how often work recurs and what it costs, and nothing else — it cannot name a
single parameter. Set
[`policy.recordEpisodes: tasks`](/reference/customer-policy) to record task
title, input and output (never the user's message, the plan rationale or the
assistant's answer). Once most rows carry a title — four fifths of them — shape
grouping also moves from the coarse `structural` basis to `structural+title`,
which tells "summarize this csv" apart from "write a paragraph about the trend";
both are `reporting` / `standard` and are not the same work. The basis is chosen
once for the whole run and printed in the header, because mixing bases would
fragment a cluster and make one real shape look like two rare ones.

## What the `data` column is telling you

The `procedure` gate distinguishes what most naive determinism checks conflate:
values moving is not the procedure moving.

| Value | Meaning |
|---|---|
| `stable` | the same request always gave the same answer — a pure transformation |
| `live` | answers changed between asks while the shape held — an outside system, read live |
| `mixed` | part of this shape reads live data |
| `nondeterministic` | the same request answered two ways within a minute — no program can stand in for that |
| `unstable-procedure` | repeat requests produced answers of a different *shape* |
| `unknown` | nothing repeated often enough, or the text is not recorded |

`live` is the mark of work that wants a scraper plus a reader, which is the shape
[`digikey-price`](/guide/breeding-tools) has. An earlier version of this check
threw that case away as non-deterministic, which rejected the most valuable
candidate class the hive has.

## The counterfactual number

`counterfactual` is the observed token counts of **every attempt**, including the
retries, re-priced at frontier rates (`claude-opus-4-6`). It is not what the work
cost — on a solo hive, local work reports `$0.00`, and ranking on observed spend
would find nothing worth breeding anywhere. It asks the question that matters:
what would this work cost if the hive had no cheap route for it? That is what a
tier-4 tool makes permanently zero.

It is computed, therefore an estimate, and the CLI labels it as one every time it
prints it.

Savings rank but no longer gate. A scraper worth cents in tokens can still be
worth writing for the reliability and the waiting it removes, so a cheap
candidate is reported and sorted last rather than rejected for being cheap.

## Thresholds

Every threshold is an environment variable, so you can re-run the survey at your
own bar without editing code. `--min` overrides the first one from the command
line.

| Variable | Default | Bounds |
|---|---|---|
| `HIVE_BREED_MIN_SAMPLES` | `12` | occurrences before a shape is worth considering |
| `HIVE_BREED_MIN_OK_RATE` | `0.9` | success rate for the `reliability` gate |
| `HIVE_BREED_MIN_FIRST_OK` | `0.8` | first-attempt success rate |
| `HIVE_BREED_MIN_SIMILARITY` | `0.6` | how alike masked requests must be |
| `HIVE_BREED_MIN_MARGIN` | `0.25` | how far a shape must out-resemble itself compared with other shapes |
| `HIVE_BREED_MAX_MASK` | `0.35` | above this, masking has eaten the text and similarity measures the mask |
| `HIVE_BREED_MIN_DF` | `0.9` | a word in this fraction of a cluster's rows is procedure, not value |
| `HIVE_BREED_LIVE_GAP_MS` | `60000` | below this gap, two different answers are not "the data moved" |

The last three exist because similarity measured on masked text can manufacture
the very stability the gate is looking for. The mask-ratio ceiling catches a
cluster that masked down to placeholders; the margin compares the cluster against
rows from *other* shapes, masked with the same exemptions, so over-masking shows
up on both sides and the failure becomes measurable instead of assumed away.

Next: [writing the tool a finding asks for](/guide/breeding-tools).
