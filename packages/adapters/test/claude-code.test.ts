import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSpec, type CapabilityRecord, type TaskMessage } from "@hive/shared";
import { OfficialAgentAdapter } from "../src/index.js";

/**
 * A fake `claude` on PATH that records the flags it was given and answers with
 * the JSON shape the real CLI produces.
 *
 * The usage numbers below are copied from a real `claude -p --output-format json`
 * response on a resumed session, and they are the whole reason this test exists:
 * `input_tokens: 2` against `cache_read_input_tokens: 35202`. The reported input
 * count is the uncached remainder, not the size of the prompt.
 */

let origPath: string | undefined;
let argsFile: string;

const cap: CapabilityRecord = {
  runtime: "claude-code",
  tier: 1,
  billing: "subscription",
  model: "sonnet",
  skills: ["general"],
};

function task(over: Partial<TaskMessage> = {}): TaskMessage {
  return {
    kind: "task",
    taskId: "t1",
    attempt: 1,
    spec: TaskSpec.parse({ customerId: "aiotlab", title: "t", input: "do a thing" }),
    envelope: { maxUsd: 0, tier: 1, allowEscalation: true, urgency: "normal", degraded: false },
    difficulty: "standard",
    ...over,
  } as TaskMessage;
}

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "claude-shim-"));
  argsFile = join(dir, "args.txt");
  const shim = join(dir, "claude");
  writeFileSync(
    shim,
    `#!/bin/sh
echo "$@" > ${argsFile}
echo '{"is_error":false,"result":"hello from claude","session_id":"session-from-cli","total_cost_usd":0.21,"usage":{"input_tokens":2,"output_tokens":7,"cache_creation_input_tokens":25,"cache_read_input_tokens":35202}}'
`,
  );
  chmodSync(shim, 0o755);
  origPath = process.env.PATH;
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
});

afterAll(() => {
  process.env.PATH = origPath;
});

const flags = () => readFileSync(argsFile, "utf8");

describe("the honey bee names its session so a follow-up can resume it", () => {
  it("passes a uuid --session-id on a cold run and reports what the CLI echoed", async () => {
    const res = await new OfficialAgentAdapter().execute(task(), cap, "do something");
    expect(res.ok).toBe(true);
    expect(res.output).toBe("hello from claude");
    expect(flags()).toMatch(/--session-id [0-9a-f-]{36}/);
    expect(flags()).not.toContain("--resume");
    // The CLI is the authority on what it actually used, so its echo wins over
    // the id we proposed.
    expect(res.sessionRef).toBe("session-from-cli");
  });

  it("resumes instead of naming a new session when the Queen supplies one", async () => {
    const res = await new OfficialAgentAdapter().execute(task({ resumeSession: "prior-session" }), cap, "and then?");
    expect(flags()).toContain("--resume prior-session");
    // Passing both would be contradictory — a resume run reuses the id it was given.
    expect(flags()).not.toContain("--session-id");
    expect(res.ok).toBe(true);
  });

  it("counts cached tokens toward the seat, because the seat's currency is quota", async () => {
    const res = await new OfficialAgentAdapter().execute(task(), cap, "do something");
    // 2 uncached + 25 written + 35202 read. Reporting the bare `input_tokens: 2`
    // made a seat that had just consumed ~35k tokens look untouched, and the
    // Queen meters the quota window on exactly this number.
    expect(res.inputTokens).toBe(35229);
    expect(res.cacheReadTokens).toBe(35202);
    expect(res.cacheWriteTokens).toBe(25);
    // Still zero marginal dollars: a prepaid seat spends quota, not money.
    expect(res.reportedUsd).toBe(0);
  });
});
