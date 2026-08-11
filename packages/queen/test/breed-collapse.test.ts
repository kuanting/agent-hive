import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskEpisodeLog, type EpisodeAttempt, type TaskEpisode } from "../src/episode.js";
import * as query from "../src/breed/query.js";

/**
 * What the corpus says after somebody acts on what it said.
 *
 * The loop the whole feature describes: agent traffic reveals a recurring
 * procedure, a tool gets written, and the same work stops costing anything. This
 * asserts both halves are visible at once — and, more importantly, that they stay
 * separate. The expensive history does not retroactively become cheap because
 * something cheaper exists now, and a demo implying otherwise would be selling a
 * saving nobody made.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "collapse-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const attempt = (over: Partial<EpisodeAttempt> = {}): EpisodeAttempt => ({
  attempt: 1,
  tier: 2,
  runtime: "api",
  model: "gemini-3-flash-preview",
  ok: true,
  degraded: false,
  inputTokens: 5200,
  outputTokens: 340,
  costUsd: 0.0031,
  durationMs: 1800,
  ...over,
});

const base = (over: Partial<TaskEpisode> = {}): TaskEpisode => ({
  taskId: "t",
  customerId: "breeder",
  at: Date.now(),
  mode: "metadata",
  skills: [],
  artifactCount: 0,
  attempts: [attempt()],
  ok: true,
  wallMs: 1800,
  ...over,
});

/** Six agent loops, two turns each, calling the caller's own tools. */
function seedLoops(log: TaskEpisodeLog): void {
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const at = now - (6 - i) * 3_600_000;
    const shared = { loopId: `L${i}`, declaredTools: ["digikey_search", "get_price"] };
    log.append(
      base({
        ...shared,
        taskId: `loop-${i}-a`,
        at,
        turnIndex: 1,
        attempts: [attempt({ toolCallNames: ["digikey_search"], toolCallArgKeys: [["part"]] })],
      }),
    );
    log.append(
      base({
        ...shared,
        taskId: `loop-${i}-b`,
        at: at + 2000,
        turnIndex: 3,
        attempts: [attempt({ toolCallNames: ["get_price"], toolCallArgKeys: [["sku"]] })],
      }),
    );
  }
}

/** The same work, after the tool exists: tier 4, no tokens, no money. */
function seedToolRuns(log: TaskEpisodeLog): void {
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    log.append(
      base({
        taskId: `tool-${i}`,
        at: now + i * 1000,
        skills: ["sourcing"],
        toolInputKeys: ["part"],
        attempts: [
          attempt({
            tier: 4,
            runtime: "tool:digikey-price",
            model: undefined,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            durationMs: 3,
          }),
        ],
        wallMs: 3,
      }),
    );
  }
}

describe("the loop, closed", () => {
  it("shows the procedure that recurred, and what it cost", () => {
    const log = new TaskEpisodeLog(root);
    seedLoops(log);

    const [flow] = query.flows({ root });
    expect(flow.flow).toBe("digikey_search -> get_price");
    expect(flow.loops).toBe(6);
    expect(flow.turns).toBe(12);
    expect(flow.cost_usd).toBeGreaterThan(0);
  });

  it("shows the same work costing nothing once a program serves it", () => {
    const log = new TaskEpisodeLog(root);
    seedLoops(log);
    seedToolRuns(log);

    const sourcing = query.shapes({ root }).find((s) => s.skills_key === "sourcing");
    expect(sourcing).toBeDefined();
    expect(sourcing!.occurrences).toBe(6);
    expect(sourcing!.tool_input_keys_key).toBe("part");
    expect(sourcing!.cost_usd).toBe(0);
  });

  it("leaves the expensive history exactly where it was", () => {
    // The honest half. Six loops cost what they cost, and they go on costing it
    // — the tool changes what happens next, not what already happened. A view
    // that quietly folded the two together would report a saving on work nobody
    // re-ran.
    const log = new TaskEpisodeLog(root);
    seedLoops(log);
    const before = query.flows({ root })[0];

    seedToolRuns(log);
    const after = query.flows({ root })[0];

    expect(after).toEqual(before);
  });

  it("keeps the tool runs out of the flow view, since they are not a loop", () => {
    // A tier-4 task has no transcript and so no loop to reconstruct. It belongs
    // to `shapes`, and putting it in `flows` would invent a procedure that never
    // ran as one.
    const log = new TaskEpisodeLog(root);
    seedLoops(log);
    seedToolRuns(log);

    expect(query.flows({ root })).toHaveLength(1);
    expect(query.flows({ root })[0].loops).toBe(6);
  });
});
