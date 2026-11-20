/**
 * The shape of the hive's usage corpus, and the contract other people read it by.
 *
 * The hive's job here is to organize what it did and hand it over. Finding the
 * recurring workflow in this data — and writing the deterministic tool that
 * replaces it — is work for a person or a better model than the one making the
 * decisions at dispatch time. So this file is a published interface, not an
 * internal detail: the tables are the record, the views are the API, and both
 * are versioned because they now have consumers outside this repository.
 */

/**
 * Bumped when a shipped view changes meaning or a column disappears.
 *
 * A reader finding a HIGHER version than it knows must stop rather than guess,
 * and a writer finding one must refuse to write: inserting into a schema you do
 * not understand corrupts somebody else's corpus, and this is the one store in
 * the hive that cannot be regenerated from anything.
 *
 * This is about *tables*. Views are rebuilt from `VIEWS_SQL` on every writer open
 * (see `refreshViews`), so ADDING one needs no bump — an existing corpus gains it
 * the next time a Queen starts. Changing what an existing view means still does,
 * because a consumer reading it would silently get different numbers.
 */
export const SCHEMA_VERSION = 1;

/**
 * Columns that hold user or model text.
 *
 * Named here so the "no view exposes content" test can be generic — it walks
 * `sqlite_master` for every view and intersects its columns with this list, so a
 * view added a year from now cannot quietly widen what is readable. Whether
 * these columns are populated at all is decided far upstream, by the privacy
 * ratchet in `core.ts` and `planner/index.ts`; this is the downstream fence.
 */
export const CONTENT_COLUMNS = [
  "title",
  "input",
  "output",
  "tool_input",
  "error",
  "diagnostics",
  "user_message",
  "plan_rationale",
  "answer",
  "tasks",
] as const;

export const SCHEMA_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Provenance for the one-shot legacy import, so re-running it is a no-op rather
-- than a duplication.
CREATE TABLE import_state (
  file       TEXT PRIMARY KEY,
  mtime_ms   INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  rows       INTEGER NOT NULL,
  at         INTEGER NOT NULL
) STRICT;

-- One row per settled task.
--
-- The primary key is a surrogate and task_id is deliberately NOT unique: a cache
-- hit writes a second row carrying the id of the task whose result was reused.
-- Those rows are the evidence that a shape RECURS, which is the single most
-- valuable thing in this corpus, and a unique key on task_id would silently
-- delete exactly them.
CREATE TABLE task (
  id                  INTEGER PRIMARY KEY,
  task_id             TEXT    NOT NULL,
  customer_id         TEXT    NOT NULL,
  at                  INTEGER NOT NULL,
  mode                TEXT    NOT NULL,
  downgraded_reason   TEXT,

  -- Structure. Present at every fidelity, because none of it is content.
  skills              TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(skills)),
  skills_key          TEXT    NOT NULL DEFAULT '',
  difficulty          TEXT,
  sensitivity         TEXT,
  tool_input_keys     TEXT    CHECK (tool_input_keys IS NULL OR json_valid(tool_input_keys)),
  tool_input_keys_key TEXT,
  artifact_count      INTEGER NOT NULL DEFAULT 0,
  ok                  INTEGER NOT NULL CHECK (ok IN (0,1)),
  wall_ms             INTEGER NOT NULL DEFAULT 0,
  cached              INTEGER CHECK (cached IS NULL OR cached IN (0,1)),
  user_id             TEXT,
  end_user_hash       TEXT,
  loop_id             TEXT,
  turn_index          INTEGER,
  declared_tools      TEXT    CHECK (declared_tools IS NULL OR json_valid(declared_tools)),

  -- Content. NULL unless the customer opted into 'tasks' or 'full'.
  title               TEXT,
  input               TEXT,
  output              TEXT,
  tool_input          TEXT    CHECK (tool_input IS NULL OR json_valid(tool_input)),

  -- The rule that confidential work is never analyzed, encoded once so every
  -- consumer inherits it instead of each remembering to write it.
  confidential INTEGER GENERATED ALWAYS AS (
    CASE WHEN sensitivity = 'confidential'
           OR downgraded_reason = 'task was confidential' THEN 1 ELSE 0 END) VIRTUAL
) STRICT;

CREATE INDEX task_at          ON task(at);
CREATE INDEX task_customer_at ON task(customer_id, at);
CREATE INDEX task_task_id     ON task(task_id);
CREATE INDEX task_loop        ON task(loop_id, turn_index) WHERE loop_id IS NOT NULL;

-- One row per execution. A child table because every interesting question
-- aggregates these: tier mix, first-attempt success, what the retries cost.
CREATE TABLE attempt (
  id            INTEGER PRIMARY KEY,
  task_row_id   INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  attempt       INTEGER NOT NULL,
  tier          INTEGER NOT NULL,
  agent         TEXT,
  runtime       TEXT    NOT NULL,
  model         TEXT,
  billing       TEXT,
  ok            INTEGER NOT NULL CHECK (ok IN (0,1)),
  degraded      INTEGER NOT NULL CHECK (degraded IN (0,1)),
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  truncated_artifacts TEXT CHECK (truncated_artifacts IS NULL OR json_valid(truncated_artifacts)),
  -- NULL means the runtime reported no tool-call field at all; 0 means it
  -- reported an empty one. Without the distinction the round trip cannot tell
  -- "did not call tools" from "does not do tools".
  tool_call_count INTEGER,
  error         TEXT,
  diagnostics   TEXT CHECK (diagnostics IS NULL OR json_valid(diagnostics)),
  UNIQUE (task_row_id, ordinal)
) STRICT;

-- One row per tool call, and the reason this file exists. \`seq\` is the call
-- order: the ordered sequence IS the agent's procedure, and it is what anyone
-- looking for a workflow to harden will group by.
CREATE TABLE tool_call (
  id             INTEGER PRIMARY KEY,
  attempt_row_id INTEGER NOT NULL REFERENCES attempt(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  name           TEXT    NOT NULL,
  arg_keys       TEXT    CHECK (arg_keys IS NULL OR json_valid(arg_keys)),
  arg_keys_key   TEXT    NOT NULL DEFAULT '',
  sig            TEXT GENERATED ALWAYS AS (name || '(' || arg_keys_key || ')') VIRTUAL,
  UNIQUE (attempt_row_id, seq)
) STRICT;

CREATE INDEX tool_call_name ON tool_call(name);

-- One row per planner turn.
--
-- \`tasks\` stays an opaque post-ratchet document on purpose. The turn ratchet
-- strips a whole turn when ANY task in it was confidential, while the task
-- ratchet strips only the offending task — so a turn can be metadata while its
-- own tasks' rows are full. Normalizing this, or shipping a view that joins turn
-- to task, would let a reader recover as turn content exactly the text the turn
-- ratchet had just removed. json_each() is still there for anyone who means it.
CREATE TABLE turn (
  id                    INTEGER PRIMARY KEY,
  turn_id               TEXT    NOT NULL,
  customer_id           TEXT    NOT NULL,
  at                    INTEGER NOT NULL,
  mode                  TEXT    NOT NULL,
  downgraded_reason     TEXT,
  planner_model         TEXT,
  planner_tier          INTEGER,
  decision              TEXT    NOT NULL,
  escalated             INTEGER NOT NULL CHECK (escalated IN (0,1)),
  planner_difficulty    TEXT,
  planner_input_tokens  INTEGER NOT NULL DEFAULT 0,
  planner_output_tokens INTEGER NOT NULL DEFAULT 0,
  planner_cost_usd      REAL    NOT NULL DEFAULT 0,
  planner_latency_ms    INTEGER NOT NULL DEFAULT 0,
  recall_ids            TEXT    CHECK (recall_ids IS NULL OR json_valid(recall_ids)),
  recall_chars          INTEGER,
  routing               TEXT,
  phase_ms              TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(phase_ms)),
  total_input_tokens    INTEGER NOT NULL DEFAULT 0,
  total_output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_cost_usd        REAL    NOT NULL DEFAULT 0,
  total_wall_ms         INTEGER NOT NULL DEFAULT 0,
  total_attempts        INTEGER NOT NULL DEFAULT 0,
  outcome_ok            INTEGER NOT NULL CHECK (outcome_ok IN (0,1)),
  outcome_answer_chars  INTEGER NOT NULL DEFAULT 0,
  user_message          TEXT,
  plan_rationale        TEXT,
  answer                TEXT,
  tasks                 TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tasks))
) STRICT;

CREATE INDEX turn_customer_at ON turn(customer_id, at);
`;

/**
 * The views, which are the part outside consumers are invited to depend on.
 *
 * Two rules hold across all of them, and the tests enforce both generically
 * rather than view by view: none selects a content column, and every view whose
 * name implies analysis excludes confidential work. `v_withheld` reports how much
 * was excluded, because an omission nobody mentions reads as completeness.
 */
export const VIEWS_SQL = `
-- Structure-only projection of a task, with its attempts already aggregated.
CREATE VIEW v_task AS
SELECT t.id AS task_row_id, t.task_id, t.customer_id, t.at, t.mode, t.downgraded_reason,
       t.skills, t.skills_key, t.difficulty, t.sensitivity,
       t.tool_input_keys, t.tool_input_keys_key, t.artifact_count,
       t.ok, t.wall_ms, coalesce(t.cached, 0) AS cached,
       t.user_id, t.end_user_hash, t.loop_id, t.turn_index, t.declared_tools,
       t.confidential,
       (SELECT count(*)                         FROM attempt a WHERE a.task_row_id = t.id) AS attempts,
       (SELECT coalesce(sum(a.cost_usd), 0)     FROM attempt a WHERE a.task_row_id = t.id) AS cost_usd,
       (SELECT coalesce(sum(a.input_tokens), 0) FROM attempt a WHERE a.task_row_id = t.id) AS input_tokens,
       (SELECT coalesce(sum(a.output_tokens),0) FROM attempt a WHERE a.task_row_id = t.id) AS output_tokens,
       (SELECT min(a.tier)                      FROM attempt a WHERE a.task_row_id = t.id) AS best_tier,
       (SELECT a.ok FROM attempt a WHERE a.task_row_id = t.id ORDER BY a.ordinal LIMIT 1)  AS first_attempt_ok
FROM task t;

-- Where every analysis starts. The confidential exclusion, written once.
CREATE VIEW v_analysis_task AS SELECT * FROM v_task WHERE confidential = 0;

-- How much traffic the analysis was not allowed to see. A count is not content.
CREATE VIEW v_withheld AS
SELECT customer_id, count(*) AS rows_withheld, min(at) AS first_at, max(at) AS last_at
FROM task WHERE confidential = 1 GROUP BY customer_id;

-- The tool calls of one task, in call order.
CREATE VIEW v_task_flow AS
SELECT v.task_row_id, v.customer_id, v.loop_id, v.turn_index, v.at, v.cached, v.ok,
       v.end_user_hash, v.cost_usd, v.input_tokens, v.output_tokens,
       f.flow, f.signature, coalesce(f.steps, 0) AS steps
FROM v_analysis_task v
LEFT JOIN (
  SELECT a.task_row_id AS tid,
         group_concat(tc.name, ' -> ' ORDER BY a.ordinal, tc.seq) AS flow,
         group_concat(tc.sig,  ' -> ' ORDER BY a.ordinal, tc.seq) AS signature,
         count(*) AS steps
  FROM attempt a JOIN tool_call tc ON tc.attempt_row_id = a.id
  GROUP BY a.task_row_id
) f ON f.tid = v.task_row_id;

-- One row per agent loop. A caller's tool loop is N separate tasks sharing a
-- loop_id; this is where they become one thing again.
CREATE VIEW v_loop_flow AS
SELECT customer_id, loop_id,
       group_concat(flow,      ' -> ' ORDER BY turn_index, at) AS flow,
       group_concat(signature, ' -> ' ORDER BY turn_index, at) AS signature,
       count(*)                                  AS turns,
       sum(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cached_turns,
       sum(steps)                                AS calls,
       sum(cost_usd)                             AS cost_usd,
       sum(input_tokens)                         AS input_tokens,
       sum(output_tokens)                        AS output_tokens,
       min(at)  AS first_at,
       max(at)  AS last_at,
       min(ok)  AS ok,
       count(DISTINCT end_user_hash) AS end_users
FROM v_task_flow
WHERE loop_id IS NOT NULL
GROUP BY customer_id, loop_id
HAVING flow IS NOT NULL;

-- The view this whole store exists to serve: which agent procedures repeat,
-- how often, and what they cost.
CREATE VIEW v_repeated_flow AS
SELECT customer_id, flow, signature,
       count(*)          AS loops,
       sum(turns)        AS turns,
       sum(cached_turns) AS cached_turns,
       sum(calls)        AS calls,
       sum(cost_usd)     AS cost_usd,
       avg(cost_usd)     AS cost_per_loop,
       avg(ok)           AS ok_rate,
       min(first_at)     AS first_at,
       max(last_at)      AS last_at
FROM v_loop_flow
GROUP BY customer_id, flow, signature;

-- The steps of a flow enumerated, so a reader sees digikey_search(part) without
-- having to split a string.
CREATE VIEW v_flow_step AS
SELECT lf.customer_id, lf.flow, c.step, c.name, c.arg_keys_key, count(*) AS occurrences
FROM (
  SELECT t.customer_id, t.loop_id, tc.name, tc.arg_keys_key,
         row_number() OVER (PARTITION BY t.customer_id, t.loop_id
                            ORDER BY t.turn_index, t.at, a.ordinal, tc.seq) AS step
  FROM task t
  JOIN attempt a    ON a.task_row_id = t.id
  JOIN tool_call tc ON tc.attempt_row_id = a.id
  WHERE t.confidential = 0 AND t.loop_id IS NOT NULL
) c
JOIN v_loop_flow lf ON lf.customer_id = c.customer_id AND lf.loop_id = c.loop_id
GROUP BY lf.customer_id, lf.flow, c.step, c.name, c.arg_keys_key;

-- The other half of the traffic: the structured intake carries no transcript and
-- so no loop. Grouped by the same structural facts the corpus records.
CREATE VIEW v_repeated_shape AS
SELECT customer_id, skills_key, difficulty,
       coalesce(tool_input_keys_key, '') AS tool_input_keys_key,
       CASE WHEN artifact_count > 0 THEN 1 ELSE 0 END AS has_artifacts,
       count(*)                 AS occurrences,
       sum(cached)              AS cached,
       avg(ok)                  AS ok_rate,
       avg(first_attempt_ok)    AS first_attempt_ok_rate,
       sum(cost_usd)            AS cost_usd,
       sum(input_tokens)        AS input_tokens,
       sum(output_tokens)       AS output_tokens,
       min(at) AS first_at, max(at) AS last_at
FROM v_analysis_task
GROUP BY customer_id, skills_key, difficulty, tool_input_keys_key, has_artifacts;

-- What each person cost.
--
-- Built on v_task rather than v_analysis_task, and that is deliberate rather than
-- a forgotten filter: token counts, tier and cost are metadata ABOUT a decision,
-- not the content OF one, and a spend report with a hole in it where the
-- confidential work was is not a spend report. Every other view here answers
-- "what should we learn from", where excluding confidential work is right. This
-- one answers "who spent the money", where excluding it is a wrong number.
--
-- The column discipline is still v_task's — no content column appears below, and
-- the generic test walks sqlite_master to enforce that for any view added later.
--
-- user_id is NULL for tasks the planner submitted internally and for anything
-- recorded before callers were identified. Left NULL rather than coalesced to a
-- literal: a literal could collide with a real id, and inventing an identity is
-- the opposite of the point. SQLite groups the NULLs into one bucket already.
CREATE VIEW v_user_usage AS
SELECT customer_id, user_id,
       count(*)                                    AS task_count,
       sum(cached)                                 AS cached,
       avg(ok)                                     AS ok_rate,
       sum(attempts)                               AS attempts,
       sum(input_tokens)                           AS input_tokens,
       sum(output_tokens)                          AS output_tokens,
       sum(input_tokens) + sum(output_tokens)      AS total_tokens,
       sum(cost_usd)                               AS cost_usd,
       count(DISTINCT loop_id)                     AS loops,
       sum(CASE WHEN confidential = 1 THEN 1 ELSE 0 END) AS confidential_count,
       min(at) AS first_at, max(at) AS last_at
FROM v_task
GROUP BY customer_id, user_id;

-- The same, per day, for the shape of a month rather than its total.
--
-- \`day\` is UTC, because \`at\` is epoch milliseconds and SQLite's unixepoch
-- modifier has no timezone. \`day_start_ms\` is emitted beside it so a consumer
-- that cares can re-bucket locally without reverse-engineering the string.
CREATE VIEW v_user_usage_day AS
SELECT customer_id, user_id,
       date(at / 1000, 'unixepoch')                     AS day,
       unixepoch(date(at / 1000, 'unixepoch')) * 1000    AS day_start_ms,
       count(*)                               AS task_count,
       sum(cached)                            AS cached,
       sum(input_tokens)                      AS input_tokens,
       sum(output_tokens)                     AS output_tokens,
       sum(input_tokens) + sum(output_tokens) AS total_tokens,
       sum(cost_usd)                          AS cost_usd
FROM v_task
GROUP BY customer_id, user_id, day;

-- Where one person's spend actually went.
--
-- The question a per-user total provokes and cannot answer: "why is Ada's bill
-- all per-token Gemini when everyone else is on a seat". That needs the attempt's
-- own tier, billing and model, so this joins task to attempt directly rather than
-- going through v_task, whose sums have already collapsed them.
CREATE VIEW v_user_model AS
SELECT t.customer_id, t.user_id, a.tier, a.billing, a.agent, a.runtime, a.model,
       count(*)                                     AS attempts,
       avg(a.ok)                                    AS ok_rate,
       sum(a.degraded)                              AS degraded,
       sum(a.input_tokens)                          AS input_tokens,
       sum(a.output_tokens)                         AS output_tokens,
       sum(a.input_tokens) + sum(a.output_tokens)   AS total_tokens,
       sum(a.cost_usd)                              AS cost_usd,
       sum(a.duration_ms)                           AS duration_ms,
       min(t.at) AS first_at, max(t.at) AS last_at
FROM task t JOIN attempt a ON a.task_row_id = t.id
GROUP BY t.customer_id, t.user_id, a.tier, a.billing, a.agent, a.runtime, a.model;
`;
