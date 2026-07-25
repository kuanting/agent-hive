import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSpec, type TaskResult } from "@hive/shared";
import { MemoryStore, parseMemoryFile } from "../src/planner/memory/store.js";
import { selectMemories } from "../src/planner/memory/recall.js";
import { reflect } from "../src/planner/memory/reflect.js";
import { trustOf, type MemoryRecord, type Observation } from "../src/planner/memory/types.js";
import { PlannedTask } from "../src/planner/types.js";
import type { ToolInfo } from "../src/analyzer.js";

const TOOLS: ToolInfo[] = [{ toolId: "csv-report", skills: ["reporting"], requiredKeys: ["csv"] }];

function store(): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), "hive-fb-")));
}
function rootOf(s: MemoryStore): string {
  return (s as unknown as { root: string }).root;
}
function obs(over: Partial<Observation> = {}): Observation {
  return {
    id: "mt-csv-report-csv", type: "pitfall", source: "detector:missed-tool-match",
    name: "set toolInput.csv", description: "d", triggers: ["csv", "report"],
    skills: ["reporting"], evidence: ["e1"], body: "b", ...over,
  };
}
function result(over: Partial<TaskResult> = {}): TaskResult {
  return {
    kind: "task.result", taskId: "x1", agentId: "a", customerId: "aiotlab", ok: true,
    output: "o", tierUsed: 3, runtime: "ollama", billing: "local",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, degraded: false, durationMs: 1, ...over,
  };
}

/** A turn where the planner ignored the note: the reporting task still has no toolInput.csv. */
function turnThatRepeatsTheMistake(s: MemoryStore, recalled: MemoryRecord[]) {
  const spec = TaskSpec.parse({ customerId: "aiotlab", title: "csv report", input: "rows", skills: ["reporting"] });
  return reflect(
    {
      customerId: "aiotlab",
      userMessage: "make a csv report",
      planned: [PlannedTask.parse({ key: "t1", title: "csv report", input: "rows", skills: ["reporting"] })],
      outcomes: [{ key: "t1", title: "csv report", taskId: "x1", spec, result: result({ tierUsed: 3 }) }],
      attempts: new Map([["x1", 1]]),
      liveSkills: ["reporting"], tools: TOOLS, maxAttempts: 3,
      confidential: false, plannerDegraded: false, recalled,
    },
    s,
  );
}

/** A turn where the planner followed the note: the task carried the key and hit tier 4. */
function turnThatFollowedTheNote(s: MemoryStore, recalled: MemoryRecord[]) {
  const spec = TaskSpec.parse({
    customerId: "aiotlab", title: "csv report", input: "rows", skills: ["reporting"], toolInput: { csv: "a,b" },
  });
  return reflect(
    {
      customerId: "aiotlab",
      userMessage: "make a csv report",
      planned: [PlannedTask.parse({ key: "t1", title: "csv report", input: "rows", skills: ["reporting"] })],
      outcomes: [{ key: "t1", title: "csv report", taskId: "x1", spec, result: result({ tierUsed: 4 }) }],
      attempts: new Map([["x1", 1]]),
      liveSkills: ["reporting"], tools: TOOLS, maxAttempts: 3,
      confidential: false, plannerDegraded: false, recalled,
    },
    s,
  );
}

describe("negative signal", () => {
  it("a recalled pitfall that gets re-detected is marked misfired — but observed still counts the cause", async () => {
    const s = store();
    s.upsert("aiotlab", obs());
    const before = s.load("aiotlab")[0];

    await turnThatRepeatsTheMistake(s, [before]);

    const after = s.load("aiotlab")[0];
    expect(after.misfired).toBe(1);
    expect(after.helped).toBe(0);
    expect(after.recalled).toBe(1);
    // The cause genuinely recurred. That fact is not rewritten by the judgement
    // that the lesson failed — the two are now separate axes.
    expect(after.observed).toBe(before.observed + 1);
    expect(trustOf(after)).toBeLessThan(0.5);
  });

  it("a recalled pitfall that is not re-detected is credited as helped", async () => {
    const s = store();
    s.upsert("aiotlab", obs());
    await turnThatFollowedTheNote(s, s.load("aiotlab"));

    const after = s.load("aiotlab")[0];
    expect(after.helped).toBe(1);
    expect(after.misfired).toBe(0);
    expect(trustOf(after)).toBeGreaterThan(0.5);
  });

  it("a memory that was never recalled is not graded at all", async () => {
    const s = store();
    s.upsert("aiotlab", obs());
    await turnThatRepeatsTheMistake(s, []); // recalled nothing

    const after = s.load("aiotlab")[0];
    expect(after.recalled).toBe(0);
    expect(after.helped).toBe(0);
    expect(after.misfired).toBe(0);
  });

  it("a failing memory sinks below an untried one — driven through reflect, not hand-fed", async () => {
    // This test used to call recordFeedback directly, which held observed at 1
    // and validated a state the system cannot reach. In production a misfire
    // ALWAYS arrives with an observed bump, because reflect grades the memory
    // and then upserts the same re-detected observation. Scoring by observed
    // therefore made every failure raise the memory's rank. Drive the real
    // path so that inversion cannot come back unnoticed.
    const s = store();
    s.upsert("aiotlab", obs());
    s.upsert("aiotlab", obs({ id: "untried", name: "untried lesson", triggers: ["csv", "report"] }));

    for (let i = 0; i < 2; i++) {
      const recalled = s.load("aiotlab").filter((m) => m.id === "mt-csv-report-csv");
      await turnThatRepeatsTheMistake(s, recalled);
    }

    const failing = s.load("aiotlab").find((m) => m.id === "mt-csv-report-csv")!;
    expect(failing.misfired).toBe(2);
    expect(failing.observed).toBeGreaterThan(1); // the bump that used to win

    const ranked = selectMemories(s.load("aiotlab"), "make a csv report");
    expect(ranked[0].record.id).toBe("untried");
  });

  it("trust never bypasses the trigger gate", () => {
    const s = store();
    s.upsert("aiotlab", obs({ id: "trusted", triggers: ["csv"] }));
    for (let i = 0; i < 5; i++) s.recordFeedback("aiotlab", "trusted", "helped");

    expect(trustOf(s.load("aiotlab")[0])).toBeGreaterThan(0.8);
    expect(selectMemories(s.load("aiotlab"), "what is the weather")).toEqual([]);
  });

  it("retires a pitfall after repeated misfires, and stops putting it in the prompt", () => {
    const s = store();
    s.upsert("aiotlab", obs());

    for (let i = 0; i < 2; i++) s.recordFeedback("aiotlab", "mt-csv-report-csv", "misfired");
    expect(s.load("aiotlab")[0].retired).toBe(false);
    expect(selectMemories(s.load("aiotlab"), "csv report").length).toBe(1);

    const third = s.recordFeedback("aiotlab", "mt-csv-report-csv", "misfired");
    expect(third!.misfired).toBe(3);
    expect(trustOf(third!)).toBeLessThan(0.3);
    expect(third!.retired).toBe(true);
    expect(selectMemories(s.load("aiotlab"), "csv report")).toEqual([]);
  });

  it("one success is enough to keep a memory off the retirement threshold", () => {
    const s = store();
    s.upsert("aiotlab", obs());
    s.recordFeedback("aiotlab", "mt-csv-report-csv", "helped");
    for (let i = 0; i < 3; i++) s.recordFeedback("aiotlab", "mt-csv-report-csv", "misfired");

    const m = s.load("aiotlab")[0];
    expect(trustOf(m)).toBeCloseTo(1 / 3, 3); // 2/6 — above the 0.3 floor
    expect(m.retired).toBe(false);
  });

  it("does not relearn a retired lesson: the detector re-fires but it stays retired and unrecalled", async () => {
    const s = store();
    s.upsert("aiotlab", obs());
    for (let i = 0; i < 3; i++) s.recordFeedback("aiotlab", "mt-csv-report-csv", "misfired");
    expect(s.load("aiotlab")[0].retired).toBe(true);

    // The cause recurs. Without the flag this would resurrect the memory and the
    // Queen would relearn exactly what it just discarded, forever.
    await turnThatRepeatsTheMistake(s, []);

    const after = s.load("aiotlab")[0];
    expect(after.retired).toBe(true);
    expect(after.observed).toBeGreaterThan(1); // the cause was still counted
    expect(selectMemories(s.load("aiotlab"), "csv report")).toEqual([]);
  });

  it("playbooks are graded positive-only and are never retired by feedback", () => {
    const s = store();
    s.upsert("aiotlab", obs({ id: "pb-x", type: "playbook", name: "split it in two" }));

    for (let i = 0; i < 5; i++) s.recordFeedback("aiotlab", "pb-x", "misfired");
    const m = s.load("aiotlab")[0];
    expect(m.retired).toBe(false); // non-detection is ambiguous for a playbook
  });

  it("evicts the tried-and-failed before the untried, even when failure inflated observed", async () => {
    const s = store();
    const cap = Number(process.env.HIVE_MEMORY_MAX_FILES ?? 32);

    // The failing memory accrues observed bumps through the real path, which is
    // what used to make it *outlive* untried lessons under an observed-weighted
    // eviction score.
    s.upsert("aiotlab", obs());
    for (let i = 0; i < 2; i++) {
      await turnThatRepeatsTheMistake(s, s.load("aiotlab").filter((m) => m.id === "mt-csv-report-csv"));
    }
    const failing = s.load("aiotlab").find((m) => m.id === "mt-csv-report-csv")!;
    expect(failing.observed).toBeGreaterThan(1);

    for (let i = 0; i < cap; i++) s.upsert("aiotlab", obs({ id: `untried-${i}`, name: `l${i}`, triggers: ["zzz"] }));

    const left = s.load("aiotlab");
    expect(left.find((m) => m.id === "mt-csv-report-csv")).toBeUndefined();
    expect(left.length).toBeLessThanOrEqual(cap);
  });

  it("a retired lesson stays dead even after its record is evicted", async () => {
    // The `retired` flag alone could not do this: eviction deletes records, so
    // once the corpus hit the cap the tombstone vanished with the file and the
    // next detection minted the lesson fresh. A compact id list outlives it.
    const s = store();
    s.upsert("aiotlab", obs());
    for (let i = 0; i < 3; i++) s.recordFeedback("aiotlab", "mt-csv-report-csv", "misfired");
    expect(s.load("aiotlab")[0].retired).toBe(true);

    const cap = Number(process.env.HIVE_MEMORY_MAX_FILES ?? 32);
    for (let i = 0; i < cap + 2; i++) s.upsert("aiotlab", obs({ id: `filler-${i}`, name: `f${i}`, triggers: ["zzz"] }));
    expect(s.load("aiotlab").find((m) => m.id === "mt-csv-report-csv")).toBeUndefined(); // evicted

    // the cause recurs — this must NOT resurrect it
    await turnThatRepeatsTheMistake(s, []);
    expect(s.load("aiotlab").find((m) => m.id === "mt-csv-report-csv")).toBeUndefined();
    expect(selectMemories(s.load("aiotlab"), "csv report")).toEqual([]);
  });

  it("retires a memory whose detector can no longer fire, instead of trusting it forever", async () => {
    // us-database was minted because no worker advertised `database`. Once one
    // does, D2 can never emit that id again — so every recall was a free
    // `helped`, trust climbed toward 1.0, and retirement (which needs
    // misfired >= 3) became unreachable while the advice was actively false.
    const s = store();
    s.upsert("aiotlab", obs({ id: "us-database", name: 'The hive has no "database" skill', triggers: ["csv"] }));

    const spec = TaskSpec.parse({ customerId: "aiotlab", title: "r", input: "i", skills: ["reporting"] });
    await reflect(
      {
        customerId: "aiotlab", userMessage: "make a csv report",
        planned: [PlannedTask.parse({ key: "t1", title: "r", input: "i", skills: ["reporting"] })],
        outcomes: [{ key: "t1", title: "r", taskId: "x1", spec, result: result({ tierUsed: 4 }) }],
        attempts: new Map([["x1", 1]]),
        liveSkills: ["reporting", "database"], // a database worker registered
        tools: TOOLS, maxAttempts: 3,
        confidential: false, plannerDegraded: false,
        recalled: s.load("aiotlab").filter((m) => m.id === "us-database"),
      },
      s,
    );

    const m = s.load("aiotlab").find((x) => x.id === "us-database")!;
    expect(m.retired).toBe(true);
    expect(m.helped).toBe(0); // never credited for being unfalsifiable
    expect(selectMemories(s.load("aiotlab"), "csv report").find((r) => r.record.id === "us-database")).toBeUndefined();
  });

  it("refuses to purge memory when the customer list comes back empty", () => {
    // loadCustomers swallows any readdir failure and returns [], so a bad
    // HIVE_ROOT or a transient fs error must not read as "delete everything".
    const s = store();
    s.upsert("aiotlab", obs());
    s.reconcile([]);
    expect(s.load("aiotlab").length).toBe(1);

    // a real, non-empty list still prunes
    s.reconcile(["someone-else"]);
    expect(s.load("aiotlab").length).toBe(0);
  });

  it("reads a pre-feedback memory file and starts it at neutral trust", () => {
    const s = store();
    const dir = join(rootOf(s), "aiotlab");
    mkdirSync(dir, { recursive: true });
    // exactly the frontmatter shape written before the confidence axis existed
    writeFileSync(
      join(dir, "legacy.md"),
      "---\nid: legacy\ntype: pitfall\ncustomerId: aiotlab\nname: an older lesson\ntriggers: [csv]\nobserved: 4\n---\nbody\n",
    );

    const parsed = parseMemoryFile(
      "---\nid: legacy\ntype: pitfall\ncustomerId: aiotlab\nname: an older lesson\ntriggers: [csv]\nobserved: 4\n---\nbody\n",
      "aiotlab",
    );
    expect(parsed).toBeTruthy();
    expect(parsed!.helped).toBe(0);
    expect(parsed!.misfired).toBe(0);
    expect(parsed!.retired).toBe(false);
    expect(trustOf(parsed!)).toBe(0.5);
    expect(selectMemories(s.load("aiotlab"), "csv").length).toBe(1);
  });
});
