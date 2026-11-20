# The usage corpus

Every settled task and every planner turn is written to a SQLite database at
`data/episodes/episodes.db`. It is the hive's record of what it actually did:
which capability ran the work, what it cost, how many attempts it took, and —
when a caller supplies tools — which tools the model asked for, in what order.

**It exists to be read by somebody else.** The hive organizes its own usage and
hands it over; deciding which recurring workflow is worth replacing with a
deterministic tool, and writing that tool, is work for a person or a better model
than the one making routing decisions at dispatch time. So the schema and the
views below are a published interface, versioned in `PRAGMA user_version`, and
not an internal detail.

## The question it exists to answer

```sql
SELECT flow, loops, turns, cost_usd, cost_per_loop
FROM v_repeated_flow
WHERE loops >= 12
ORDER BY cost_usd DESC;
```

```
digikey_search -> get_price | 40 | 80 | 0.24 | 0.0060
read_file                   |  5 |  5 | 0.01 | 0.0030
```

A caller's agent loop arrives as several separate HTTP requests — turn one
returns a tool call, the caller runs it and posts the result as turn two. Those
are stitched back together by `loop_id`, a hash of the stable head of the
transcript, which needs nothing from the caller.

This works at `metadata`, the default fidelity, because a tool call's **name** and
its argument **key** names are structure rather than content. Argument values are
never written, at any fidelity.

## Reading it

The file is the API. Nothing has to go through the hive to read it, and it works
on a stopped hive:

```bash
sqlite3 data/episodes/episodes.db "SELECT * FROM v_repeated_flow"
```

Any language with a SQLite driver works the same way. There is deliberately **no
HTTP endpoint** — see [DESIGN §7](/DESIGN). Open it read-only if you are querying
a running hive; the write connection is held by the Queen and WAL lets you read
alongside it.

For consumers without `sqlite3`, [`npm run breed`](/reference/scripts) runs the
same views and is read-only by construction:

```bash
npm run breed -- usage                    # what each person cost
npm run breed -- usage --user ada         # one person
npm run breed -- usage --daily            # per day, UTC
npm run breed -- flows                    # which procedures repeat
npm run breed -- steps                    # their steps, in order, with parameter names
npm run breed -- shapes                   # recurring work on the structured intake
npm run breed -- sql "SELECT ..."         # your own query
```

## Tables

| Table | Grain |
|---|---|
| `task` | One row per settled task. |
| `attempt` | One row per execution, `ordinal` preserving order. |
| `tool_call` | One row per tool call, `seq` preserving **call order**. |
| `turn` | One row per planner turn; its `tasks` is an opaque JSON document. |
| `meta`, `import_state` | Schema version and legacy-import provenance. |

Two things about the shape are load-bearing and easy to get wrong if you build on
top of it:

- **`task_id` is not unique.** A cache hit writes a second row carrying the id of
  the task whose result was reused. Those rows are the evidence that a shape
  *recurs*, which is the most valuable signal here — filter `cached = 1` out when
  you want executions, and keep them when you want frequency.
- **Do not join `turn` to `task`.** The turn-level privacy ratchet strips a whole
  turn when *any* task in it was confidential, while the task-level one strips
  only the offending task. Joining them would surface task text as turn content
  and defeat the stricter of the two. No shipped view does it.

## Views, which are the contract

| View | What it gives you |
|---|---|
| `v_task` | Structure-only projection of a task, attempts already aggregated. |
| `v_analysis_task` | `v_task` minus confidential work. Start here. |
| `v_withheld` | How many rows were withheld, per customer. |
| `v_task_flow` | One task's tool calls, in call order. |
| `v_loop_flow` | One row per agent loop. |
| `v_repeated_flow` | **Which procedures repeat, how often, what they cost.** |
| `v_flow_step` | The steps of each flow, enumerated with their parameter names. |
| `v_repeated_shape` | Recurring work on the structured intake, which has no loop. |
| `v_user_usage` | **What each person cost**, per `(customer_id, user_id)`. |
| `v_user_usage_day` | The same, per UTC day, with `day_start_ms` beside the label. |
| `v_user_model` | Where one person's spend went, per tier, billing and model. |

Two rules hold across all of them, enforced by tests that walk `sqlite_master`
rather than checking view by view, so a view added later cannot quietly break
either:

1. **No view exposes a content column** — `title`, `input`, `output`,
   `tool_input`, `error`, `diagnostics`, `user_message`, `plan_rationale`,
   `answer`, `tasks`. Those live on base tables only.
2. **Every analysis view excludes confidential rows**, and `v_withheld` reports
   how many. A count is not content, and an unstated omission reads as
   completeness.

The three `v_user_*` views are the deliberate exception to the second rule, and
the reason is worth stating rather than discovering. Every other view answers
*what should we learn from*, where excluding confidential work is right. These
answer *who spent the money*, where excluding it is simply a wrong number — cost
and token counts are metadata **about** a decision, not the content **of** one.
They obey the first rule unchanged, and `v_user_usage.confidential_count` names
how many of the rows counted were confidential, so nobody has to wonder.

`user_id` is `NULL` for tasks the planner submitted internally and for anything
recorded before callers were identified. It is left NULL rather than coalesced to
a literal like `'(unattributed)'`, because a literal could collide with a real id
and inventing an identity is the opposite of the point. SQLite already groups the
NULLs into one bucket; `npm run breed -- usage` renders them as `(none)`.

Within a major `schema_version`, view column names and meanings do not change;
columns may be appended in a minor bump. `SELECT *` is not part of the contract —
name your columns.

**Views are rebuilt from this build's definitions every time a writer opens the
corpus**, so a new view arrives with the next `npm run queen` and needs no version
bump: a view is a saved query rather than data, so it is replaced rather than
migrated. `schema_version` is about *tables*. A read-only reader cannot rebuild
anything, so `npm run breed` against a corpus that predates a view reports the
remedy — start the Queen once — instead of a bare `no such view`.

## What is recorded, at what fidelity

Set per customer with [`policy.recordEpisodes`](/reference/customer-policy).

| | `off` | `metadata` (default) | `tasks` | `full` |
|---|---|---|---|---|
| Nothing at all | ✅ | | | |
| Tiers, tokens, cost, timings, attempt chains | | ✅ | ✅ | ✅ |
| Skills, difficulty, `toolInput` **key names** | | ✅ | ✅ | ✅ |
| Tool call **names** and argument **key names** | | ✅ | ✅ | ✅ |
| `loop_id`, `turn_index`, declared tools | | ✅ | ✅ | ✅ |
| Each task's input, output, `toolInput` values | | | ✅ | ✅ |
| User message, plan rationale, answer | | | | ✅ |

A task's input is the work; the user's message and the assistant's answer are a
conversation. That is the line `tasks` draws, and it is why the rung exists rather
than telling people to turn on `full`.

**Any confidential task forces `metadata` regardless of profile**, and those rows
are excluded from every analysis view. One-way, like every other confidentiality
check in the hive.

## Retention

Bounded by age and row count, like every long-lived structure here:
`HIVE_EPISODE_MAX_DAYS` (180) and `HIVE_EPISODE_MAX_ROWS` (500,000), pruned
oldest-first. `HIVE_EPISODE_DB` moves the file — worth doing if `HIVE_ROOT` is a
network share, since SQLite's WAL mode needs shared memory and does not work over
NFS or SMB.

`npm run reset -- --episodes` clears it. Deliberately not part of `--memory`:
learned memory is derived and traffic re-earns it, whereas the corpus *is* the
traffic and nothing can reconstruct it.
