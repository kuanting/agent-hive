import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSpec, type TaskResult } from "@hive/shared";
import { MemoryStore } from "../src/planner/memory/store.js";
import { selectMemories, renderMemories } from "../src/planner/memory/recall.js";
import { detect, type TurnFacts } from "../src/planner/memory/detect.js";
import { reflect } from "../src/planner/memory/reflect.js";
import type { Observation } from "../src/planner/memory/types.js";
import { PlannedTask } from "../src/planner/types.js";
import { missedToolMatch, userAskedUrgent, type ToolInfo } from "../src/analyzer.js";

const TOOLS: ToolInfo[] = [
  { toolId: "csv-report", skills: ["reporting"], requiredKeys: ["csv"] },
  { toolId: "log-extract", skills: ["reporting", "ops"], requiredKeys: ["pattern"] },
];

function store(): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), "hive-mem-")));
}

function obs(over: Partial<Observation> = {}): Observation {
  return {
    id: "mt-csv-report-csv",
    type: "pitfall",
    source: "test",
    name: "Set toolInput.csv to run at tier 4",
    description: "d",
    triggers: ["csv", "report"],
    skills: ["reporting"],
    evidence: ["task1"],
    body: "body text",
    ...over,
  };
}

function result(over: Partial<TaskResult> = {}): TaskResult {
  return {
    kind: "task.result",
    taskId: "t1",
    agentId: "a",
    customerId: "aiotlab",
    ok: true,
    output: "out",
    tierUsed: 3,
    runtime: "ollama",
    billing: "local",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    degraded: false,
    durationMs: 1,
    ...over,
  };
}

function facts(over: Partial<TurnFacts> = {}): TurnFacts {
  return {
    userMessage: "make me a weekly yield report",
    planned: [PlannedTask.parse({ key: "t1", title: "report", input: "x", skills: ["reporting"] })],
    outcomes: [],
    attempts: new Map(),
    liveSkills: ["reporting", "coding", "general"],
    tools: TOOLS,
    maxAttempts: 3,
    ...over,
  };
}

describe("analyzer additions", () => {
  it("missedToolMatch finds the tool a task should have hit", () => {
    const spec = TaskSpec.parse({ customerId: "c", title: "Summarize the course csv", input: "rows", skills: ["reporting"] });
    expect(missedToolMatch(spec, TOOLS)).toEqual({ toolId: "csv-report", missingKeys: ["csv"] });
  });

  it("missedToolMatch ignores a prose task that merely shares the skill tag", () => {
    // "write a paragraph explaining the trend" is legitimately tagged reporting
    // and legitimately has no toolInput. Skill overlap alone would condemn it,
    // minting a false lesson and — once feedback existed — punishing the very
    // note the planner had just obeyed on a sibling task.
    const spec = TaskSpec.parse({
      customerId: "c", title: "Explain the trend", input: "write a short paragraph", skills: ["reporting"],
    });
    expect(missedToolMatch(spec, TOOLS)).toBeUndefined();
  });

  it("missedToolMatch stays silent when the tool actually matched", () => {
    const spec = TaskSpec.parse({
      customerId: "c", title: "t", input: "i", skills: ["reporting"], toolInput: { csv: "a,b" },
    });
    expect(missedToolMatch(spec, TOOLS)).toBeUndefined();
  });

  it("missedToolMatch requires skill overlap, or every task would miss every tool", () => {
    const spec = TaskSpec.parse({ customerId: "c", title: "t", input: "i", skills: ["coding"] });
    expect(missedToolMatch(spec, TOOLS)).toBeUndefined();
  });

  it("userAskedUrgent only fires on the user's own words", () => {
    expect(userAskedUrgent("this is urgent, production is down")).toBe(true);
    expect(userAskedUrgent("fix it ASAP")).toBe(true);
    expect(userAskedUrgent("summarize this csv when you get a chance")).toBe(false);
  });
});

describe("memory store", () => {
  it("round-trips a record through frontmatter", () => {
    const s = store();
    s.upsert("aiotlab", obs());
    const [m] = s.load("aiotlab");
    expect(m.id).toBe("mt-csv-report-csv");
    expect(m.type).toBe("pitfall");
    expect(m.triggers).toContain("csv");
    expect(m.body).toContain("body text");
  });

  it("skips malformed files instead of throwing", () => {
    const s = store();
    s.upsert("aiotlab", obs());
    const dir = join((s as unknown as { root: string }).root, "aiotlab");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "no-frontmatter.md"), "just some text");
    writeFileSync(join(dir, "broken-yaml.md"), "---\n: : :\nid: [unclosed\n---\nbody");

    const loaded = s.load("aiotlab");
    expect(loaded.length).toBe(1);
    expect(loaded[0].id).toBe("mt-csv-report-csv");
  });

  it("bumps observed on a repeat instead of creating a duplicate", () => {
    const s = store();
    s.upsert("aiotlab", obs({ evidence: ["task1"] }));
    s.upsert("aiotlab", obs({ evidence: ["task2"], triggers: ["csv", "spreadsheet"] }));

    const loaded = s.load("aiotlab");
    expect(loaded.length).toBe(1);
    expect(loaded[0].observed).toBe(2);
    expect(loaded[0].evidence).toEqual(expect.arrayContaining(["task1", "task2"]));
    expect(loaded[0].triggers).toEqual(expect.arrayContaining(["csv", "report", "spreadsheet"]));
  });

  it("caps the corpus and keeps an INDEX.md mirror", () => {
    const s = store();
    const cap = Number(process.env.HIVE_MEMORY_MAX_FILES ?? 32);
    for (let i = 0; i < cap + 8; i++) s.upsert("aiotlab", obs({ id: `mt-${i}`, name: `lesson ${i}` }));

    expect(s.load("aiotlab").length).toBeLessThanOrEqual(cap);
    const dir = join((s as unknown as { root: string }).root, "aiotlab");
    expect(readdirSync(dir)).toContain("INDEX.md");
  });

  it("reconcile drops memory for customers that no longer exist", () => {
    const s = store();
    s.upsert("aiotlab", obs());
    s.upsert("gone", obs());
    s.reconcile(["aiotlab"]);
    expect(s.load("aiotlab").length).toBe(1);
    expect(s.load("gone").length).toBe(0);
  });
});

describe("memory recall", () => {
  const s = store();
  s.upsert("aiotlab", obs({ id: "a", name: "csv lesson", triggers: ["csv", "report"] }));
  s.upsert("aiotlab", obs({ id: "b", name: "log lesson", triggers: ["log", "error"] }));
  const all = s.load("aiotlab");

  it("gates on trigger overlap: an unrelated message recalls nothing", () => {
    expect(selectMemories(all, "what is the weather today")).toEqual([]);
  });

  it("recalls only the memory whose triggers appear in the message", () => {
    const got = selectMemories(all, "please build a csv report");
    expect(got.map((r) => r.record.id)).toEqual(["a"]);
  });

  it("ranks pitfalls above playbooks at equal overlap", () => {
    const s2 = store();
    s2.upsert("c", obs({ id: "pit", type: "pitfall", name: "p", triggers: ["csv"] }));
    s2.upsert("c", obs({ id: "play", type: "playbook", name: "q", triggers: ["csv"] }));
    const got = selectMemories(s2.load("c"), "csv please");
    expect(got[0].record.type).toBe("pitfall");
  });

  it("respects the char budget and the count cap, deterministically", () => {
    const s3 = store();
    for (let i = 0; i < 20; i++) s3.upsert("c", obs({ id: `m${i}`, name: `lesson number ${i}`, triggers: ["csv"] }));
    const loaded = s3.load("c");

    const a = selectMemories(loaded, "csv", 300);
    const b = selectMemories(loaded, "csv", 300);
    expect(a.map((r) => r.record.id)).toEqual(b.map((r) => r.record.id)); // deterministic
    expect(renderMemories(a).length).toBeLessThanOrEqual(300 + 120); // + the header line
    expect(a.length).toBeLessThanOrEqual(3);
  });
});

describe("detectors", () => {
  it("D1 fires on a task that ran on an LLM but should have matched a tool", () => {
    const spec = TaskSpec.parse({ customerId: "c", title: "csv report", input: "rows", skills: ["reporting"] });
    const found = detect(facts({
      outcomes: [{ key: "t1", title: "csv report", taskId: "x1", spec, result: result({ tierUsed: 3 }) }],
    }));
    expect(found.find((o) => o.id === "mt-csv-report-csv")).toBeTruthy();
  });

  it("D1 stays silent when the task already ran at tier 4", () => {
    const spec = TaskSpec.parse({ customerId: "c", title: "csv report", input: "rows", skills: ["reporting"] });
    const found = detect(facts({
      outcomes: [{ key: "t1", title: "csv report", taskId: "x1", spec, result: result({ tierUsed: 4 }) }],
    }));
    expect(found.find((o) => o.source === "detector:missed-tool-match")).toBeUndefined();
  });

  it("D2 fires on a skill tag no worker advertises, and names a real alternative", () => {
    const found = detect(facts({
      planned: [PlannedTask.parse({ key: "t1", title: "x", input: "y", skills: ["database"] })],
    }));
    const d2 = found.find((o) => o.source === "detector:unknown-skill");
    expect(d2).toBeTruthy();
    expect(d2!.name).toContain("database");
    expect(d2!.body).toContain("reporting");
  });

  it("D2 stays silent on a tag the hive does advertise", () => {
    const found = detect(facts({
      planned: [PlannedTask.parse({ key: "t1", title: "x", input: "y", skills: ["coding"] })],
    }));
    expect(found.find((o) => o.source === "detector:unknown-skill")).toBeUndefined();
  });

  it("D3 fires on a dangling dependsOn and names the missing key", () => {
    const spec = TaskSpec.parse({ customerId: "c", title: "a", input: "i" });
    const found = detect(facts({
      planned: [
        PlannedTask.parse({ key: "t1", title: "a", input: "i" }),
        PlannedTask.parse({ key: "t2", title: "b", input: "i", dependsOn: ["ghost"] }),
      ],
      outcomes: [{ key: "t1", title: "a", taskId: "x1", spec, result: result() }],
    }));
    const d3 = found.find((o) => o.id === "ds-dangling-dep");
    expect(d3).toBeTruthy();
    expect(d3!.description).toContain("ghost");
  });

  it("D4 fires when a lone task needed retries, not when a multi-task plan did", () => {
    const spec = TaskSpec.parse({ customerId: "c", title: "a", input: "i" });
    const single = detect(facts({
      outcomes: [{ key: "t1", title: "a", taskId: "x1", spec, result: result() }],
      attempts: new Map([["x1", 2]]),
    }));
    expect(single.find((o) => o.id === "esc-single")).toBeTruthy();

    const multi = detect(facts({
      planned: [
        PlannedTask.parse({ key: "t1", title: "a", input: "i" }),
        PlannedTask.parse({ key: "t2", title: "b", input: "i" }),
      ],
      outcomes: [
        { key: "t1", title: "a", taskId: "x1", spec, result: result() },
        { key: "t2", title: "b", taskId: "x2", spec, result: result() },
      ],
      attempts: new Map([["x1", 2], ["x2", 1]]),
    }));
    expect(multi.find((o) => o.source === "detector:escalation")).toBeUndefined();
  });

  it("D5 fires on a clean multi-step plan and not on a degraded one", () => {
    const spec = TaskSpec.parse({ customerId: "c", title: "a", input: "i" });
    const planned = [
      PlannedTask.parse({ key: "t1", title: "fetch", input: "i" }),
      PlannedTask.parse({ key: "t2", title: "summarize", input: "i", dependsOn: ["t1"] }),
    ];
    const outcomes = [
      { key: "t1", title: "fetch", taskId: "x1", spec, result: result() },
      { key: "t2", title: "summarize", taskId: "x2", spec, result: result() },
    ];
    const clean = detect(facts({ planned, outcomes, attempts: new Map([["x1", 1], ["x2", 1]]) }));
    expect(clean.find((o) => o.type === "playbook")).toBeTruthy();

    const degraded = detect(facts({
      planned,
      outcomes: [outcomes[0], { ...outcomes[1], result: result({ degraded: true }) }],
      attempts: new Map([["x1", 1], ["x2", 1]]),
    }));
    expect(degraded.find((o) => o.type === "playbook")).toBeUndefined();
  });

  it("D5 rewards decomposition only when a step reached something stronger than the planner", () => {
    // Solo mode on a notebook: the Queen and the local bee are both tier 3. A
    // 2-task plan there is 1 planning call + 2 worker calls + 1 synthesis call
    // of one small model, so rewarding it teaches the Queen to be slower and
    // worse. The comparison is by TIER, not model name — see the escalation
    // case below, which a name check got exactly backwards.
    const spec = TaskSpec.parse({ customerId: "c", title: "a", input: "i" });
    const planned = [
      PlannedTask.parse({ key: "t1", title: "fetch", input: "i" }),
      PlannedTask.parse({ key: "t2", title: "sum", input: "i", dependsOn: ["t1"] }),
    ];
    const local = [
      { key: "t1", title: "fetch", taskId: "x1", spec, result: result({ tierUsed: 3, model: "qwen3.5:4b" }) },
      { key: "t2", title: "sum", taskId: "x2", spec, result: result({ tierUsed: 3, model: "qwen3.5:4b" }) },
    ];
    const attempts = new Map([["x1", 1], ["x2", 1]]);

    const shared = detect(facts({ planned, outcomes: local, attempts, plannerTier: 3 }));
    expect(shared.find((o) => o.type === "playbook")).toBeUndefined();

    // Escalated planning: the planner ran at tier 2 (a cloud model) while the
    // steps stayed on the local bee. The steps are WEAKER than the planner, so
    // this must not be rewarded — a model-name comparison would have called
    // the differing names an "escape" and minted a playbook here.
    const escalated = detect(facts({ planned, outcomes: local, attempts, plannerTier: 2 }));
    expect(escalated.find((o) => o.type === "playbook")).toBeUndefined();

    // A step that genuinely reached a stronger bee earned its split.
    const escaped = detect(facts({
      planned,
      outcomes: [local[0], { ...local[1], result: result({ tierUsed: 1, model: "sonnet" }) }],
      attempts,
      plannerTier: 3,
    }));
    expect(escaped.find((o) => o.type === "playbook")).toBeTruthy();

    // So did one that reached a zero-token tool.
    const tooled = detect(facts({
      planned,
      outcomes: [local[0], { ...local[1], result: result({ tierUsed: 4, model: undefined }) }],
      attempts,
      plannerTier: 3,
    }));
    expect(tooled.find((o) => o.type === "playbook")).toBeTruthy();
  });

  it("a clean single-task plan teaches nothing at all — the common case is free", () => {
    const spec = TaskSpec.parse({ customerId: "c", title: "a", input: "i", skills: ["coding"] });
    const found = detect(facts({
      planned: [PlannedTask.parse({ key: "t1", title: "a", input: "i", skills: ["coding"] })],
      outcomes: [{ key: "t1", title: "a", taskId: "x1", spec, result: result() }],
      attempts: new Map([["x1", 1]]),
    }));
    expect(found).toEqual([]);
  });
});

describe("reflection", () => {
  const spec = TaskSpec.parse({ customerId: "c", title: "csv report", input: "rows", skills: ["reporting"] });
  const outcomes = [{ key: "t1", title: "csv report", taskId: "x1", spec, result: result({ tierUsed: 3 }) }];

  it("writes what the detectors found", async () => {
    const s = store();
    const { learned } = await reflect(
      { ...facts({ outcomes }), customerId: "aiotlab", confidential: false, plannerDegraded: false },
      s,
    );
    expect(learned.length).toBeGreaterThan(0);
    expect(s.load("aiotlab").length).toBeGreaterThan(0);
  });

  it("writes nothing for a confidential turn", async () => {
    const s = store();
    const { learned } = await reflect(
      { ...facts({ outcomes }), customerId: "aiotlab", confidential: true, plannerDegraded: false },
      s,
    );
    expect(learned).toEqual([]);
    expect(s.load("aiotlab")).toEqual([]);
  });

  it("writes nothing when the plan was fabricated by the offline fallback", async () => {
    const s = store();
    const { learned } = await reflect(
      { ...facts({ outcomes }), customerId: "aiotlab", confidential: false, plannerDegraded: true },
      s,
    );
    expect(learned).toEqual([]);
  });

  it("still learns when the phrasing model is unavailable", async () => {
    const s = store();
    const planned = [
      PlannedTask.parse({ key: "t1", title: "fetch", input: "i" }),
      PlannedTask.parse({ key: "t2", title: "sum", input: "i", dependsOn: ["t1"] }),
    ];
    const clean = [
      { key: "t1", title: "fetch", taskId: "x1", spec, result: result() },
      { key: "t2", title: "sum", taskId: "x2", spec, result: result() },
    ];
    const { learned } = await reflect(
      {
        ...facts({ planned, outcomes: clean, attempts: new Map([["x1", 1], ["x2", 1]]) }),
        customerId: "aiotlab", confidential: false, plannerDegraded: false,
      },
      s,
      async () => { throw new Error("ollama down"); },
    );
    expect(learned.find((l) => l.type === "playbook")).toBeTruthy();
  });

  it("never throws, even when the store cannot be written", async () => {
    const broken = new MemoryStore("/dev/null/nope");
    await expect(
      reflect(
        { ...facts({ outcomes }), customerId: "aiotlab", confidential: false, plannerDegraded: false },
        broken,
      ),
    ).resolves.toEqual({ learned: [], costUsd: 0 });
  });
});
