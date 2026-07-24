import { afterAll, beforeAll, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityRecord, TaskMessage } from "@hive/shared";
import { OfficialAgentAdapter } from "../src/index.js";

// A fake `codex` on PATH that emits the JSONL shape the adapter parses:
// a final agent message + a turn.completed usage event.
let origPath: string | undefined;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "codex-shim-"));
  const shim = join(dir, "codex");
  writeFileSync(
    shim,
    `#!/bin/sh
echo '{"type":"item.completed","item":{"type":"agent_message","text":"hello from codex"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}'
`,
  );
  chmodSync(shim, 0o755);
  origPath = process.env.PATH;
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
});

afterAll(() => {
  process.env.PATH = origPath;
});

it("runs `codex exec --json` and parses final message + token usage", async () => {
  const cap: CapabilityRecord = {
    runtime: "codex",
    tier: 1,
    billing: "subscription",
    model: "gpt-5-codex",
    skills: ["general"],
  };
  const res = await new OfficialAgentAdapter().execute({} as TaskMessage, cap, "do something");
  expect(res.ok).toBe(true);
  expect(res.output).toBe("hello from codex");
  expect(res.inputTokens).toBe(100);
  expect(res.outputTokens).toBe(20);
  expect(res.reportedUsd).toBe(0); // subscription seat -> zero marginal USD
  expect(res.runtimeUsed).toBe("codex");
  expect(res.modelUsed).toBe("gpt-5-codex");
});
