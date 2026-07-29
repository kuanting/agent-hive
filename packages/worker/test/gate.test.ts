import { describe, expect, it } from "vitest";
import { TaskGate } from "../src/gate.js";

/** Resolves when the test says so, so a "still running" state can be observed. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("the same delivery never runs twice", () => {
  it("replays the stored result instead of re-executing", async () => {
    const gate = new TaskGate<string>();
    let calls = 0;
    const exec = async () => {
      calls += 1;
      return "output";
    };

    const first = await gate.run("t1:1", exec);
    const second = await gate.run("t1:1", exec);

    expect(calls).toBe(1);
    expect(first).toEqual({ status: "ran", result: "output" });
    expect(second).toEqual({ status: "replayed", result: "output" });
  });

  it("reports a duplicate that lands mid-flight without starting a second run", async () => {
    const gate = new TaskGate<string>();
    const block = deferred<string>();
    let calls = 0;

    const running = gate.run("t1:1", async () => {
      calls += 1;
      return block.promise;
    });
    // Let the first run reach its executor before the duplicate arrives.
    await Promise.resolve();
    const duplicate = await gate.run("t1:1", async () => {
      calls += 1;
      return "second";
    });

    expect(duplicate).toEqual({ status: "duplicate" });
    expect(calls).toBe(1);

    block.resolve("first");
    expect(await running).toEqual({ status: "ran", result: "first" });
  });

  it("does run a new attempt of the same task", async () => {
    // The distinction the key exists for: a repeated attempt is the plumbing
    // repeating itself, a new attempt is the Queen choosing to pay again.
    const gate = new TaskGate<string>();
    let calls = 0;
    const exec = async () => {
      calls += 1;
      return `run-${calls}`;
    };

    await gate.run("t1:1", exec);
    const retry = await gate.run("t1:2", exec);

    expect(calls).toBe(2);
    expect(retry).toEqual({ status: "ran", result: "run-2" });
  });

  it("forgets a result once it is older than the window", async () => {
    let now = 1_000;
    const gate = new TaskGate<string>({ recentTtlMs: 60_000, now: () => now });
    let calls = 0;
    const exec = async () => {
      calls += 1;
      return "output";
    };

    await gate.run("t1:1", exec);
    now += 61_000;
    await gate.run("t1:1", exec);

    expect(calls).toBe(2);
  });

  it("keeps the memo bounded so it cannot grow with traffic", async () => {
    const gate = new TaskGate<string>({ recentMax: 3 });
    for (let i = 0; i < 10; i++) await gate.run(`t${i}:1`, async () => `r${i}`);

    // The oldest are evicted, so an old key runs again rather than being replayed.
    let reran = false;
    await gate.run("t0:1", async () => {
      reran = true;
      return "again";
    });
    expect(reran).toBe(true);
  });
});

describe("the concurrency cap is explicit", () => {
  it("runs one task at a time by default", async () => {
    const gate = new TaskGate<string>();
    const first = deferred<string>();
    let secondStarted = false;

    const a = gate.run("a:1", () => first.promise);
    await Promise.resolve();
    const b = gate.run("b:1", async () => {
      secondStarted = true;
      return "b";
    });
    await Promise.resolve();

    expect(secondStarted).toBe(false);
    expect(gate.running).toBe(1);

    first.resolve("a");
    await a;
    await b;
    expect(secondStarted).toBe(true);
  });

  it("honors a raised cap", async () => {
    const gate = new TaskGate<string>({ maxConcurrent: 2 });
    const hold = deferred<string>();
    const a = gate.run("a:1", () => hold.promise);
    const b = gate.run("b:1", () => hold.promise);
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.running).toBe(2);
    hold.resolve("done");
    await Promise.all([a, b]);
  });

  it("treats a nonsense cap as one rather than accepting work it can never start", async () => {
    const gate = new TaskGate<string>({ maxConcurrent: 0 });
    await expect(gate.run("a:1", async () => "ok")).resolves.toEqual({ status: "ran", result: "ok" });
  });
});

describe("lifecycle hooks", () => {
  it("reports queued, then started, then settled", async () => {
    // The worker hangs its progress ticker on these: it must tick from the moment
    // the task is HELD, not from the moment it starts running, or a task waiting
    // behind the cap looks lost to the Queen.
    const gate = new TaskGate<string>();
    const seen: string[] = [];
    await gate.run("a:1", async () => "ok", {
      onQueued: () => seen.push("queued"),
      onStart: () => seen.push("start"),
      onSettle: () => seen.push("settle"),
    });
    expect(seen).toEqual(["queued", "start", "settle"]);
  });

  it("settles even when the work throws", async () => {
    const gate = new TaskGate<string>();
    const seen: string[] = [];
    await expect(
      gate.run("a:1", async () => {
        throw new Error("boom");
      }, { onSettle: () => seen.push("settle") }),
    ).rejects.toThrow("boom");
    expect(seen).toEqual(["settle"]);
  });
});
