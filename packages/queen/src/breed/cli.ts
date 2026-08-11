import "@hive/shared/env";
import { join, resolve } from "node:path";
import { CostEstimator, loadCatalog } from "@hive/shared";
import { TaskEpisodeLog, episodeDbPath } from "../episode.js";
import * as query from "./query.js";
import { buildCorpus, parseSince } from "./corpus.js";
import { DEFAULTS, survey, type Assessment, type Gate } from "./detect.js";

/**
 * Reading the hive's record of what it has been doing.
 *
 * The hive organizes its usage logs and hands them over; deciding which
 * recurring workflow is worth replacing with a program, and writing that
 * program, is work for a person or a better model. So there are two kinds of
 * command here, and the difference is the point:
 *
 *   flows, shapes, sql, export   report facts, and offer no opinion
 *   survey                       one opinionated reading, kept as an example
 *
 * `survey` came first and is frozen. Its gates and thresholds are a demonstration
 * that this corpus answers a question, not the hive's answer to it — anyone
 * mining seriously should run their own queries against the views, which are the
 * documented interface and are not going to move under them.
 *
 * Nothing here talks to a running Queen, and every connection is read-only: the
 * corpus is a file, so this works on a hive that is stopped and cannot damage
 * one that is running.
 *
 *   npm run breed -- flows  [--customer X] [--min N] [--since 30d] [--json]
 *   npm run breed -- steps  [--flow "a -> b"] [--json]
 *   npm run breed -- shapes [--customer X] [--min N] [--since 30d] [--json]
 *   npm run breed -- sql    "SELECT ... FROM v_repeated_flow"
 *   npm run breed -- survey [--customer X] [--min N] [--since 30d] [--json] [--all]
 */

const ROOT = resolve(process.env.HIVE_ROOT ?? ".");

interface Args {
  command: string;
  rest: string[];
  customer?: string;
  min?: number;
  since?: string;
  flow?: string;
  json: boolean;
  all: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "", rest: [], json: false, all: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--all") args.all = true;
    else if (a === "--customer") args.customer = argv[++i];
    else if (a === "--min") args.min = Number(argv[++i]);
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--flow") args.flow = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unrecognized argument "${a}"`);
    // A bare argument is the command's own — a SQL statement, say.
    else args.rest.push(a);
  }
  return args;
}

const ago = (ms: number): string => {
  const h = (Date.now() - ms) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/**
 * What repeats, in call order.
 *
 * Facts only: how many times a procedure ran, what it cost, when it was last
 * seen. Whether any of it is worth hardening is the reader's call.
 */
function printFlows(rows: query.FlowRow[], root: string): void {
  console.log("");
  if (rows.length === 0) {
    console.log("  no repeated agent flows recorded yet.");
    console.log("  (a flow is recorded when a caller supplies tools and the model calls them)");
    return;
  }
  const w = Math.min(52, Math.max(20, ...rows.map((r) => r.flow.length)));
  console.log(`  ${pad("flow", w)} ${rpad("loops", 6)} ${rpad("turns", 6)} ${rpad("cost", 9)} ${rpad("per loop", 9)}  last seen`);
  console.log(`  ${"-".repeat(w)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(9)} ${"-".repeat(9)}  ---------`);
  for (const r of rows) {
    console.log(
      `  ${pad(r.flow, w)} ${rpad(String(r.loops), 6)} ${rpad(String(r.turns), 6)} ` +
        `${rpad(usd(r.cost_usd), 9)} ${rpad(`$${r.cost_per_loop.toFixed(4)}`, 9)}  ${ago(r.last_at)}`,
    );
  }
  const held = query.withheld(root);
  if (held.length) {
    const n = held.reduce((s, h) => s + h.rows_withheld, 0);
    console.log(`\n  ${n} confidential row(s) were withheld and not read.`);
  }
  console.log("");
  console.log("  These are the hive's own views. Query them directly for anything else:");
  console.log(`    sqlite3 ${episodeDbPath(root)} "SELECT * FROM v_repeated_flow"`);
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number | undefined) => (n === undefined ? "—" : `${(n * 100).toFixed(0)}%`);
const pad = (s: string, w: number) => s.padEnd(w).slice(0, w);
const rpad = (s: string, w: number) => s.padStart(w).slice(-w);

/** Column widths, in one place so the header and the rows cannot disagree. */
const COL = { shape: 14, verdict: 13, occ: 5, ok: 5, first: 5, counter: 14, data: 9 };

/**
 * What the volatility signal is telling the person reading the table.
 *
 * Printed as a hint about what to build rather than as a verdict: `live` is the
 * mark of work that reads an outside system, and it is the case the gates used to
 * throw away.
 */
const DATA_NOTE: Record<string, string> = {
  live: "the answer changed between asks while keeping its shape — an outside system, read live",
  mixed: "some answers changed between asks; part of this shape reads live data",
  stable: "the same request always gave the same answer — a pure transformation",
  unknown: "no request repeated often enough to tell",
};

const MARK: Record<Gate["result"], string> = { pass: "ok", fail: "NO", unknown: "??" };

function printSurvey(
  rows: Assessment[],
  meta: { basis: string; rowsRead: number; rowsWithText: number; withheldRows: number },
): void {
  console.log("");
  console.log(`  corpus: ${meta.rowsRead} task row(s), grouped on ${meta.basis}`);
  if (meta.withheldRows > 0) {
    // A count is not content, and an unstated omission reads as completeness.
    console.log(`          ${meta.withheldRows} confidential row(s) withheld and not read`);
  }
  // Only when there is actually a corpus: an empty one is at no fidelity, and
  // blaming `metadata` for it sends the operator to fix the wrong thing.
  if (meta.rowsRead > 0 && meta.basis === "structural") {
    // Worth saying plainly, and with the remedy attached. Without task text the
    // signature is skills + difficulty + toolInput keys, which lumps genuinely
    // different work together — and the operator is the one who can change it.
    console.log(
      `  note:   task text is not recorded, so shapes are coarse and the determinism\n` +
        `          and template gates cannot be evaluated at all. At this fidelity the\n` +
        `          survey can say how often work recurs and what it costs, and nothing\n` +
        `          else — it cannot name a single parameter.\n` +
        `          Set 'policy.recordEpisodes: tasks' in the customer profile to record\n` +
        `          task input and output (never the user's message or the plan rationale).`,
    );
  }
  console.log("");

  if (rows.length === 0) {
    console.log("  no shapes yet — run some work through the hive first.");
    return;
  }

  console.log(
    `  ${pad("shape", COL.shape)} ${pad("verdict", COL.verdict)} ${rpad("occ", COL.occ)} ${rpad("ok", COL.ok)} ` +
      `${rpad("1st", COL.first)} ${rpad("counterfactual", COL.counter)} ${rpad("data", COL.data)}  skills`,
  );
  console.log(
    `  ${"-".repeat(COL.shape)} ${"-".repeat(COL.verdict)} ${"-".repeat(COL.occ)} ${"-".repeat(COL.ok)} ` +
      `${"-".repeat(COL.first)} ${"-".repeat(COL.counter)} ${"-".repeat(COL.data)}  ------`,
  );

  for (const r of rows) {
    console.log(
      `  ${pad(r.shape.shapeId, COL.shape)} ${pad(r.verdict, COL.verdict)} ` +
        `${rpad(String(r.stats.occurrences), COL.occ)} ${rpad(pct(r.stats.okRate), COL.ok)} ` +
        `${rpad(pct(r.stats.firstAttemptOkRate), COL.first)} ${rpad(usd(r.projectedSavingsUsd), COL.counter)} ` +
        `${rpad(r.signals.volatility, COL.data)}  ${r.shape.skills.join(",") || "(none)"}`,
    );
    // What a candidate is, before what is wrong with it: for a shape that passed,
    // the useful line is what kind of program it wants to be.
    const note = DATA_NOTE[r.signals.volatility];
    if (r.verdict === "candidate" && note) console.log(`  ${" ".repeat(COL.shape)}   -> ${note}`);
    // Then only the gates that did not pass, because those are the actionable
    // part — a shape's verdict is uninteresting next to the reason for it.
    for (const g of r.gates.filter((g) => g.result !== "pass")) {
      console.log(`  ${" ".repeat(COL.shape)}   ${MARK[g.result]} ${g.name}: ${g.detail}`);
    }
  }

  console.log("");
  const candidates = rows.filter((r) => r.verdict === "candidate");
  const total = candidates.reduce((s, r) => s + r.projectedSavingsUsd, 0);
  console.log(
    `  ${candidates.length} candidate(s), ${rows.filter((r) => r.verdict === "unassessable").length} unassessable, ` +
      `${rows.filter((r) => r.verdict === "rejected").length} rejected`,
  );
  if (candidates.length) {
    console.log(`  breeding all candidates would stop ${usd(total)} of counterfactual spend recurring.`);
  }
  // The number is re-priced from observed token counts, not measured. Say so
  // every time it is printed, the way the scoreboard does.
  console.log(`  (counterfactual = observed tokens re-priced at frontier rates; an estimate, not a bill)`);
}

const USAGE = [
  "usage: npm run breed -- <command>",
  "",
  "  reports facts:",
  "    flows  [--customer X] [--min N] [--since 30d] [--json]   which agent tool-call procedures repeat",
  "    steps  [--flow \"a -> b\"] [--json]                        the steps of each flow, in order",
  "    shapes [--customer X] [--min N] [--since 30d] [--json]   recurring work on the structured intake",
  "    sql    \"SELECT ...\"                                      your own query, read-only",
  "",
  "  offers an opinion (one worked example, frozen):",
  "    survey [--customer X] [--min N] [--since 30d] [--json] [--all]",
].join("\n");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const opts = { root: ROOT, customer: args.customer, min: args.min, since: args.since };

  const emit = (rows: unknown[], print: () => void): void => {
    if (args.json) console.log(JSON.stringify(rows, null, 2));
    else print();
  };

  switch (args.command) {
    case "flows":
      return emit(query.flows(opts), () => printFlows(query.flows(opts), ROOT));
    case "steps": {
      const rows = query.steps(opts, args.flow);
      return emit(rows, () => {
        console.log("");
        for (const s of rows) console.log(`  ${pad(s.flow, 44)} ${s.step}. ${s.name}(${s.arg_keys_key})`);
        if (rows.length === 0) console.log("  no flows recorded yet.");
      });
    }
    case "shapes": {
      const rows = query.shapes(opts);
      return emit(rows, () => {
        console.log("");
        if (rows.length === 0) return console.log("  nothing recorded yet.");
        console.log(`  ${pad("skills", 24)} ${pad("difficulty", 11)} ${pad("toolInput keys", 18)} ${rpad("n", 5)} ${rpad("cost", 9)}`);
        for (const s of rows) {
          console.log(
            `  ${pad(s.skills_key || "(none)", 24)} ${pad(s.difficulty ?? "—", 11)} ` +
              `${pad(s.tool_input_keys_key || "—", 18)} ${rpad(String(s.occurrences), 5)} ${rpad(usd(s.cost_usd), 9)}`,
          );
        }
      });
    }
    case "sql": {
      const statement = args.rest.join(" ").trim();
      if (!statement) throw new Error('sql needs a statement, e.g. breed -- sql "SELECT * FROM v_repeated_flow"');
      const rows = query.sql(ROOT, statement);
      // Always JSON: whatever a caller asked for, this cannot know the shape of.
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    case "survey":
      break;
    default:
      console.error(USAGE);
      process.exitCode = 1;
      return;
  }

  const estimator = new CostEstimator(loadCatalog(join(ROOT, "llm_model_api_catalog.yaml")));
  const since = parseSince(args.since, Date.now());
  let rows = new TaskEpisodeLog(ROOT).readAll({ since });
  if (args.customer) rows = rows.filter((r) => r.customerId === args.customer);

  const corpus = buildCorpus(rows);
  const thresholds = args.min === undefined ? DEFAULTS : { ...DEFAULTS, minSamples: args.min };
  const all = survey(corpus.shapes, estimator, thresholds);
  const shown = args.all ? all : all.filter((r) => r.verdict !== "rejected");

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          basis: corpus.basis,
          rowsRead: corpus.rowsRead,
          rowsWithText: corpus.rowsWithText,
          withheldRows: corpus.withheldRows,
          thresholds,
          shapes: shown.map((r) => ({
            shapeId: r.shape.shapeId,
            customerId: r.shape.customerId,
            verdict: r.verdict,
            skills: r.shape.skills,
            difficulty: r.shape.difficulty,
            toolInputKeys: r.shape.toolInputKeys,
            titleTokens: r.shape.titleTokens,
            stats: r.stats,
            gates: r.gates,
            signals: r.signals,
            projectedSavingsUsd: r.projectedSavingsUsd,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  printSurvey(shown, corpus);
  if (!args.all && all.length !== shown.length) {
    console.log(`  (${all.length - shown.length} rejected shape(s) hidden; --all to see them)`);
  }
}

main().catch((err) => {
  console.error(`[breed] ${String(err instanceof Error ? err.message : err)}`);
  process.exitCode = 1;
});
