import { describe, expect, it } from "vitest";
import { TaskSpec } from "@hive/shared";
import { matchTool, scoreDifficulty, type ToolInfo } from "../src/analyzer.js";

const spec = (partial: Partial<TaskSpec>): TaskSpec =>
  TaskSpec.parse({ customerId: "auo", title: "t", input: "x", ...partial });

describe("difficulty scoring", () => {
  it("short plain text is simple", () => {
    expect(scoreDifficulty(spec({ title: "Slogan", input: "Write a short safety slogan." }))).toBe("simple");
  });

  it("summarize/translate style work is standard", () => {
    expect(scoreDifficulty(spec({ input: "Summarize this incident report for management." }))).toBe("standard");
  });

  it("multi-step engineering verbs are complex", () => {
    expect(
      scoreDifficulty(spec({ input: "Refactor the scheduler module and optimize the hot path end-to-end." })),
    ).toBe("complex");
  });
});

describe("tier-4 tool matching", () => {
  const tools: ToolInfo[] = [
    { toolId: "csv-report", skills: ["reporting"], requiredKeys: ["csv"] },
    { toolId: "log-extract", skills: [], requiredKeys: ["pattern"] },
  ];

  it("matches when required keys and skills line up", () => {
    const s = spec({ skills: ["reporting"], toolInput: { csv: "a,b\n1,2" } });
    expect(matchTool(s, tools)?.toolId).toBe("csv-report");
  });

  it("does not match without toolInput", () => {
    expect(matchTool(spec({ skills: ["reporting"] }), tools)).toBeUndefined();
  });

  it("skill-less tools match on keys alone", () => {
    const s = spec({ toolInput: { pattern: "ERROR" } });
    expect(matchTool(s, tools)?.toolId).toBe("log-extract");
  });

  it("does not match when a required key is missing", () => {
    const s = spec({ skills: ["reporting"], toolInput: { notCsv: true } });
    expect(matchTool(s, tools)).toBeUndefined();
  });
});
