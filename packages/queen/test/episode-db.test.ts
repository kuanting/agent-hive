import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskEpisodeLog, episodeDbPath, type EpisodeAttempt, type TaskEpisode } from "../src/episode.js";
import { openEpisodeDb, SchemaTooNewError } from "../src/episodeDb.js";
import { CONTENT_COLUMNS, SCHEMA_VERSION } from "../src/episodeSchema.js";
import { importLegacyJsonl } from "../src/episodeImport.js";

/**
 * The corpus as a queryable thing, which is the point of storing it at all.
 *
 * The hive's job is to organize what it did and hand it over; finding the
 * recurring workflow in here, and writing the tool that replaces it, is somebody
 * else's. So the tests that matter most are the ones about the handover: that a
 * row survives the round trip intact, that the views answer the question people
 * will actually ask, and that none of it leaks text the privacy ratchet removed.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "episode-db-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const attempt = (over: Partial<EpisodeAttempt> = {}): EpisodeAttempt => ({
  attempt: 1,
  tier: 2,
  runtime: "api",
  ok: true,
  degraded: false,
  inputTokens: 900,
  outputTokens: 120,
  costUsd: 0.004,
  durationMs: 1200,
  ...over,
});

const row = (over: Partial<TaskEpisode> = {}): TaskEpisode => ({
  taskId: "t1",
  customerId: "aiotlab",
  at: Date.now(),
  mode: "metadata",
  skills: [],
  artifactCount: 0,
  attempts: [attempt()],
  ok: true,
  wallMs: 1200,
  ...over,
});

/** One turn of a caller's agent loop. */
const loopTurn = (loopId: string, turnIndex: number, calls: Array<[string, string[]]>, at: number): TaskEpisode =>
  row({
    taskId: `${loopId}-${turnIndex}`,
    at,
    loopId,
    turnIndex,
    declaredTools: ["digikey_search", "get_price"],
    attempts: [
      attempt({
        toolCallNames: calls.map(([n]) => n),
        toolCallArgKeys: calls.map(([, k]) => k),
      }),
    ],
  });

describe("a row survives the round trip", () => {
  it("keeps every field, including what was absent", () => {
    const log = new TaskEpisodeLog(root);
    const full = row({
      mode: "full",
      downgradedReason: undefined,
      skills: ["sourcing"],
      difficulty: "standard",
      sensitivity: "normal",
      toolInputKeys: ["part"],
      artifactCount: 2,
      cached: false,
      userId: "ada",
      endUserHash: "abc123abc123",
      loopId: "loop-1",
      turnIndex: 3,
      declaredTools: ["digikey_search"],
      title: "price lookup",
      input: "price for LM358N",
      output: "LM358N: $1.20",
      toolInput: { part: "LM358N" },
      attempts: [
        attempt({ agent: "gemini", model: "gemini-3-flash-preview", billing: "per-token", error: "none" }),
        attempt({ attempt: 2, tier: 1, ok: false, degraded: true, toolCallNames: ["get_price"], toolCallArgKeys: [["sku"]] }),
      ],
    });
    log.append(full);
    expect(log.readAll()).toEqual([full]);
  });

  it("tells an absent field from an empty one", () => {
    // SQL has neither `undefined` nor booleans, so the mapping has to carry the
    // distinction itself. `cached: undefined` means "not a cache hit"; a runtime
    // that reported no tool-call field at all is not one that reported an empty
    // list, and only the second should read back as `[]`.
    const log = new TaskEpisodeLog(root);
    const absent = row({ taskId: "absent" });
    const empty = row({ taskId: "empty", cached: false, attempts: [attempt({ toolCallNames: [] })] });
    log.append(absent);
    log.append(empty);

    const [a, b] = log.readAll();
    expect(a.cached).toBeUndefined();
    expect(a.attempts[0].toolCallNames).toBeUndefined();
    expect(b.cached).toBe(false);
    expect(b.attempts[0].toolCallNames).toEqual([]);
  });

  it("keeps both rows when a cache hit reuses a task id", () => {
    // The single easiest way to get this schema catastrophically wrong: a cache
    // hit deliberately writes a second row carrying the reused task's id, and
    // those rows are the evidence a shape RECURS. A unique key on task_id would
    // have deleted exactly them.
    const log = new TaskEpisodeLog(root);
    log.append(row({ taskId: "same" }));
    log.append(row({ taskId: "same", cached: true, attempts: [] }));
    expect(log.readAll()).toHaveLength(2);
  });
});

describe("the views are the API", () => {
  /** 12 runs of one two-step agent procedure, at the default fidelity. */
  function seedDigikey(): void {
    const log = new TaskEpisodeLog(root);
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      const at = now - (12 - i) * 3_600_000;
      log.append(loopTurn(`loop-${i}`, 1, [["digikey_search", ["part"]]], at));
      log.append(loopTurn(`loop-${i}`, 3, [["get_price", ["sku"]]], at + 2000));
    }
  }

  const query = <T>(sql: string): T[] => {
    const db = openEpisodeDb(episodeDbPath(root), { readOnly: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  };

  it("answers which agent flows repeat, from the documented query", () => {
    seedDigikey();
    const rows = query<{ flow: string; signature: string; loops: number; turns: number; cost_usd: number }>(
      "SELECT flow, signature, loops, turns, cost_usd FROM v_repeated_flow WHERE loops >= 12 ORDER BY cost_usd DESC",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].flow).toBe("digikey_search -> get_price");
    // The signature carries the parameter names, so a reader does not have to
    // guess what the procedure takes.
    expect(rows[0].signature).toBe("digikey_search(part) -> get_price(sku)");
    expect(rows[0].loops).toBe(12);
    expect(rows[0].turns).toBe(24);
    expect(rows[0].cost_usd).toBeGreaterThan(0);
  });

  it("enumerates the steps, so nobody has to split a string", () => {
    seedDigikey();
    const steps = query<{ step: number; name: string; arg_keys_key: string }>(
      "SELECT step, name, arg_keys_key FROM v_flow_step ORDER BY step",
    );
    expect(steps.map((s) => [s.step, s.name, s.arg_keys_key])).toEqual([
      [1, "digikey_search", "part"],
      [2, "get_price", "sku"],
    ]);
  });

  it("finds the flow with no task text on disk at all", () => {
    // The whole claim of recording call names rather than prose: this works at
    // `metadata`, the default, where nothing a user wrote is stored.
    seedDigikey();
    const [content] = query<{ n: number }>(
      "SELECT count(*) AS n FROM task WHERE title IS NOT NULL OR input IS NOT NULL OR output IS NOT NULL OR tool_input IS NOT NULL",
    );
    expect(content.n).toBe(0);
    expect(query("SELECT * FROM v_repeated_flow")).toHaveLength(1);
  });

  it("never exposes a content column from any view", () => {
    // Generic on purpose: a view added a year from now cannot quietly widen what
    // is readable without failing here.
    seedDigikey();
    const views = query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'view'");
    expect(views.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const v of views) {
      for (const col of query<{ name: string }>(`SELECT name FROM pragma_table_info('${v.name}')`)) {
        if ((CONTENT_COLUMNS as readonly string[]).includes(col.name)) offenders.push(`${v.name}.${col.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("excludes confidential work from analysis, and says how much it withheld", () => {
    const log = new TaskEpisodeLog(root);
    for (let i = 0; i < 3; i++) log.append(row({ taskId: `open-${i}`, skills: ["reporting"] }));
    log.append(row({ taskId: "secret", sensitivity: "confidential" }));
    log.append(row({ taskId: "ratcheted", downgradedReason: "task was confidential" }));

    expect(query("SELECT * FROM v_analysis_task")).toHaveLength(3);
    const [withheld] = query<{ rows_withheld: number }>("SELECT rows_withheld FROM v_withheld");
    expect(withheld.rows_withheld).toBe(2);
  });
});

describe("upgrading from the JSONL corpus", () => {
  it("carries a previous version's history in, and does not do it twice", () => {
    // The corpus is the one store here that cannot be regenerated — the ledger
    // rebuilds from profiles, memory re-earns itself, artifacts are scratch. An
    // upgrade that silently stopped reading it would destroy the only copy.
    const dir = join(root, "data", "episodes");
    mkdirSync(dir, { recursive: true });
    const legacy = [row({ taskId: "old-1" }), row({ taskId: "old-2" })];
    writeFileSync(join(dir, "tasks.jsonl"), `${legacy.map((r) => JSON.stringify(r)).join("\n")}\n`);

    expect(importLegacyJsonl(root)).toBe(2);
    expect(new TaskEpisodeLog(root).readAll().map((r) => r.taskId)).toEqual(["old-1", "old-2"]);

    // Idempotent on the file's size and mtime, so a restart is not a duplication.
    expect(importLegacyJsonl(root)).toBe(0);
    expect(new TaskEpisodeLog(root).readAll()).toHaveLength(2);

    // And the source is left where it is, in case the import was wrong.
    expect(existsSync(join(dir, "tasks.jsonl"))).toBe(true);
  });
});

describe("the corpus guards itself", () => {
  it("refuses a database written by a newer schema, naming both versions", () => {
    const log = new TaskEpisodeLog(root);
    log.append(row());
    const db = openEpisodeDb(episodeDbPath(root));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    db.close();

    expect(() => openEpisodeDb(episodeDbPath(root), { readOnly: true })).toThrow(SchemaTooNewError);
    expect(() => openEpisodeDb(episodeDbPath(root), { readOnly: true })).toThrow(
      new RegExp(`v${SCHEMA_VERSION + 5}.*v${SCHEMA_VERSION}`),
    );
  });

  it("lets another process read while the hive is still writing", () => {
    // The out-of-process reader is the whole delivery mechanism: `npm run breed`,
    // a person with sqlite3, some other AI. It must not need the hive stopped.
    const log = new TaskEpisodeLog(root);
    log.append(row({ taskId: "first" }));
    const reader = openEpisodeDb(episodeDbPath(root), { readOnly: true });
    try {
      log.append(row({ taskId: "second" }));
      const seen = reader.prepare("SELECT task_id FROM task ORDER BY id").all() as Array<{ task_id: string }>;
      expect(seen.map((r) => r.task_id)).toEqual(["first", "second"]);
    } finally {
      reader.close();
    }
  });

  it("still lets a task settle when the corpus cannot be written", () => {
    // A hive that cannot record must still answer.
    const log = new TaskEpisodeLog("/dev/null/nope");
    const warnings: string[] = [];
    expect(() => log.append(row(), (m) => warnings.push(m))).not.toThrow();
    expect(warnings).toHaveLength(1);
  });
});
