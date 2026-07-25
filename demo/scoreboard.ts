import "@hive/shared/env";
import { join, resolve } from "node:path";
import { CostEstimator, loadCatalog } from "@hive/shared";

/**
 * What the hive actually spent, and what the same work would have cost if every
 * task had gone to a frontier model.
 *
 * The counterfactual is COMPUTED, not measured: we take each task's real token
 * counts and re-price them at frontier rates through the same CostEstimator and
 * the same llm_model_api_catalog.yaml the ledger uses. Nothing is run twice, so
 * this costs nothing and is deterministic — but it is an estimate, and the
 * output labels it as one.
 *
 *   npm run scoreboard
 */

const QUEEN = process.env.QUEEN_URL ?? "http://localhost:4100";
const ROOT = resolve(process.env.HIVE_ROOT ?? ".");

/** Reference frontier models for the "what if we'd just used the best" column. */
const FRONTIER = "claude-opus-4-6";
const FRONTIER_ALT = "gpt-5.5";

/**
 * Tier-4 tool tasks and cache hits do no LLM work, so they have no token counts
 * to re-price. To value them we borrow the Queen's own sizing convention from
 * QueenCore.estimateUsd — rough prompt tokens + 1000, and 2000 out — rather than
 * inventing a second one. Flagged in the output, because it is an assumption.
 */
const ASSUMED_OUTPUT_TOKENS = 2000;

interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
interface TaskResult {
  agentId: string;
  tierUsed: number;
  runtime: string;
  model?: string;
  billing: string;
  seatId?: string;
  degraded: boolean;
  usage: Usage;
  ok: boolean;
}
interface TaskState {
  taskId: string;
  spec: { title: string; input: string };
  status: string;
  result?: TaskResult;
}

const BEE_OF_TIER: Record<number, { icon: string; name: string }> = {
  1: { icon: "🍯", name: "honey bee" },
  2: { icon: "💵", name: "metered bee" },
  3: { icon: "🏠", name: "local bee" },
  4: { icon: "🐝", name: "worker bee" },
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${QUEEN}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  const estimator = new CostEstimator(loadCatalog(join(ROOT, "llm_model_api_catalog.yaml")));

  let status: {
    workers: Array<{ agentId: string }>;
    budget: {
      customers: Array<{ customerId: string; capUsd: number; spentUsd: number }>;
      seats: Array<{ seatId: string; tokensPerWindow: number; usedTokens: number; remaining: number }>;
    };
    plannerCostUsd: number;
    tasks: Array<{ taskId: string; status: string }>;
  };
  try {
    status = await getJson("/status");
  } catch {
    console.error(`No queen at ${QUEEN} — start the hive with \`npm run solo\` first.`);
    process.exit(1);
  }

  const states = await Promise.all(
    status.tasks.map((t) => getJson<TaskState>(`/tasks/${t.taskId}`).catch(() => undefined)),
  );
  const done = states.filter((s): s is TaskState => !!s?.result);

  if (done.length === 0) {
    console.log(`\n  No completed tasks yet. Run \`bash demo/walkthrough.sh\` first.\n`);
    return;
  }

  type Row = { tasks: number; inTok: number; outTok: number; actual: number; frontier: number; assumed: number };
  const byBee = new Map<string, Row>();
  let assumedTasks = 0;

  for (const state of done) {
    const r = state.result!;
    // Emoji render two terminal columns but count as one unit to padEnd, so the
    // icon gets its own slot and only fixed-width text is padded.
    const bee = BEE_OF_TIER[r.tierUsed];
    const label = bee
      ? `${bee.icon} ${bee.name.padEnd(12)} ${r.agentId}`
      : `   ${`tier ${r.tierUsed}`.padEnd(12)} ${r.agentId}`;
    const row = byBee.get(label) ?? { tasks: 0, inTok: 0, outTok: 0, actual: 0, frontier: 0, assumed: 0 };

    let { inputTokens: inTok, outputTokens: outTok } = r.usage;
    let assumed = 0;
    if (inTok === 0 && outTok === 0) {
      // No LLM ran. Size it the way the Queen sizes an unstarted task.
      inTok = CostEstimator.roughTokens(state.spec.title + state.spec.input) + 1000;
      outTok = ASSUMED_OUTPUT_TOKENS;
      assumed = 1;
      assumedTasks++;
    }

    row.tasks++;
    row.inTok += r.usage.inputTokens;
    row.outTok += r.usage.outputTokens;
    row.actual += r.usage.costUsd;
    row.frontier += estimator.estimate(FRONTIER, inTok, outTok);
    row.assumed += assumed;
    byBee.set(label, row);
  }

  const totals = [...byBee.values()].reduce(
    (a, r) => ({
      tasks: a.tasks + r.tasks,
      inTok: a.inTok + r.inTok,
      outTok: a.outTok + r.outTok,
      actual: a.actual + r.actual,
      frontier: a.frontier + r.frontier,
      assumed: a.assumed + r.assumed,
    }),
    { tasks: 0, inTok: 0, outTok: 0, actual: 0, frontier: 0, assumed: 0 },
  );

  const usd = (n: number) => `$${n.toFixed(4)}`;
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number, w: number) => String(n).padStart(w);

  // The icon slot is 2 display columns; header/rule allow for it explicitly.
  const row = (label: string, r: Row) =>
    `  ${label} ${num(r.tasks, 6)} ${num(r.inTok, 9)} ${num(r.outTok, 9)} ${pad(usd(r.actual), 10)} ${pad(usd(r.frontier), 12)}`;
  const rule = "─".repeat(80);

  console.log(`\n  agent-hive · cost scoreboard\n`);
  // 29 for every label: the emoji are surrogate pairs, so their JS length and
  // their terminal width both come to 2 and the columns line up.
  const LABEL_W = 29;
  console.log(`  ${pad("   bee", LABEL_W)} ${pad("tasks", 6)} ${pad("in tok", 9)} ${pad("out tok", 9)} ${pad("actual", 10)} ${pad("all-frontier", 12)}`);
  console.log(`  ${rule}`);
  for (const [label, r] of [...byBee.entries()].sort()) console.log(row(pad(label, LABEL_W), r));
  console.log(`  ${rule}`);
  console.log(row(pad("   total", LABEL_W), totals));

  const plannerUsd = status.plannerCostUsd ?? 0;
  const spent = totals.actual + plannerUsd;
  const saved = totals.frontier - spent;
  const pct = totals.frontier > 0 ? (saved / totals.frontier) * 100 : 0;

  console.log(`\n  execution      ${usd(totals.actual)}`);
  console.log(`  planner        ${usd(plannerUsd)}   (the Queen's own model spend — never a hidden cost centre)`);
  console.log(`  spent          ${usd(spent)}`);
  console.log(`  all-frontier   ${usd(totals.frontier)}   (counterfactual, priced at ${FRONTIER} rates)`);
  if (saved > 0) {
    console.log(`\n  saved          ${usd(saved)}  ·  ${pct.toFixed(1)}% cheaper than routing everything to a frontier model`);
  }

  const altTotal = done.reduce((sum, s) => {
    const r = s.result!;
    let { inputTokens: i, outputTokens: o } = r.usage;
    if (i === 0 && o === 0) {
      i = CostEstimator.roughTokens(s.spec.title + s.spec.input) + 1000;
      o = ASSUMED_OUTPUT_TOKENS;
    }
    return sum + estimator.estimate(FRONTIER_ALT, i, o);
  }, 0);
  console.log(`  (at ${FRONTIER_ALT} rates the same work would be ${usd(altTotal)})`);

  if (assumedTasks > 0) {
    console.log(
      `\n  note: ${assumedTasks} of ${totals.tasks} tasks used zero tokens — tool matches and cache hits.\n` +
        `        They have no real usage to re-price, so their frontier column is sized the way the\n` +
        `        Queen sizes an unstarted task (rough prompt tokens + 1000 in, ${ASSUMED_OUTPUT_TOKENS} out).\n` +
        `        Everything else is priced from token counts the providers actually reported.`,
    );
  }

  const seats = status.budget.seats.filter((s) => s.usedTokens > 0);
  if (seats.length > 0) {
    console.log(`\n  seat quota burned (prepaid — costs dollars only if you exceed it)`);
    for (const s of seats) {
      const pctUsed = (s.usedTokens / s.tokensPerWindow) * 100;
      const width = 24;
      const filled = Math.min(width, Math.round((pctUsed / 100) * width));
      console.log(
        `    ${pad(s.seatId, 16)} [${"█".repeat(filled)}${"░".repeat(width - filled)}] ` +
          `${s.usedTokens}/${s.tokensPerWindow} tokens (${pctUsed.toFixed(1)}%)`,
      );
    }
  }

  console.log(`\n  usd caps`);
  for (const c of status.budget.customers) {
    console.log(`    ${pad(c.customerId, 16)} ${usd(c.spentUsd)} / ${usd(c.capUsd)}`);
  }
  console.log();
}

main().catch((err) => {
  console.error("[scoreboard]", err);
  process.exit(1);
});
