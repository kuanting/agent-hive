import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodeLog, episodeDbPath, resolveEpisodeMode, toMetadata, type EpisodeRecord } from "../src/episode.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "episode-root-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(over: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    turnId: "t1",
    customerId: "aiotlab",
    at: 1,
    mode: "full",
    planner: {
      model: "gemma4:12b",
      tier: 3,
      decision: "plan",
      escalated: false,
      difficulty: "standard",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0,
      latencyMs: 900,
    },
    phaseMs: { planning: 900, waiting: 4000 },
    tasks: [
      {
        key: "a",
        taskId: "task-a",
        title: "Summarize",
        skills: ["files"],
        sensitivity: "normal",
        ok: true,
        input: "the secret input",
        output: "the answer text",
        attempts: [
          {
            attempt: 1,
            tier: 3,
            runtime: "hermes",
            ok: true,
            degraded: false,
            inputTokens: 500,
            outputTokens: 200,
            costUsd: 0,
            durationMs: 4000,
          },
        ],
      },
    ],
    totals: { inputTokens: 600, outputTokens: 220, costUsd: 0, wallMs: 5000, attempts: 1 },
    outcome: { ok: true, answerChars: 15 },
    userMessage: "summarize the repo",
    planRationale: "one step is enough",
    answer: "the answer text",
    ...over,
  };
}

describe("episode mode", () => {
  it("defaults anything unrecognized to metadata", () => {
    // A customer profile is hand-edited yaml. A typo must not silently opt the
    // customer into writing user text to disk.
    expect(resolveEpisodeMode(undefined)).toBe("metadata");
    expect(resolveEpisodeMode("FULL")).toBe("metadata");
    expect(resolveEpisodeMode("yes please")).toBe("metadata");
    expect(resolveEpisodeMode("full")).toBe("full");
    expect(resolveEpisodeMode("off")).toBe("off");
  });

  it("strips every text field when downgrading, and says why", () => {
    const meta = toMetadata(record(), "turn contained confidential work");
    expect(meta.mode).toBe("metadata");
    expect(meta.downgradedReason).toBe("turn contained confidential work");
    expect(meta.userMessage).toBeUndefined();
    expect(meta.answer).toBeUndefined();
    expect(meta.planRationale).toBeUndefined();
    expect(meta.tasks[0].input).toBeUndefined();
    expect(meta.tasks[0].output).toBeUndefined();
    // The measurements — the part that makes it a training row — survive intact.
    expect(meta.tasks[0].attempts).toHaveLength(1);
    expect(meta.totals.inputTokens).toBe(600);
    expect(meta.planner.latencyMs).toBe(900);
  });

  it("strips the title and the runtime's own words, which used to survive", () => {
    // `title` is the planner phrasing the user's request; `error` and
    // `diagnostics` are whatever a runtime chose to say, which can quote the
    // prompt straight back. All three read as structure and are not.
    const meta = toMetadata(
      record({
        tasks: [
          {
            key: "a",
            taskId: "task-a",
            title: "Summarize the acquisition memo",
            skills: ["files"],
            toolInputKeys: ["csv"],
            ok: false,
            attempts: [
              {
                attempt: 1,
                tier: 3,
                runtime: "hermes",
                ok: false,
                degraded: false,
                inputTokens: 5,
                outputTokens: 0,
                costUsd: 0,
                durationMs: 10,
                error: "refused: cannot summarize the acquisition memo",
                diagnostics: ["prompt was: summarize the acquisition memo"],
              },
            ],
          },
        ],
      }),
      "test",
    );
    expect(meta.tasks[0].title).toBeUndefined();
    expect(meta.tasks[0].attempts[0].error).toBeUndefined();
    expect(meta.tasks[0].attempts[0].diagnostics).toBeUndefined();
    // Key names carry no values, and they are the whole signal behind
    // "this shape was one key away from tier 4". They stay.
    expect(meta.tasks[0].toolInputKeys).toEqual(["csv"]);
    // The label that makes it a training row is structural, not textual: the
    // attempt chain still says tier 3 failed.
    expect(meta.tasks[0].attempts[0]).toMatchObject({ tier: 3, ok: false });
  });

  it("keeps no text anywhere in what reaches storage", () => {
    // Belt and braces: assert on the bytes that reach disk, not on the fields we
    // remembered to null out. A future field carrying text would slip past a
    // field-by-field check.
    const log = new EpisodeLog(root);
    log.append(toMetadata(record(), "test"));
    const raw = readFileSync(episodeDbPath(root));
    expect(raw.includes(Buffer.from("the secret input"))).toBe(false);
    expect(raw.includes(Buffer.from("summarize the repo"))).toBe(false);
    expect(raw.includes(Buffer.from("the answer text"))).toBe(false);
  });
});

describe("episode log", () => {
  it("writes one JSON line per turn and reads them back", () => {
    const log = new EpisodeLog(root);
    log.append(record({ turnId: "one" }));
    log.append(record({ turnId: "two" }));
    const all = log.readAll();
    expect(all.map((r) => r.turnId)).toEqual(["one", "two"]);
    expect(all[0].tasks[0].input).toBe("the secret input"); // full mode keeps text
  });

  it("writes nothing at all when recording is off", () => {
    const log = new EpisodeLog(root);
    log.append(record({ mode: "off" }));
    expect(log.readAll()).toEqual([]);
  });

  it("keeps a half-written row out of the corpus entirely", () => {
    // What the torn-line test used to assert, now stronger. A JSONL append that
    // died mid-write left a partial line for the reader to skip; a transaction
    // that dies leaves nothing at all, so a row is either wholly there or wholly
    // absent — there is no torn state to be tolerant of.
    const log = new EpisodeLog(root);
    log.append(record({ turnId: "intact" }));
    // A row the schema refuses: `mode` is NOT NULL, and no partial insert of its
    // attempts or tool calls may survive the rejection.
    log.append(record({ turnId: "doomed", mode: undefined as unknown as "full" }), () => {});
    const all = log.readAll();
    expect(all.map((r) => r.turnId)).toEqual(["intact"]);
  });

  it("reads back the whole corpus, however much of it there is", () => {
    const log = new EpisodeLog(root);
    for (let i = 0; i < 200; i++) log.append(record({ turnId: `t${i}`, at: i + 1 }));

    const all = log.readAll();
    expect(all).toHaveLength(200);
    expect(new Set(all.map((r) => r.turnId)).size).toBe(200);
    // Insertion order, so the newest turn is last.
    expect(all[all.length - 1].turnId).toBe("t199");
  });

  it("stays bounded by row count, so a long-running hive cannot fill its own disk", () => {
    // The file-rotation limits this replaces bounded bytes; these bound rows.
    // Same §4 rule either way: every long-lived structure in the hive is capped.
    //
    // Timestamps have to be realistic. Pruning also drops anything older than
    // HIVE_EPISODE_MAX_DAYS, measured against the wall clock — so a fixture using
    // `at: 1` is 56 years stale and gets swept for the wrong reason, which is
    // exactly how this test first passed while proving nothing.
    process.env.HIVE_EPISODE_MAX_ROWS = "50";
    try {
      const log = new EpisodeLog(root);
      const now = Date.now();
      // Pruning runs every 512 appends rather than on each one, so land exactly
      // on the boundary and the bound is observable.
      for (let i = 0; i < 512; i++) log.append(record({ turnId: `t${i}`, at: now - (512 - i) * 1000 }));

      const all = log.readAll();
      expect(all).toHaveLength(50);
      // Newest kept, oldest shed: what survives is recent history, not a slice.
      expect(all[all.length - 1].turnId).toBe("t511");
      expect(all[0].turnId).toBe("t462");
    } finally {
      delete process.env.HIVE_EPISODE_MAX_ROWS;
    }
  });

  it("sheds history older than the retention window", () => {
    process.env.HIVE_EPISODE_MAX_DAYS = "30";
    try {
      const log = new EpisodeLog(root);
      const now = Date.now();
      const old = now - 90 * 86_400_000;
      // 511 recent rows plus one ancient one, so the prune at 512 has something
      // to find and the row cap is nowhere near reached.
      log.append(record({ turnId: "ancient", at: old }));
      for (let i = 0; i < 511; i++) log.append(record({ turnId: `t${i}`, at: now - i * 1000 }));

      const kept = log.readAll().map((r) => r.turnId);
      expect(kept).not.toContain("ancient");
      expect(kept).toHaveLength(511);
    } finally {
      delete process.env.HIVE_EPISODE_MAX_DAYS;
    }
  });

  it("windows the corpus by timestamp", () => {
    const log = new EpisodeLog(root);
    log.append(record({ turnId: "old", at: 100 }));
    log.append(record({ turnId: "recent", at: 300 }));
    expect(log.readAll({ since: 200 }).map((r) => r.turnId)).toEqual(["recent"]);
    expect(log.readAll().map((r) => r.turnId)).toEqual(["old", "recent"]);
  });

  it("never throws when the directory cannot be written", () => {
    // A hive that cannot record must still answer. Losing a training row is a
    // cost; failing the user's turn to protect one is not a trade worth making.
    const log = new EpisodeLog("/dev/null/nope");
    const warnings: string[] = [];
    expect(() => log.append(record(), (m) => warnings.push(m))).not.toThrow();
    expect(warnings).toHaveLength(1);
  });
});
