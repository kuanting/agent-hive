import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodeLog, resolveEpisodeMode, toMetadata, type EpisodeRecord } from "../src/episode.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "episode-root-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.HIVE_EPISODE_FILE_BYTES;
  delete process.env.HIVE_EPISODE_FILES;
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

  it("keeps no text anywhere in the serialized metadata record", () => {
    // Belt and braces: assert on the bytes that reach disk, not on the fields we
    // remembered to null out. A future field carrying text would slip past a
    // field-by-field check.
    const log = new EpisodeLog(root);
    log.append(toMetadata(record(), "test"));
    const raw = readFileSync(join(root, "data", "episodes", "episodes.jsonl"), "utf8");
    expect(raw).not.toContain("the secret input");
    expect(raw).not.toContain("summarize the repo");
    expect(raw).not.toContain("the answer text");
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

  it("keeps the corpus readable when a line is torn by a hard stop", () => {
    const log = new EpisodeLog(root);
    log.append(record({ turnId: "intact" }));
    // Simulate a process killed mid-append: a trailing partial line.
    const file = join(root, "data", "episodes", "episodes.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}{"turnId":"torn`);
    const all = log.readAll();
    expect(all.map((r) => r.turnId)).toEqual(["intact"]);
  });

  it("rotates once the live file is large enough, and bounds how many roll-ups survive", () => {
    process.env.HIVE_EPISODE_FILE_BYTES = "400";
    process.env.HIVE_EPISODE_FILES = "3";
    const log = new EpisodeLog(root);
    for (let i = 0; i < 12; i++) log.append(record({ turnId: `t${i}` }));
    const files = readdirSync(join(root, "data", "episodes"));
    // A long-running Queen must not fill the disk with its own training data.
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files).toContain("episodes.jsonl");
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
