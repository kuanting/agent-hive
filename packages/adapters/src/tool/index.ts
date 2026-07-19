import { z } from "zod";
import type { CapabilityRecord, TaskMessage } from "@hive/shared";
import type { ExecResult, RuntimeAdapter } from "../types.js";

export interface HardcodedTool {
  toolId: string;
  skills: string[];
  inputSchema: z.ZodType<Record<string, unknown>>;
  run(input: Record<string, unknown>, readArtifact: (ref: string) => string): string;
}

// ---- demo tool 1: CSV column report ----
const csvReportInput = z.object({
  csv: z.string().optional(),
  csvArtifact: z.string().optional(),
});

export const csvReportTool: HardcodedTool = {
  toolId: "csv-report",
  skills: ["reporting"],
  inputSchema: csvReportInput as z.ZodType<Record<string, unknown>>,
  run(input, readArtifact) {
    const parsed = csvReportInput.parse(input);
    const raw = parsed.csv ?? (parsed.csvArtifact ? readArtifact(parsed.csvArtifact) : "");
    if (!raw.trim()) throw new Error("csv-report: no csv content");
    const rows = raw.trim().split(/\r?\n/).map((l) => l.split(","));
    const [header, ...data] = rows;
    const lines = [`rows: ${data.length}`, `columns: ${header.length} (${header.join(", ")})`];
    header.forEach((col, i) => {
      const values = data.map((r) => Number(r[i])).filter((n) => !Number.isNaN(n));
      if (values.length === data.length && data.length > 0) {
        const sum = values.reduce((a, b) => a + b, 0);
        lines.push(
          `${col}: numeric, min=${Math.min(...values)}, max=${Math.max(...values)}, mean=${(sum / values.length).toFixed(2)}`,
        );
      }
    });
    return lines.join("\n");
  },
};

// ---- demo tool 2: log line extractor ----
const logExtractInput = z.object({
  pattern: z.string(),
  text: z.string().optional(),
  textArtifact: z.string().optional(),
});

export const logExtractTool: HardcodedTool = {
  toolId: "log-extract",
  skills: ["reporting", "ops"],
  inputSchema: logExtractInput as z.ZodType<Record<string, unknown>>,
  run(input, readArtifact) {
    const parsed = logExtractInput.parse(input);
    const raw = parsed.text ?? (parsed.textArtifact ? readArtifact(parsed.textArtifact) : "");
    const re = new RegExp(parsed.pattern);
    const hits = raw.split(/\r?\n/).filter((l) => re.test(l));
    return `${hits.length} matching lines\n${hits.slice(0, 200).join("\n")}`;
  },
};

export const BUILTIN_TOOLS: HardcodedTool[] = [csvReportTool, logExtractTool];

/** Tier 4: deterministic programs, zero tokens, zero cost. */
export class ToolAdapter implements RuntimeAdapter {
  runtimes = ["tool"];

  constructor(
    private tools: HardcodedTool[],
    private readArtifact: (ref: string) => string,
  ) {}

  registeredTools(): HardcodedTool[] {
    return this.tools;
  }

  async execute(task: TaskMessage, _capability: CapabilityRecord): Promise<ExecResult> {
    const tool = this.tools.find((t) => t.toolId === task.matchedToolId);
    if (!tool) {
      return { ok: false, output: "", error: `unknown tool ${task.matchedToolId}`, inputTokens: 0, outputTokens: 0, runtimeUsed: "tool" };
    }
    try {
      const output = tool.run(tool.inputSchema.parse(task.spec.toolInput ?? {}), this.readArtifact);
      return { ok: true, output, inputTokens: 0, outputTokens: 0, runtimeUsed: `tool:${tool.toolId}` };
    } catch (err) {
      return { ok: false, output: "", error: String(err), inputTokens: 0, outputTokens: 0, runtimeUsed: `tool:${tool.toolId}` };
    }
  }
}
