import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskEpisodeLog, episodeDbPath, type EpisodeAttempt, type TaskEpisode } from "../src/episode.js";
import { openEpisodeDb, SchemaTooNewError } from "../src/episodeDb.js";
import { CONTENT_COLUMNS, SCHEMA_VERSION } from "../src/episodeSchema.js";
import { importLegacyJsonl } from "../src/episodeImport.js";
import * as breedQuery from "../src/breed/query.js";

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

  it("counts confidential work in the spend report, which is the inverse rule", () => {
    // The exception to the rule above, and the reason it is written into the view:
    // every other view answers "what should we learn from", where excluding
    // confidential work is right. v_user_usage answers "who spent the money",
    // where excluding it is a wrong number. Cost is metadata about a decision, not
    // the content of one, and the generic content-column test above still holds.
    const log = new TaskEpisodeLog(root);
    log.append(row({ taskId: "open", userId: "ada" }));
    log.append(row({ taskId: "secret", userId: "ada", sensitivity: "confidential" }));

    const [ada] = query<{ task_count: number; cost_usd: number; confidential_count: number }>(
      "SELECT task_count, cost_usd, confidential_count FROM v_user_usage WHERE user_id = 'ada'",
    );
    expect(ada.task_count).toBe(2);
    expect(ada.cost_usd).toBeCloseTo(0.008);
    // Named rather than hidden, so a reader can see the report includes them.
    expect(ada.confidential_count).toBe(1);
  });

  it("reports what each person spent, and leaves the unattributed as null", () => {
    const log = new TaskEpisodeLog(root);
    log.append(row({ taskId: "a1", userId: "ada", attempts: [attempt({ costUsd: 0.5 })] }));
    log.append(row({ taskId: "a2", userId: "ada", attempts: [attempt({ costUsd: 0.25 })] }));
    log.append(row({ taskId: "m1", userId: "mei", attempts: [attempt({ costUsd: 0.1 })] }));
    log.append(row({ taskId: "p1" })); // a planner-internal task: nobody to attribute

    const rows = query<{ user_id: string | null; task_count: number; cost_usd: number; total_tokens: number }>(
      "SELECT user_id, task_count, cost_usd, total_tokens FROM v_user_usage ORDER BY cost_usd DESC",
    );
    expect(rows.map((r) => [r.user_id, r.task_count])).toEqual([
      ["ada", 2],
      ["mei", 1],
      // Left NULL rather than coalesced: a literal could collide with a real id.
      [null, 1],
    ]);
    expect(rows[0].cost_usd).toBeCloseTo(0.75);
    expect(rows[0].total_tokens).toBe(2040);
  });

  it("says where one person's spend went, per tier and model", () => {
    // The question a per-user total provokes and cannot answer.
    const log = new TaskEpisodeLog(root);
    log.append(
      row({ taskId: "cheap", userId: "ada", attempts: [attempt({ tier: 3, billing: "local", model: "gemma4:12b", costUsd: 0 })] }),
    );
    log.append(
      row({
        taskId: "dear",
        userId: "ada",
        attempts: [attempt({ tier: 2, billing: "per-token", model: "gemini-3-flash-preview", costUsd: 0.9 })],
      }),
    );

    const rows = query<{ model: string; billing: string; cost_usd: number }>(
      "SELECT model, billing, cost_usd FROM v_user_model WHERE user_id = 'ada' ORDER BY cost_usd DESC",
    );
    expect(rows[0]).toMatchObject({ model: "gemini-3-flash-preview", billing: "per-token" });
    expect(rows[0].cost_usd).toBeCloseTo(0.9);
    expect(rows[1].cost_usd).toBe(0);
  });

  it("buckets a day in UTC, and hands back the boundary so a reader can re-bucket", () => {
    const log = new TaskEpisodeLog(root);
    // 2026-08-11T23:30Z — the same instant is the 12th in any timezone east of
    // UTC, which is exactly how a per-day report drifts without saying so.
    const at = Date.UTC(2026, 7, 11, 23, 30);
    log.append(row({ taskId: "late", userId: "ada", at }));

    const [day] = query<{ day: string; day_start_ms: number }>(
      "SELECT day, day_start_ms FROM v_user_usage_day WHERE user_id = 'ada'",
    );
    expect(day.day).toBe("2026-08-11");
    expect(day.day_start_ms).toBe(Date.UTC(2026, 7, 11));
  });
});

describe("a corpus written before a view existed", () => {
  const openWrite = () => openEpisodeDb(episodeDbPath(root), {});

  it("gains it on the next writer open, with every row intact", () => {
    // Views are a saved query, not data, so they do not need migrating — they need
    // replacing. `initialize` only ever ran on a brand-new file, so a build that
    // added a view left every existing corpus with the old set and no error at all,
    // and each query against the new one died on `no such view`.
    const log = new TaskEpisodeLog(root);
    log.append(row({ taskId: "before", userId: "ada" }));

    // What a corpus from an older build actually looks like: the views it knew,
    // and no fingerprint of this build's set — the key did not exist yet.
    const aged = openWrite();
    aged.exec("DROP VIEW v_user_usage");
    aged.exec("DELETE FROM meta WHERE key = 'views_hash'");
    aged.close();

    const reopened = openWrite();
    try {
      const rows = reopened.prepare("SELECT user_id, task_count FROM v_user_usage").all() as Array<{
        user_id: string;
        task_count: number;
      }>;
      expect(rows).toEqual([{ user_id: "ada", task_count: 1 }]);
      // The table is the record; rebuilding views must not touch it.
      const [{ n }] = reopened.prepare("SELECT count(*) AS n FROM task").all() as Array<{ n: number }>;
      expect(n).toBe(1);
      // And the version is untouched, because no table changed.
      const [{ user_version }] = reopened.prepare("PRAGMA user_version").all() as Array<{ user_version: number }>;
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      reopened.close();
    }
  });

  it("issues no schema change when the views already match", () => {
    // A Queen opens two writer connections to one corpus, so rebuilding on every
    // open meant the second dropped and recreated eleven views while the first
    // held a live WAL connection — the one operation SQLite may refuse outright
    // rather than waiting out busy_timeout. Since `append` swallows its failures,
    // losing that race cost a silently missing row.
    const log = new TaskEpisodeLog(root);
    log.append(row({ taskId: "first" }));

    const first = openWrite();
    const before = (first.prepare("SELECT value FROM meta WHERE key = 'views_hash'").get() as { value: string }).value;
    // A second writer, while the first is still open: the common case, and it must
    // be a no-op rather than a schema change.
    const second = openWrite();
    const after = (second.prepare("SELECT value FROM meta WHERE key = 'views_hash'").get() as { value: string }).value;
    expect(after).toBe(before);
    // The views are intact and the row survived, which is what the race threatened.
    expect(second.prepare("SELECT * FROM v_user_usage").all()).toHaveLength(1);
    first.close();
    second.close();
  });

  it("tells a read-only reader what to do about it, since it cannot fix it itself", () => {
    const log = new TaskEpisodeLog(root);
    log.append(row({ taskId: "before" }));

    const aged = openWrite();
    aged.exec("DROP VIEW v_user_usage");
    aged.exec("DELETE FROM meta WHERE key = 'views_hash'");
    aged.close();

    // `breed` opens read-only by construction, so it can read every table and
    // still be missing a view. A bare sqlite error there sends the operator
    // looking for a corrupt database.
    expect(() => breedQuery.usage({ root })).toThrow(/start the Queen once/);
  });

  it("keeps the corpus writable when the rebuild itself cannot run", () => {
    // The failure that must not be fatal. A view carries no data and the next
    // start rebuilds it, so refusing to open a corpus because its views could not
    // be replaced would trade the thing that matters for the thing that does not.
    const log = new TaskEpisodeLog(root);
    log.append(row({ taskId: "before" }));

    // Force the rebuild path, then make it impossible: a table of that name means
    // CREATE VIEW cannot succeed. Standing in for the real cause, which is DDL
    // losing a race with a live reader and is not reproducible on demand.
    const sabotage = openWrite();
    sabotage.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('views_hash', ?)").run("stale");
    sabotage.exec("DROP VIEW v_user_usage");
    sabotage.exec("CREATE TABLE v_user_usage (x INTEGER)");
    sabotage.close();

    const reopened = openWrite();
    try {
      // Open, writable, every row intact — which is the whole claim.
      reopened.exec("INSERT INTO meta (key, value) VALUES ('probe', 'ok')");
      const [{ n }] = reopened.prepare("SELECT count(*) AS n FROM task").all() as Array<{ n: number }>;
      expect(n).toBe(1);
      // And it did not record a rebuild that never happened, so the next start retries.
      const h = reopened.prepare("SELECT value FROM meta WHERE key = 'views_hash'").get() as { value: string };
      expect(h.value).toBe("stale");
    } finally {
      reopened.close();
    }
  });

  it("rebuilds when a build changed a definition, not merely when one is missing", () => {
    // The case the fingerprint exists for. A changed view has the right *name*, so
    // nothing about the corpus looks wrong — only the stored hash disagrees.
    const log = new TaskEpisodeLog(root);
    log.append(row({ taskId: "before", userId: "ada" }));

    const stale = openWrite();
    stale.exec("DROP VIEW v_user_usage");
    stale.exec("CREATE VIEW v_user_usage AS SELECT 'wrong' AS customer_id");
    stale.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('views_hash', ?)").run("adifferentbuild");
    stale.close();

    const reopened = openWrite();
    try {
      const rows = reopened.prepare("SELECT customer_id FROM v_user_usage").all() as Array<{ customer_id: string }>;
      expect(rows).toEqual([{ customer_id: "aiotlab" }]);
    } finally {
      reopened.close();
    }
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
