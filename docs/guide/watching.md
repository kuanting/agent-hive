# Watching work happen

Jobs take time. A `claude -p` run can sit for minutes, and a hive is several
processes — so the console used to show a `submitted` chip and nothing else,
while each bee narrated itself to a terminal nobody was tailing.

Three surfaces fix that, split by how much noise each can afford.

## The Queen's turn, on Home

One line that changes in place as she works:

> checking what I remember → planning (gemma4:12b) → handing work to the hive →
> waiting on the bees → writing the answer

with elapsed time.

**Phases, not streamed tokens** — and that is deliberate twice over. The planner
answers in JSON, so streaming it would type out syntax rather than thought. And
emitting real reasoning text would restrict which models are allowed to be the
Queen's brain, which is a much larger cost than a nicer animation.

## Task cards that count

Each card shows a live elapsed timer and one line saying where the step actually
is:

- *on the queue, waiting for a bee to take it*
- *running on 🏠 T3 local bee · gemma4:12b*
- *failed — the Queen may escalate and retry*

Expand a card for that task's own log lines.

The bee behind it publishes a liveness tick every few seconds, which is the thing
that separates a slow task from a dead one. Adapters run one buffered call per
task, so there is genuinely no intra-task progress to report — the tick carries
liveness and elapsed time and deliberately does not pretend to more: no
percentage, no step count, no partial output.

## Activity, the third view

The browser twin of `npm run watch`. It shows in-flight tasks with the Queen's
own reason for each — this is where *"quota window empty, waiting 300s for
reset"* stops looking like a hang — and the whole hive's narration as a
filterable feed: by level, by bee, pausable.

Debug output is opt-in **by navigation**, which is the point of it being a
separate view. Twenty bees can never bury the Queen's answer on Home.

It reads [`GET /events`](/reference/http-api#get-events). Because that endpoint
is a GET, the browser's own `EventSource` client handles it — so you can leave
the tab open, restart the Queen, and the feed picks itself back up. Every entry
carries a `seq`, and a bounded ring buffer is replayed on connect so a
freshly-opened tab is never blank.

## From the terminal

```bash
npm run watch        # live bee roster, seat quota, budget, wire traffic
npm run scoreboard   # what it cost, and what all-frontier would have cost
```

`npm run scoreboard` is worth running after any demo. It is the repo's own
currency: actual spend, next to what the same work would have cost routed
entirely to frontier models.

## Turning the volume up and down

| Variable | Default | Effect |
|---|---|---|
| `HIVE_LOG_LEVEL` | `info` | Threshold for a bee's terminal **and** the feed alike. `debug`, `info`, `warn`, `error`. |
| `HIVE_PROGRESS_MS` | `5000` | Liveness tick interval. `0` turns ticks off. |
| `HIVE_LOG_BUFFER` | `500` | How many lines the replay ring holds. |

## Log lines never carry content

**Every line carries identifiers and decisions — never prompt or output text.**

This is not a style preference. Confidentiality is a promise about *where work
runs*, and narration must not become the side door out of it: a log line echoing
the prompt would publish exactly that content to the broker and on into every
open browser tab, defeating the guarantee from the side nobody is watching.

`packages/queen/test/log-privacy.test.ts` enforces it with a source scan across
every narration call site, so it is a checked property rather than a convention.

## Why observability messages are allowed to be lost

`TaskProgress` and `AgentLog` are consumed non-durably and are never
dead-lettered. They describe what is happening *now*, so replaying a backlog
after a Queen restart would fill the console with a hive state that no longer
exists — and a stuck dead-letter queue full of log lines would obscure the task
failures the DLQ exists for.

Losing them is the correct failure mode. The work itself is unaffected either way.
