/**
 * The front door for a delivered task: dedup, then a concurrency cap.
 *
 * Both halves exist because the transport is at-most-once but not at-least-once,
 * and neither is exactly-once. A task can arrive twice — the Queen redispatching
 * something it thought was lost, a broker replaying, a bee being handed the same
 * message by two overlapping subscriptions — and every one of those deliveries
 * would otherwise be a fresh five-minute, real-money model call.
 *
 * Keyed on `(taskId, attempt)`, and the pair is the whole point. A duplicate
 * carrying the SAME attempt is the plumbing repeating itself and must never
 * re-run the work; a NEW attempt is the Queen deliberately choosing to pay for a
 * retry, and must. Dedup on taskId alone would swallow legitimate retries;
 * dedup on nothing is a bill.
 *
 * The concurrency cap is here rather than in the transport because it used to be
 * a side effect of it: the MQTT backend withheld its ack until the handler
 * finished, which serialized delivery and quietly meant "one at a time". That ack
 * now fires on receipt, so the limit has to be stated.
 */

export type GateOutcome<R> =
  /** we ran it; `result` is fresh */
  | { status: "ran"; result: R }
  /** an identical delivery is mid-flight; the in-flight one will answer */
  | { status: "duplicate" }
  /** we ran this exact delivery already; `result` is from memory */
  | { status: "replayed"; result: R };

export interface GateHooks {
  /** admitted and waiting on a slot */
  onQueued?(): void;
  /** a slot is free; work is starting */
  onStart?(): void;
  /** finished, one way or another */
  onSettle?(): void;
}

export interface GateOptions {
  maxConcurrent?: number;
  /** how long a finished result stays answerable from memory */
  recentTtlMs?: number;
  recentMax?: number;
  now?: () => number;
}

export class TaskGate<R> {
  private readonly inFlight = new Map<string, Promise<R>>();
  private readonly recent = new Map<string, { result: R; at: number }>();
  private readonly waiters: Array<() => void> = [];
  private readonly maxConcurrent: number;
  private readonly recentTtlMs: number;
  private readonly recentMax: number;
  private readonly now: () => number;
  private active = 0;

  constructor(opts: GateOptions = {}) {
    // Clamped to at least 1: a bee that accepts work and can never start it is
    // worse than a slow one, and a misconfigured 0 would look like a hang.
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 1);
    this.recentTtlMs = opts.recentTtlMs ?? 10 * 60_000;
    this.recentMax = opts.recentMax ?? 200;
    this.now = opts.now ?? (() => Date.now());
  }

  async run(key: string, exec: () => Promise<R>, hooks: GateHooks = {}): Promise<GateOutcome<R>> {
    const remembered = this.recall(key);
    if (remembered) return { status: "replayed", result: remembered };

    if (this.inFlight.has(key)) {
      // Deliberately does NOT await the in-flight run. The first delivery already
      // owns publishing the result; a second caller waiting on it would only
      // duplicate that announcement.
      return { status: "duplicate" };
    }

    const run = (async () => {
      hooks.onQueued?.();
      await this.acquire();
      try {
        hooks.onStart?.();
        return await exec();
      } finally {
        this.release();
        hooks.onSettle?.();
      }
    })();

    this.inFlight.set(key, run);
    try {
      const result = await run;
      this.remember(key, result);
      return { status: "ran", result };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private recall(key: string): R | undefined {
    const hit = this.recent.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.recentTtlMs) {
      this.recent.delete(key);
      return undefined;
    }
    return hit.result;
  }

  private remember(key: string, result: R): void {
    this.recent.set(key, { result, at: this.now() });
    // Bounded by age and by count. This is the one structure here that grows with
    // traffic rather than with the size of the fleet, so it is the one that has to
    // be capped.
    const cutoff = this.now() - this.recentTtlMs;
    for (const [k, v] of this.recent) if (v.at < cutoff) this.recent.delete(k);
    while (this.recent.size > this.recentMax) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  /** for tests and diagnostics */
  get running(): number {
    return this.active;
  }
}
