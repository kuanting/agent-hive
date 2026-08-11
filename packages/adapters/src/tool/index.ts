import { existsSync } from "node:fs";
import { z } from "zod";
import type { CapabilityRecord, TaskMessage } from "@hive/shared";
import type { ExecResult, RuntimeAdapter } from "../types.js";
import {
  listPersonalDir,
  MAX_FILE_BYTES,
  readPersonalFile,
  safeResolve,
  type DirEntry,
} from "../personal-agent/sandbox.js";
import { digikeyPriceTool } from "./digikey.js";

/**
 * A tool's view of its own local store.
 *
 * Deliberately not a path. `run` is handed input that came from a caller, and a
 * tool given a root would be one `join(root, input.part)` away from serving
 * whatever it was asked for. Every method here resolves through the personal
 * bee's sandbox against a root the tool cannot see or change, so escaping it is
 * impossible rather than merely discouraged — the same reason that bee's mini
 * agent gets tools instead of a directory.
 *
 * This is what makes the useful shape of tier-4 work possible: a scraper on a
 * schedule writes the store, and the tool reads it. A lookup that answered by
 * fetching would put a third party on the critical path of a user's request.
 */
export interface ToolData {
  /** UTF-8 contents, capped by the sandbox. Throws on escape, ENOENT on absence. */
  read(rel: string): string;
  /** `read` plus a parse, distinguishing a truncated file from a malformed one. */
  readJson<T>(rel: string): T;
  list(rel?: string): DirEntry[];
  exists(rel: string): boolean;
}

export function toolData(root: string): ToolData {
  return {
    read: (rel) => readPersonalFile(root, rel),
    readJson<T>(rel: string): T {
      const raw = readPersonalFile(root, rel);
      // The sandbox truncates rather than throwing, which is right for prose and
      // wrong for anything parsed: without this the caller sees a JSON syntax
      // error and goes hunting for a corrupt file that is perfectly well formed.
      if (raw.length >= MAX_FILE_BYTES) {
        throw new Error(
          `'${rel}' hit the sandbox's ${MAX_FILE_BYTES / 1024}KB read cap and was truncated. ` +
            `Shard the store; the reader will not raise the cap.`,
        );
      }
      return JSON.parse(raw) as T;
    },
    list: (rel = ".") => listPersonalDir(root, rel),
    exists(rel) {
      // Resolved through the sandbox first, so asking about a path outside the
      // root answers "no" rather than leaking whether it is there.
      try {
        return existsSync(safeResolve(root, rel));
      } catch {
        return false;
      }
    },
  };
}

export interface HardcodedTool {
  toolId: string;
  skills: string[];
  inputSchema: z.ZodType<Record<string, unknown>>;
  /**
   * @param data this tool's local store, when the operator configured one.
   *   Undefined is a *configuration* fact rather than a missing file, and a tool
   *   that needs a store should say which — reporting an empty store when none
   *   was configured sends the reader to look for data that was never meant to
   *   be there.
   */
  run(input: Record<string, unknown>, readArtifact: (ref: string) => string, data?: ToolData): string;
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

// The third tool was not designed here — it was written after reading what the
// usage corpus said the hive kept being asked to do. See tool/digikey.ts.
export const BUILTIN_TOOLS: HardcodedTool[] = [csvReportTool, logExtractTool, digikeyPriceTool];

export interface ToolAdapterOptions {
  tools: HardcodedTool[];
  readArtifact: (ref: string) => string;
  /**
   * Where tier-4 tools' local stores live, each tool owning a subdirectory.
   * Omit and tools run with no store — which is exactly right for the two that
   * transform their input and need none.
   */
  dataDir?: string;
}

/** Tier 4: deterministic programs, zero tokens, zero cost. */
export class ToolAdapter implements RuntimeAdapter {
  runtimes = ["tool"];
  private readonly tools: HardcodedTool[];
  private readonly readArtifact: (ref: string) => string;
  private readonly data?: ToolData;

  constructor(opts: ToolAdapterOptions) {
    this.tools = opts.tools;
    this.readArtifact = opts.readArtifact;
    this.data = opts.dataDir ? toolData(opts.dataDir) : undefined;
  }

  registeredTools(): HardcodedTool[] {
    return this.tools;
  }

  async execute(task: TaskMessage, _capability: CapabilityRecord): Promise<ExecResult> {
    const tool = this.tools.find((t) => t.toolId === task.matchedToolId);
    if (!tool) {
      return { ok: false, output: "", error: `unknown tool ${task.matchedToolId}`, inputTokens: 0, outputTokens: 0, runtimeUsed: "tool" };
    }
    try {
      const output = tool.run(tool.inputSchema.parse(task.spec.toolInput ?? {}), this.readArtifact, this.data);
      return { ok: true, output, inputTokens: 0, outputTokens: 0, runtimeUsed: `tool:${tool.toolId}` };
    } catch (err) {
      // The tool id survives the failure, so a failed attempt stays attributable
      // in the corpus. Note what this costs: a tier-4 failure escalates, and
      // `matchTool` is skipped on a retry — so every throw inside a tool is a
      // decision to spend money on a model instead.
      return { ok: false, output: "", error: String(err), inputTokens: 0, outputTokens: 0, runtimeUsed: `tool:${tool.toolId}` };
    }
  }
}
