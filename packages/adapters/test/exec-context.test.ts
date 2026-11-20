import { describe, expect, it } from "vitest";
import { cancelSignal, execSignal, reportStep, runWithExecContext } from "../src/exec-context.js";

/**
 * The per-task context is how a cancel reaches an adapter's innermost call
 * without every method signature carrying a signal. These pin the two
 * properties that matter: inside a task the cancel propagates, and outside one
 * nothing changes from the plain timeout every call site used before.
 */

describe("exec context", () => {
  it("is a plain timeout outside a task", () => {
    expect(cancelSignal()).toBeUndefined();
    expect(execSignal(1000).aborted).toBe(false);
    expect(() => reportStep("thinking")).not.toThrow();
  });

  it("carries the task's cancel into every signal asked for inside it", async () => {
    const abort = new AbortController();
    await runWithExecContext({ signal: abort.signal }, async () => {
      const combined = execSignal(60_000);
      await Promise.resolve();
      expect(combined.aborted).toBe(false);
      abort.abort("owner cancelled");
      expect(combined.aborted).toBe(true);
      expect(cancelSignal()?.aborted).toBe(true);
    });
  });

  it("delivers steps to the task that reported them, across awaits", async () => {
    const seen: string[] = [];
    await runWithExecContext({ onStep: (phase, step) => seen.push(`${phase}:${step?.n ?? "-"}`) }, async () => {
      reportStep("reading-files");
      await new Promise((r) => setTimeout(r, 1));
      reportStep("thinking", { n: 2, of: 4 });
    });
    expect(seen).toEqual(["reading-files:-", "thinking:2"]);
  });

  it("never lets a broken step listener break the work", async () => {
    await runWithExecContext(
      {
        onStep: () => {
          throw new Error("ui crashed");
        },
      },
      async () => {
        expect(() => reportStep("writing")).not.toThrow();
      },
    );
  });
});
