import { describe, expect, it } from "vitest";
import { Passthrough, TaskSpec, type TaskResult } from "@hive/shared";
import { InMemoryJobStore, type TaskState } from "../src/store.js";
import { ResultCache } from "../src/resultCache.js";
import { SessionStore, windowMessages, type ChatMessage } from "../src/planner/session.js";

/**
 * The Queen used to hold every task it had ever seen, forever, in two maps on the
 * core. These cover the three things that made that a problem: nothing was ever
 * dropped, the result cache ignored the one field that decides where work may
 * run, and the whole conversation was replayed to the planner every turn.
 */

const RETENTION_MS = 30 * 60_000;

function state(over: Partial<TaskState> = {}): TaskState {
  return {
    taskId: over.taskId ?? "t1",
    spec: TaskSpec.parse({ customerId: "aiotlab", title: "t", input: "do a thing" }),
    difficulty: "standard",
    status: "dispatched",
    attempts: 1,
    deferrals: 0,
    reason: "",
    startedAt: Date.now(),
    ...over,
  };
}

function resultFor(taskId: string, over: Partial<TaskResult> = {}): TaskResult {
  return {
    kind: "task.result",
    taskId,
    attempt: 1,
    agentId: "honey-bee-1",
    customerId: "aiotlab",
    ok: true,
    output: "done",
    tierUsed: 1,
    runtime: "claude-code",
    billing: "subscription",
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
    degraded: false,
    durationMs: 100,
    ...over,
  };
}

describe("the job store drops finished work and only finished work", () => {
  it("evicts a task past its retention window, and its cache key with it", () => {
    let clock = 1_000;
    const store = new InMemoryJobStore(RETENTION_MS, () => clock);
    store.put(state({ taskId: "old", status: "done" }));
    store.setCacheKey("old", "key-old");

    expect(store.evictOnce(clock)).toBe(0); // finished just now; still queryable
    expect(store.get("old")).toBeDefined();

    expect(store.evictOnce(clock + RETENTION_MS + 1)).toBe(1);
    expect(store.get("old")).toBeUndefined();
    // The key map was the second leak, and it leaked longer: nothing ever
    // deleted from it at all.
    expect(store.cacheKey("old")).toBeUndefined();
  });

  it("never evicts work that is still in flight, however old", () => {
    const store = new InMemoryJobStore();
    const ancient = Date.now() - 10 * RETENTION_MS;
    store.put(state({ taskId: "running", status: "dispatched", startedAt: ancient }));
    store.put(state({ taskId: "waiting", status: "deferred", startedAt: ancient }));

    // A long quota window can legitimately hold a task for hours. Evicting one
    // would look to the reaper exactly like a dispatch that never landed.
    expect(store.evictOnce(Date.now())).toBe(0);
    expect(store.get("running")).toBeDefined();
    expect(store.get("waiting")).toBeDefined();
  });

  it("clears the retention clock when a finished task goes back to work", () => {
    const store = new InMemoryJobStore();
    const s = state({ taskId: "retried", status: "failed" });
    store.put(s);
    expect(s.finishedAt).toBeDefined();

    // The reaper redispatching a stalled task: it is not finished any more, so it
    // must not be evicted mid-flight on a clock set by its previous ending.
    s.status = "dispatched";
    store.put(s);
    expect(s.finishedAt).toBeUndefined();
    expect(store.evictOnce(Date.now() + 10 * RETENTION_MS)).toBe(0);
  });

  it("reports only dispatched tasks to the reaper", () => {
    const store = new InMemoryJobStore();
    store.put(state({ taskId: "a", status: "dispatched" }));
    store.put(state({ taskId: "b", status: "deferred" }));
    store.put(state({ taskId: "c", status: "done" }));
    expect(store.dispatched().map((t) => t.taskId)).toEqual(["a"]);
    expect(store.list()).toHaveLength(3);
  });
});

describe("the result cache keys on what may run, not just on what was said", () => {
  it("does not serve a normal-sensitivity result to a confidential request", () => {
    // The bug this is a fence around: the key omitted sensitivity, so a
    // confidential submission worded identically to an earlier normal one was
    // answered out of a cache filled by a task that made no such promise.
    const normal = TaskSpec.parse({ customerId: "aiotlab", title: "Summarize", input: "the run log" });
    const confidential = TaskSpec.parse({
      customerId: "aiotlab",
      title: "Summarize",
      input: "the run log",
      sensitivity: "confidential",
    });

    const cache = new ResultCache();
    cache.put(ResultCache.key(normal), resultFor("public-1"));

    expect(cache.get(ResultCache.key(normal))?.taskId).toBe("public-1");
    expect(cache.get(ResultCache.key(confidential))).toBeUndefined();
  });

  it("treats identically-worded follow-ups on different sessions as different questions", () => {
    const base = { customerId: "aiotlab", title: "And the second one?", input: "same words" };
    const a = TaskSpec.parse({ ...base, continues: "task-a" });
    const b = TaskSpec.parse({ ...base, continues: "task-b" });
    const cache = new ResultCache();
    cache.put(ResultCache.key(a), resultFor("from-a"));
    expect(cache.get(ResultCache.key(b))).toBeUndefined();
  });

  it("does not let a tool's answer serve a request tagged for a model", () => {
    // skills are half of the tier-4 match, so the same sentence tagged
    // `reporting` runs as a zero-token tool and tagged `writing` runs on a
    // model. Sharing one cache entry meant one of the two got the other's
    // answer, from a different tier and at a different price.
    const base = { customerId: "aiotlab", title: "Report on the rows", input: "the attached table" };
    const reporting = TaskSpec.parse({ ...base, skills: ["reporting"] });
    const writing = TaskSpec.parse({ ...base, skills: ["writing"] });

    const cache = new ResultCache();
    cache.put(ResultCache.key(reporting), resultFor("from-tool"));
    expect(cache.get(ResultCache.key(writing))).toBeUndefined();
  });

  it("treats two runs of one tool with different inputs as different questions", () => {
    // Same words, different hyperparameters. The words are what a person reads;
    // toolInput is what actually runs.
    const base = { customerId: "aiotlab", title: "Train the classifier", input: "on the usual split", skills: ["experiment"] };
    const lr01 = TaskSpec.parse({ ...base, toolInput: { script: "train.py", lr: 0.1 } });
    const lr001 = TaskSpec.parse({ ...base, toolInput: { script: "train.py", lr: 0.001 } });

    const cache = new ResultCache();
    cache.put(ResultCache.key(lr01), resultFor("run-lr01"));
    expect(cache.get(ResultCache.key(lr001))).toBeUndefined();
  });

  it("ignores the order tags and tool keys were written in", () => {
    // Nothing else in the hive treats tag order as meaningful, so the cache must
    // not either — otherwise a rephrased plan splits one entry into two.
    const base = { customerId: "aiotlab", title: "Train the classifier", input: "on the usual split" };
    const one = TaskSpec.parse({ ...base, skills: ["experiment", "reporting"], toolInput: { script: "t.py", lr: 0.1 } });
    const two = TaskSpec.parse({ ...base, skills: ["reporting", "experiment"], toolInput: { lr: 0.1, script: "t.py" } });

    const cache = new ResultCache();
    cache.put(ResultCache.key(one), resultFor("hit"));
    expect(cache.get(ResultCache.key(two))?.taskId).toBe("hit");
  });

  it("treats two turns of a caller's tool loop as different questions", () => {
    // For a passthrough request the spec barely describes the question: `input`
    // is only the last user turn. A tool loop appends an assistant `tool_calls`
    // turn and a `role: "tool"` turn and leaves that last user turn alone — so
    // without the transcript in the key, turn 2 hashed identically to turn 1 and
    // got turn 1's answer back, tool call and all, for the whole TTL.
    const spec = TaskSpec.parse({ customerId: "aiotlab", title: "chat hive/gemini", input: "read a.txt" });
    const tools = [{ type: "function" as const, function: { name: "read_file" } }];
    const call = { id: "c1", type: "function" as const, function: { name: "read_file", arguments: "{}" } };
    const turn1 = Passthrough.parse({ messages: [{ role: "user", content: "read a.txt" }], tools });
    const turn2 = Passthrough.parse({
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: "", tool_calls: [call] },
        { role: "tool", tool_call_id: "c1", content: "file contents" },
      ],
      tools,
    });

    const cache = new ResultCache();
    cache.put(ResultCache.key(spec, undefined, turn1), resultFor("turn-1"));
    expect(cache.get(ResultCache.key(spec, undefined, turn1))?.taskId).toBe("turn-1");
    expect(cache.get(ResultCache.key(spec, undefined, turn2))).toBeUndefined();
  });

  it("keeps message order significant, since a transcript is not a set", () => {
    const spec = TaskSpec.parse({ customerId: "aiotlab", title: "chat", input: "b" });
    const forward = Passthrough.parse({
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
    });
    const reversed = Passthrough.parse({
      messages: [
        { role: "user", content: "b" },
        { role: "user", content: "a" },
      ],
    });
    const cache = new ResultCache();
    cache.put(ResultCache.key(spec, undefined, forward), resultFor("forward"));
    expect(cache.get(ResultCache.key(spec, undefined, reversed))).toBeUndefined();
  });

  it("still answers a genuinely identical request, which is the whole point", () => {
    const spec = TaskSpec.parse({ customerId: "aiotlab", title: "Summarize", input: "the run log" });
    const cache = new ResultCache();
    cache.put(ResultCache.key(spec), resultFor("hit-1"));
    const again = TaskSpec.parse({ customerId: "aiotlab", title: " summarize ", input: "the run log  " });
    expect(cache.get(ResultCache.key(again))?.taskId).toBe("hit-1");
  });

  it("expires by age and is capped by count", () => {
    let clock = 1_000;
    const cache = new ResultCache(60_000, 2, () => clock);
    cache.put("k1", resultFor("r1"));
    expect(cache.get("k1")?.taskId).toBe("r1");
    clock += 60_001;
    expect(cache.get("k1")).toBeUndefined();

    clock = 1_000;
    const capped = new ResultCache(60_000, 2, () => clock);
    capped.put("a", resultFor("ra"));
    capped.put("b", resultFor("rb"));
    capped.put("c", resultFor("rc"));
    expect(capped.size).toBe(2);
    expect(capped.get("a")).toBeUndefined(); // oldest went first
    expect(capped.get("c")?.taskId).toBe("rc");
  });

  it("never caches a failure", () => {
    const cache = new ResultCache();
    cache.put("k", resultFor("bad", { ok: false, error: "boom" }));
    expect(cache.get("k")).toBeUndefined();
  });
});

describe("conversations are bounded too", () => {
  it("evicts an idle conversation but never one being used", () => {
    let clock = 1_000;
    const store = new SessionStore(60_000, 100, () => clock);
    const idle = store.getOrCreate("idle", "aiotlab");
    const active = store.getOrCreate("active", "aiotlab");
    expect(idle.sessionId).toBe("idle");

    clock += 50_000;
    store.get("active"); // reading counts as using it
    clock += 20_000; // 'idle' is now 70s old, 'active' 20s

    expect(store.get("idle")).toBeUndefined();
    expect(store.get("active")).toBeDefined();
    expect(active.customerId).toBe("aiotlab");
  });

  it("caps the number of conversations, dropping least-recently-touched first", () => {
    const store = new SessionStore(60_000, 2, () => 1_000);
    store.getOrCreate("s1", "aiotlab");
    store.getOrCreate("s2", "aiotlab");
    store.get("s1"); // s1 is now the most recently touched
    store.getOrCreate("s3", "aiotlab");

    expect(store.size).toBe(2);
    expect(store.get("s2")).toBeUndefined();
    expect(store.get("s1")).toBeDefined();
    expect(store.get("s3")).toBeDefined();
  });
});

describe("only a window of the conversation reaches the planner model", () => {
  const turn = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });

  it("sends the whole thing when it fits", () => {
    const messages = [turn("user", "hello"), turn("assistant", "hi")];
    expect(windowMessages(messages, 1000)).toEqual(messages);
  });

  it("keeps the original intent and the most recent turns, dropping the middle", () => {
    const messages = [
      turn("user", "A".repeat(30)), // the original request
      turn("assistant", "B".repeat(30)),
      turn("user", "C".repeat(30)),
      turn("assistant", "D".repeat(30)),
      turn("user", "E".repeat(30)), // the request being answered
    ];
    const windowed = windowMessages(messages, 100);

    expect(windowed[0].content).toBe("A".repeat(30)); // intent survives
    expect(windowed[windowed.length - 1].content).toBe("E".repeat(30)); // so does the ask
    expect(windowed.length).toBeLessThan(messages.length);
    expect(windowed.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(100);
    // The middle is what goes, and it must go in order — a reordered transcript
    // would read as a different conversation.
    expect(windowed).toEqual(messages.filter((m) => windowed.includes(m)));
  });

  it("still sends the latest turn when it alone blows the budget", () => {
    const messages = [turn("user", "first"), turn("assistant", "ok"), turn("user", "X".repeat(500))];
    const windowed = windowMessages(messages, 100);
    // A plan made without the request being answered would be nonsense, so an
    // over-budget turn beats a missing one.
    expect(windowed[windowed.length - 1].content).toBe("X".repeat(500));
    expect(windowed[0].content).toBe("first");
  });

  it("grows sublinearly: turn 40 does not send forty turns", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) messages.push(turn(i % 2 === 0 ? "user" : "assistant", "x".repeat(200)));
    const windowed = windowMessages(messages, 6000);
    // The point of the whole exercise: cost per turn stops tracking how long the
    // conversation has been going.
    expect(windowed.length).toBeLessThanOrEqual(31);
    expect(windowed.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(6000);
  });
});
