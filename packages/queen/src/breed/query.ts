import { episodeDbPath } from "../episode.js";
import { openEpisodeDb } from "../episodeDb.js";
import { parseSince } from "./corpus.js";

/**
 * Reading the corpus, for people and programs that are not the hive.
 *
 * These commands report facts and offer no opinion. They are thin on purpose:
 * the queries they run are the documented views, so anyone with `sqlite3` — or
 * any language with a SQLite driver, or a model handed the file — gets the same
 * answers without going through this code at all. The CLI exists because not
 * every consumer has `sqlite3` installed, not because the database needs a
 * gatekeeper.
 *
 * Every connection here is read-only, which makes "this cannot damage the
 * corpus" a property of the handle rather than a promise in a comment.
 */

export interface QueryOpts {
  root: string;
  customer?: string;
  min?: number;
  since?: string;
}

function read<T>(root: string, sql: string, params: unknown[] = []): T[] {
  const db = openEpisodeDb(episodeDbPath(root), { readOnly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

/** True when there is no corpus yet — a hive that has not run, not an error. */
export function corpusExists(root: string): boolean {
  try {
    read(root, "SELECT 1 FROM task LIMIT 1");
    return true;
  } catch {
    return false;
  }
}

export interface FlowRow {
  customer_id: string;
  flow: string;
  signature: string;
  loops: number;
  turns: number;
  cached_turns: number;
  calls: number;
  cost_usd: number;
  cost_per_loop: number;
  ok_rate: number;
  first_at: number;
  last_at: number;
}

/**
 * Which agent procedures repeat, how often, and what they cost.
 *
 * The one question this whole store exists to answer. A caller's tool loop is
 * several separate requests; `v_loop_flow` puts them back together, and this
 * groups the results by the sequence of calls.
 */
export function flows(o: QueryOpts): FlowRow[] {
  const since = parseSince(o.since, Date.now());
  const where: string[] = [];
  const params: unknown[] = [];
  if (o.customer) {
    where.push("customer_id = ?");
    params.push(o.customer);
  }
  if (since !== undefined) {
    where.push("last_at >= ?");
    params.push(since);
  }
  if (o.min !== undefined) {
    where.push("loops >= ?");
    params.push(o.min);
  }
  const sql =
    "SELECT * FROM v_repeated_flow" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY cost_usd DESC, loops DESC";
  return read<FlowRow>(o.root, sql, params);
}

export interface StepRow {
  flow: string;
  step: number;
  name: string;
  arg_keys_key: string;
  occurrences: number;
}

/** The steps of each flow, enumerated, so nobody has to split a string. */
export function steps(o: QueryOpts, flow?: string): StepRow[] {
  const sql =
    "SELECT flow, step, name, arg_keys_key, occurrences FROM v_flow_step" +
    (flow ? " WHERE flow = ?" : "") +
    " ORDER BY flow, step";
  return read<StepRow>(o.root, sql, flow ? [flow] : []);
}

export interface ShapeRow {
  customer_id: string;
  skills_key: string;
  difficulty: string | null;
  tool_input_keys_key: string;
  has_artifacts: number;
  occurrences: number;
  cached: number;
  ok_rate: number;
  first_attempt_ok_rate: number | null;
  cost_usd: number;
  first_at: number;
  last_at: number;
}

/**
 * The other half of the traffic: work submitted through the structured intake,
 * which carries no transcript and therefore no loop to reconstruct.
 */
export function shapes(o: QueryOpts): ShapeRow[] {
  const since = parseSince(o.since, Date.now());
  const where: string[] = [];
  const params: unknown[] = [];
  if (o.customer) {
    where.push("customer_id = ?");
    params.push(o.customer);
  }
  if (since !== undefined) {
    where.push("last_at >= ?");
    params.push(since);
  }
  if (o.min !== undefined) {
    where.push("occurrences >= ?");
    params.push(o.min);
  }
  const sql =
    "SELECT * FROM v_repeated_shape" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY cost_usd DESC, occurrences DESC";
  return read<ShapeRow>(o.root, sql, params);
}

/** How much of the traffic the corpus was not allowed to look at. */
export function withheld(root: string): Array<{ customer_id: string; rows_withheld: number }> {
  return read(root, "SELECT customer_id, rows_withheld FROM v_withheld ORDER BY rows_withheld DESC");
}

/**
 * Run a caller's own query.
 *
 * Read-only by construction, so a mistyped `DELETE` fails rather than costing
 * somebody their history. Deliberately unrestricted otherwise: the point of
 * publishing a schema is that people ask questions nobody anticipated.
 */
export function sql(root: string, statement: string): unknown[] {
  return read(root, statement);
}
