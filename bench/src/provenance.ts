import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a run was, written before the run happens.
 *
 * A benchmark number is a claim about a *version* of the hive under a *config*,
 * and neither is recoverable after the fact: the working tree moves on, the
 * fleet changes when a key is added or a model is pulled, and the ledger is
 * reset between runs. Recording it afterwards means recording whatever is true
 * then, which is a different thing that looks identical in a table.
 *
 * `dirty` is here because it is the field that invalidates everything else. A
 * run from an uncommitted tree is not reproducible and should not be cited; the
 * honest response is to record that plainly rather than to pretend the commit
 * SHA describes what ran.
 */
export interface RunRecord {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  git: { commit: string; branch: string; dirty: boolean };
  /** hash of the resolved config, so two runs can be compared without diffing files */
  configHash: string;
  configPath: string;
  config: unknown;
  /** the fleet as /v1/models reported it at the moment the run began */
  fleet: unknown;
  /** environment that changes what the hive does, without the secrets themselves */
  env: Record<string, string>;
  tasks: { planned: number; completed?: number; failed?: number };
  totals?: { costUsd: number; inputTokens: number; outputTokens: number; durationMs: number };
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Which env vars shaped this run, by name and presence — never by value.
 *
 * The keys are what make the metered bee exist at all, so whether one was set is
 * part of the experiment; what it was is a secret. Recording `set`/`unset` keeps
 * the record publishable, which is the point of writing it down.
 */
function environmentFingerprint(): Record<string, string> {
  const secrets = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "HIVE_API_KEYS"];
  const settings = [
    "HIVE_BROKER",
    "HIVE_PLANNER_MODEL",
    "HIVE_API_DRYRUN",
    "HIVE_MAX_CONCURRENT_TASKS",
    "HIVE_EXEC_TIMEOUT_MS",
    "HIVE_API_MAX_OUTPUT_TOKENS",
    "HIVE_RESULT_CACHE_TTL_MS",
    "OLLAMA_URL",
  ];
  const out: Record<string, string> = {};
  for (const name of secrets) out[name] = process.env[name] ? "set" : "unset";
  for (const name of settings) if (process.env[name]) out[name] = process.env[name]!;
  return out;
}

export function hashConfig(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12);
}

/**
 * A run id that sorts chronologically and still says what it was.
 *
 * Deliberately not a UUID: these are read in a directory listing by a person
 * trying to find the run they did on Tuesday against the cheap config.
 */
export function runId(configName: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${stamp}-${configName}`;
}

export class RunLog {
  readonly dir: string;
  private readonly record: RunRecord;

  constructor(root: string, record: RunRecord) {
    this.record = record;
    this.dir = join(root, "data", "bench", record.runId);
    mkdirSync(this.dir, { recursive: true });
    this.flush();
  }

  /** Header first, so an interrupted run still says what it was. */
  private flush(): void {
    writeFileSync(join(this.dir, "run.json"), `${JSON.stringify(this.record, null, 2)}\n`);
  }

  /** One line per task, appended as it finishes — a killed run keeps what it earned. */
  append(row: unknown): void {
    appendFileSync(join(this.dir, "results.jsonl"), `${JSON.stringify(row)}\n`);
  }

  finish(totals: RunRecord["totals"], counts: { completed: number; failed: number }): void {
    this.record.finishedAt = new Date().toISOString();
    this.record.totals = totals;
    this.record.tasks.completed = counts.completed;
    this.record.tasks.failed = counts.failed;
    this.flush();
  }
}

export function startRun(opts: {
  root: string;
  configPath: string;
  configName: string;
  config: unknown;
  fleet: unknown;
  plannedTasks: number;
}): RunLog {
  const record: RunRecord = {
    runId: runId(opts.configName),
    startedAt: new Date().toISOString(),
    git: {
      commit: git(["rev-parse", "HEAD"]),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty: git(["status", "--porcelain"]) !== "",
    },
    configHash: hashConfig(opts.config),
    configPath: opts.configPath,
    config: opts.config,
    fleet: opts.fleet,
    env: environmentFingerprint(),
    tasks: { planned: opts.plannedTasks },
  };
  return new RunLog(opts.root, record);
}
