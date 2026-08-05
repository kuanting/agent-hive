import { describe, expect, it } from "vitest";
import { Passthrough, TaskSpec, type CapabilityRecord, type TaskMessage } from "@hive/shared";
import { flattenPassthrough, promptForTask, STABLE_PROMPT_PREFIX } from "../src/types.js";

/**
 * What text a capability actually receives.
 *
 * The bug this fences: the worker asked "is a passthrough attached?" when the
 * question is "can this adapter read one?". A plain `hive/claude-code` chat
 * completion carries a transcript, so prompt assembly was skipped — and
 * `official-agent` has never looked at `passthrough`, so it ran `claude -p ""`.
 * The caller's messages reached the machine and never reached the model.
 */

const cap = (over: Partial<CapabilityRecord> = {}): CapabilityRecord =>
  ({ runtime: "claude-code", tier: 1, billing: "subscription", skills: [], ...over }) as CapabilityRecord;

const task = (over: Partial<TaskMessage> = {}): TaskMessage =>
  ({
    kind: "task",
    taskId: "t1",
    attempt: 1,
    spec: TaskSpec.parse({ customerId: "aiotlab", title: "Summarize", input: "the run log" }),
    envelope: { maxUsd: 0, tier: 1, allowEscalation: true, urgency: "normal", degraded: false },
    difficulty: "simple",
    ...over,
  }) as TaskMessage;

const conversation = Passthrough.parse({
  messages: [
    { role: "system", content: "You are a terse assistant." },
    { role: "user", content: "what is in a.txt?" },
  ],
});

const noArtifacts = () => "";

describe("promptForTask", () => {
  it("assembles the hive prompt for an ordinary task", () => {
    const p = promptForTask(task(), cap(), false, noArtifacts);
    expect(p.startsWith(STABLE_PROMPT_PREFIX)).toBe(true);
    expect(p).toContain("the run log");
  });

  it("gives a passthrough-aware adapter nothing, because it reads the message itself", () => {
    expect(promptForTask(task({ passthrough: conversation }), cap({ runtime: "api", tier: 2 }), true, noArtifacts)).toBe("");
  });

  it("renders the transcript for an adapter that cannot read one", () => {
    // The regression. This used to be "".
    const p = promptForTask(task({ passthrough: conversation }), cap(), false, noArtifacts);
    expect(p).not.toBe("");
    expect(p).toContain("what is in a.txt?");
    expect(p).toContain("You are a terse assistant.");
  });

  it("does not prepend the hive's own framing to somebody else's conversation", () => {
    // The worker-bee prefix is the right head for a hive task and the wrong one
    // in front of a caller's system message.
    const p = promptForTask(task({ passthrough: conversation }), cap(), false, noArtifacts);
    expect(p.startsWith(STABLE_PROMPT_PREFIX)).toBe(false);
    expect(p).not.toContain(STABLE_PROMPT_PREFIX);
  });

  it("gives tier 4 nothing at all — a program reads none of it", () => {
    expect(promptForTask(task(), cap({ tier: 4, runtime: "tool" }), false, noArtifacts)).toBe("");
    expect(promptForTask(task({ passthrough: conversation }), cap({ tier: 4, runtime: "tool" }), false, noArtifacts)).toBe("");
  });

  it("gives nothing when no capability was chosen", () => {
    expect(promptForTask(task(), undefined, false, noArtifacts)).toBe("");
  });
});

describe("flattenPassthrough", () => {
  it("keeps every turn, in order, labelled by role", () => {
    const p = flattenPassthrough(conversation);
    expect(p.indexOf("system:")).toBeLessThan(p.indexOf("user:"));
  });

  it("names tool calls rather than dropping the turn that made them", () => {
    const withCall = Passthrough.parse({
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "hello" },
      ],
    });
    const p = flattenPassthrough(withCall);
    expect(p).toContain("read_file");
    expect(p).toContain("tool: hello");
  });

  it("drops turns that carry nothing, rather than emitting a bare role", () => {
    const withEmpty = Passthrough.parse({
      messages: [
        { role: "system", content: "   " },
        { role: "user", content: "hi" },
      ],
    });
    expect(flattenPassthrough(withEmpty)).toBe("user: hi");
  });
});
