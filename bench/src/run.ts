import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse } from "yaml";
import { HiveClient, type Completion } from "./client.js";
import { startRun } from "./provenance.js";

/**
 * Walk a task file through the hive once per model under test, and write down
 * everything needed to explain the numbers afterwards.
 *
 *   npm run bench -- bench/configs/smoke.yaml
 *
 * Scaffolding, and honest about it: this drives single-turn prompts, which is
 * what a cost/routing comparison needs and what no public agent benchmark
 * actually is. Benchmark-specific adapters belong in `src/adapters/` and are
 * better written against a real harness than guessed at now.
 */

interface BenchConfig {
  name?: string;
  /** one entry per arm of the comparison; `hive/auto` versus a pinned capability is the usual shape */
  models: string[];
  tasks: string;
  /** passed through to every request, so an arm can be run at a fixed temperature */
  params?: Record<string, unknown>;
  /** repeat each task this many times, for variance on a non-deterministic system */
  repeats?: number;
}

interface Task {
  id: string;
  messages: Array<{ role: string; content: string }>;
  /** free-form, carried into the results so an analysis can group by it */
  tags?: string[];
}

function loadTasks(path: string): Task[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .map((line, i) => {
      const raw = JSON.parse(line) as Partial<Task> & { prompt?: string };
      return {
        id: raw.id ?? `t${i + 1}`,
        // A bare `prompt` is allowed because most task files are a list of
        // questions, and making everyone write the messages array by hand buys
        // nothing.
        messages: raw.messages ?? [{ role: "user", content: raw.prompt ?? "" }],
        tags: raw.tags,
      };
    });
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("usage: npm run bench -- <config.yaml>");
    process.exit(1);
  }
  const root = resolve(process.env.HIVE_ROOT ?? ".");
  const config = parse(readFileSync(configPath, "utf8")) as BenchConfig;
  const tasks = loadTasks(resolve(root, config.tasks));
  const repeats = config.repeats ?? 1;
  const client = new HiveClient();

  // Fail here rather than after an hour of work: if the hive is not up, or the
  // key is wrong, every task would record the same transport error.
  const fleet = await client.models().catch((err) => {
    console.error(`[bench] cannot reach the hive: ${err}`);
    process.exit(1);
  });

  const planned = tasks.length * config.models.length * repeats;
  const log = startRun({
    root,
    configPath,
    configName: config.name ?? basename(configPath).replace(/\.ya?ml$/, ""),
    config,
    fleet,
    plannedTasks: planned,
  });
  console.log(`[bench] ${log.dir}`);
  console.log(`[bench] ${planned} calls: ${tasks.length} tasks x ${config.models.length} model(s) x ${repeats}`);

  const totals = { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  let completed = 0;
  let failed = 0;

  for (const model of config.models) {
    for (let rep = 1; rep <= repeats; rep++) {
      for (const task of tasks) {
        const out: Completion = await client.complete({
          model,
          messages: task.messages,
          ...(config.params ?? {}),
        });
        // A refusal arrives as a normal 200 with `x_hive.refused` set. It is an
        // outcome, not an error — and for this hive it is one of the more
        // interesting outcomes, so it is counted separately from a transport
        // failure rather than lumped in with it.
        const refused = out.hive?.refused;
        if (out.error || refused) failed += 1;
        else completed += 1;

        totals.costUsd += out.hive?.cost_usd ?? 0;
        totals.inputTokens += out.usage.prompt_tokens;
        totals.outputTokens += out.usage.completion_tokens;
        totals.durationMs += out.wallMs;

        log.append({
          taskId: task.id,
          tags: task.tags,
          model,
          repeat: rep,
          content: out.content,
          finishReason: out.finishReason,
          toolCalls: out.toolCalls,
          usage: out.usage,
          hive: out.hive,
          error: out.error,
          wallMs: out.wallMs,
        });

        const mark = out.error ? "!" : refused ? "-" : ".";
        process.stdout.write(mark);
      }
    }
  }

  process.stdout.write("\n");
  log.finish(totals, { completed, failed });
  console.log(
    `[bench] ${completed} ok, ${failed} refused/failed, ` +
      `$${totals.costUsd.toFixed(4)}, ${(totals.durationMs / 1000).toFixed(1)}s of wall time`,
  );
  console.log(`[bench] ${log.dir}/results.jsonl`);
}

main().catch((err) => {
  console.error("[bench] fatal:", err);
  process.exit(1);
});
