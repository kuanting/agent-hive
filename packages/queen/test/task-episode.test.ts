import { beforeEach, describe, expect, it } from "vitest";
import { TaskSpec, type Bus } from "@hive/shared";
import { QueenCore } from "../src/core.js";
import { tmpRootWithCustomers } from "./tmpRoot.js";

/**
 * Every intake path feeds the corpus, or the corpus is a lie.
 *
 * Only the planner ever wrote an episode, which was fine while the planner was
 * the only way in. `/v1/chat/completions` and `POST /tasks` reach `submitTask`
 * without making a turn, so on the surface the hive is moving toward, nothing
 * was being written down at all — a training set that quietly excludes the
 * traffic it is meant to learn from.
 *
 * These drive the core through the *structured* intake only. No planner, no
 * chat: if the row shows up here, it shows up for every caller.
 */

const rootWith = tmpRootWithCustomers;

const profile = (id: string, recordEpisodes: string) =>
  `customerId: ${id}\nname: ${id}\nbudget:\n  capUsd: 10\npolicy:\n  recordEpisodes: ${recordEpisodes}\n`;

function fakeBus() {
  const handlers = new Map<string, (msg: unknown, rk: string) => Promise<void>>();
  const bus: Bus = {
    publish() {},
    async consume(_exchange, queue, _patterns, schema, handler) {
      handlers.set(queue, (msg, rk) => handler(schema.parse(msg), rk));
    },
    async pause() {},
    async close() {},
  };
  return { bus, deliver: (queue: string, msg: unknown) => handlers.get(queue)!(msg, "") };
}

const spec = (over: Partial<TaskSpec> = {}): TaskSpec =>
  TaskSpec.parse({ customerId: "full-co", title: "Roll up the sales csv", input: "columns please", ...over });

let f: ReturnType<typeof fakeBus>;

const LOCAL_BEE = { agent: "hermes", runtime: "hermes", model: "gemma4:12b", tier: 3, billing: "local", skills: ["general"] };
/** A fleet that exists but bills per token, so confidential work has nowhere to go. */
const CLOUD_BEE = { agent: "api", runtime: "api", model: "gemini-3-flash-preview", tier: 2, billing: "per-token", skills: ["general"] };

async function coreOn(root: string, capabilities: unknown[] = [LOCAL_BEE]) {
  f = fakeBus();
  const core = await QueenCore.create(root, f.bus);
  await f.deliver("queen.hello", { kind: "agent.hello", agentId: "bee-1", site: "local", capabilities });
  return core;
}

/** What a bee sends back. Defaults to a clean first-attempt success. */
const resultFor = (taskId: string, over: Record<string, unknown> = {}) => ({
  kind: "task.result",
  taskId,
  attempt: 1,
  agentId: "local-bee-1",
  customerId: "full-co",
  ok: true,
  output: "rows: 12",
  tierUsed: 3,
  runtime: "hermes",
  billing: "local",
  usage: { inputTokens: 300, outputTokens: 40, costUsd: 0 },
  degraded: false,
  durationMs: 1200,
  ...over,
});

describe("a settled task is written down, whoever asked for it", () => {
  let core: QueenCore;

  beforeEach(async () => {
    core = await coreOn(rootWith({ "full-co": profile("full-co", "full") }));
  });

  it("records a task submitted through the structured intake, with no planner involved", async () => {
    const { taskId } = core.submitTask(spec({ skills: ["reporting"], toolInput: { csv: "a,b\n1,2" } }));
    await f.deliver("queen.results", resultFor(taskId));

    const rows = core.taskEpisodes.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId,
      customerId: "full-co",
      ok: true,
      skills: ["reporting"],
      // names only — the value "a,b\n1,2" is content and lives under the mode gate
      toolInputKeys: ["csv"],
      artifactCount: 0,
    });
    expect(rows[0].attempts).toHaveLength(1);
    expect(rows[0].wallMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps the whole attempt chain, so an escalation is visible as a label", async () => {
    const { taskId } = core.submitTask(spec());
    await f.deliver("queen.results", resultFor(taskId, { ok: false, error: "model gave up", output: "" }));
    // The Queen escalated rather than settling; attempt 2 is what finishes it.
    expect(core.taskEpisodes.readAll()).toHaveLength(0);
    await f.deliver("queen.results", resultFor(taskId, { attempt: 2, tierUsed: 1, runtime: "claude-code" }));

    const [row] = core.taskEpisodes.readAll();
    // "failed at tier 3, then succeeded at tier 1" is the row worth training on,
    // and it is invisible from the final result alone.
    expect(row.attempts.map((a) => [a.tier, a.ok])).toEqual([
      [3, false],
      [1, true],
    ]);
    expect(row.ok).toBe(true);
  });

  it("records the refusals too — the hive giving up is a label worth having", async () => {
    // Confidential work with only a cloud-billing fleet has nowhere to go, so the
    // core refuses synchronously. No bee ever ran, so there is no history to read
    // — the row has to come from the synthesized result instead.
    core = await coreOn(rootWith({ "full-co": profile("full-co", "full") }), [CLOUD_BEE]);
    const { taskId } = core.submitTask(spec({ sensitivity: "confidential" }));
    await core.awaitResult(taskId);

    const [row] = core.taskEpisodes.readAll();
    expect(row.taskId).toBe(taskId);
    expect(row.ok).toBe(false);
    expect(row.attempts).toHaveLength(1);
  });

  it("records a cache hit as the recurrence it is, spending nothing", async () => {
    const first = core.submitTask(spec());
    await f.deliver("queen.results", resultFor(first.taskId));

    // Same words, same customer, inside the cache window.
    const second = core.submitTask(spec());
    expect(second.cached).toBe(true);

    const rows = core.taskEpisodes.readAll();
    expect(rows).toHaveLength(2);
    // Occurrences is the first question anyone asks this corpus, and a shape
    // asked for often enough to keep hitting the cache is the strongest
    // candidate for replacement — it must not look like the weakest.
    expect(rows[1].cached).toBe(true);
    // Nothing ran, so nothing is claimed to have run.
    expect(rows[1].attempts).toEqual([]);
    expect(rows[0].cached).toBeUndefined();
    // It reuses the original task's id rather than inventing one, so executions
    // stay countable by filtering the flag.
    expect(rows[1].taskId).toBe(first.taskId);
    expect(rows.filter((r) => !r.cached)).toHaveLength(1);
  });

  it("writes one row per task, not one per delivered result", async () => {
    const a = core.submitTask(spec());
    const b = core.submitTask(spec({ title: "another", input: "different work" }));
    await f.deliver("queen.results", resultFor(a.taskId));
    await f.deliver("queen.results", resultFor(b.taskId, { taskId: b.taskId }));
    // A late duplicate from a superseded attempt must not add a second row.
    await f.deliver("queen.results", resultFor(a.taskId));

    expect(core.taskEpisodes.readAll().map((r) => r.taskId).sort()).toEqual([a.taskId, b.taskId].sort());
  });
});

describe("the task row obeys the same privacy ratchet as the turn row", () => {
  it("keeps text only when the customer opted into full", async () => {
    const core = await coreOn(rootWith({ "full-co": profile("full-co", "full") }));
    const { taskId } = core.submitTask(spec());
    await f.deliver("queen.results", resultFor(taskId));

    const [row] = core.taskEpisodes.readAll();
    expect(row.mode).toBe("full");
    expect(row.title).toBe("Roll up the sales csv");
    expect(row.input).toBe("columns please");
    expect(row.output).toBe("rows: 12");
  });

  it("strips every text field at metadata, and keeps the measurements", async () => {
    const core = await coreOn(rootWith({ "full-co": profile("full-co", "metadata") }));
    const { taskId } = core.submitTask(spec());
    await f.deliver("queen.results", resultFor(taskId));

    const [row] = core.taskEpisodes.readAll();
    expect(row.mode).toBe("metadata");
    expect(row.downgradedReason).toMatch(/does not opt into recording task text/);
    expect(row.title).toBeUndefined();
    expect(row.input).toBeUndefined();
    expect(row.output).toBeUndefined();
    // The part that makes it a training row survives.
    expect(row.attempts[0]).toMatchObject({ tier: 3, inputTokens: 300 });
    expect(row.difficulty).toBeTruthy();
  });

  it("downgrades a confidential task even when the profile asked for full", async () => {
    const core = await coreOn(rootWith({ "full-co": profile("full-co", "full") }));
    // Local billing, so this one is actually routable and reaches a bee.
    const { taskId } = core.submitTask(spec({ sensitivity: "confidential" }));
    await f.deliver("queen.results", resultFor(taskId));

    const [row] = core.taskEpisodes.readAll();
    expect(row.mode).toBe("metadata");
    expect(row.downgradedReason).toMatch(/confidential/);
    expect(row.input).toBeUndefined();
    expect(row.output).toBeUndefined();
  });

  it("records task text at the tasks rung, which is what the engine needs", async () => {
    const core = await coreOn(rootWith({ "full-co": profile("full-co", "tasks") }));
    const { taskId } = core.submitTask(spec({ skills: ["reporting"], toolInput: { csv: "a,b\n1,2" } }));
    await f.deliver("queen.results", resultFor(taskId));

    const [row] = core.taskEpisodes.readAll();
    expect(row.mode).toBe("tasks");
    expect(row.downgradedReason).toBeUndefined();
    expect(row.title).toBe("Roll up the sales csv");
    expect(row.input).toBe("columns please");
    expect(row.output).toBe("rows: 12");
    // Values, not just names — when the planner already named the parameters,
    // nothing downstream has to infer them.
    expect(row.toolInput).toEqual({ csv: "a,b\n1,2" });
  });

  it("still ratchets a confidential task to metadata at the tasks rung", async () => {
    const core = await coreOn(rootWith({ "full-co": profile("full-co", "tasks") }));
    const { taskId } = core.submitTask(spec({ sensitivity: "confidential", toolInput: { csv: "secret" } }));
    await f.deliver("queen.results", resultFor(taskId));

    const [row] = core.taskEpisodes.readAll();
    expect(row.mode).toBe("metadata");
    expect(row.downgradedReason).toMatch(/confidential/);
    expect(row.input).toBeUndefined();
    expect(row.toolInput).toBeUndefined();
    // The key NAMES survive, because a name is structure.
    expect(row.toolInputKeys).toEqual(["csv"]);
  });

  it("treats an unrecognized rung as metadata, not as the nearest thing", async () => {
    // A customer profile is hand-edited yaml, and a typo must never open one.
    const core = await coreOn(rootWith({ "full-co": profile("full-co", "task") }));
    const { taskId } = core.submitTask(spec());
    await f.deliver("queen.results", resultFor(taskId));
    expect(core.taskEpisodes.readAll()[0].mode).toBe("metadata");
  });

  it("writes nothing at all when the customer said off", async () => {
    const core = await coreOn(rootWith({ "full-co": profile("full-co", "off") }));
    const { taskId } = core.submitTask(spec());
    await f.deliver("queen.results", resultFor(taskId));
    expect(core.taskEpisodes.readAll()).toEqual([]);
  });

  it("never lets a text field reach disk at metadata, checked on the bytes", async () => {
    // Belt and braces, the same reason episode.test.ts asserts on the serialized
    // record: a future field carrying text would slip past a field-by-field check.
    const core = await coreOn(rootWith({ "full-co": profile("full-co", "metadata") }));
    const { taskId } = core.submitTask(spec());
    await f.deliver("queen.results", resultFor(taskId));

    const raw = JSON.stringify(core.taskEpisodes.readAll());
    expect(raw).not.toContain("Roll up the sales csv");
    expect(raw).not.toContain("columns please");
    expect(raw).not.toContain("rows: 12");
  });
});
