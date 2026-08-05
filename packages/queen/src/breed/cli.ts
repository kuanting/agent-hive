import "@hive/shared/env";
import { join, resolve } from "node:path";
import { CostEstimator, loadCatalog } from "@hive/shared";
import { TaskEpisodeLog } from "../episode.js";
import { buildCorpus, parseSince } from "./corpus.js";
import { DEFAULTS, survey, type Assessment, type Gate } from "./detect.js";

/**
 * Breeding: turning a recurring workflow into a worker bee.
 *
 * `survey` is the first and cheapest step, and the only one that never spends
 * anything: it reads the task corpus the Queen has been writing and reports
 * which shapes recur often enough, reliably enough, and expensively enough to be
 * worth replacing with a program.
 *
 * It is useful on its own and before any of the rest exists — an operator can
 * read the table and hand-write a tier-4 tool, which DESIGN §8 already describes
 * as a two-line change. Nothing here talks to a running Queen: the corpus is a
 * file, so this works on a hive that is stopped.
 *
 *   npm run breed -- survey [--customer X] [--min N] [--since 30d] [--json] [--all]
 */

const ROOT = resolve(process.env.HIVE_ROOT ?? ".");

interface Args {
  command: string;
  customer?: string;
  min?: number;
  since?: string;
  json: boolean;
  all: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "", json: false, all: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--all") args.all = true;
    else if (a === "--customer") args.customer = argv[++i];
    else if (a === "--min") args.min = Number(argv[++i]);
    else if (a === "--since") args.since = argv[++i];
    else throw new Error(`unrecognized argument "${a}"`);
  }
  return args;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number | undefined) => (n === undefined ? "—" : `${(n * 100).toFixed(0)}%`);
const pad = (s: string, w: number) => s.padEnd(w).slice(0, w);
const rpad = (s: string, w: number) => s.padStart(w).slice(-w);

/** Column widths, in one place so the header and the rows cannot disagree. */
const COL = { shape: 14, verdict: 13, occ: 5, ok: 5, first: 5, counter: 14, observed: 9 };

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
      `${rpad("1st", COL.first)} ${rpad("counterfactual", COL.counter)} ${rpad("observed", COL.observed)}  skills`,
  );
  console.log(
    `  ${"-".repeat(COL.shape)} ${"-".repeat(COL.verdict)} ${"-".repeat(COL.occ)} ${"-".repeat(COL.ok)} ` +
      `${"-".repeat(COL.first)} ${"-".repeat(COL.counter)} ${"-".repeat(COL.observed)}  ------`,
  );

  for (const r of rows) {
    console.log(
      `  ${pad(r.shape.shapeId, COL.shape)} ${pad(r.verdict, COL.verdict)} ` +
        `${rpad(String(r.stats.occurrences), COL.occ)} ${rpad(pct(r.stats.okRate), COL.ok)} ` +
        `${rpad(pct(r.stats.firstAttemptOkRate), COL.first)} ${rpad(usd(r.projectedSavingsUsd), COL.counter)} ` +
        `${rpad(usd(r.stats.observedUsd), COL.observed)}  ${r.shape.skills.join(",") || "(none)"}`,
    );
    // Only the gates that did not pass, because those are the actionable part —
    // a shape's verdict is uninteresting next to the reason for it.
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "survey") {
    console.error("usage: npm run breed -- survey [--customer X] [--min N] [--since 30d] [--json] [--all]");
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
