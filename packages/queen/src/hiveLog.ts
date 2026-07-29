import { atLeast, type LogLevel } from "@hive/shared";

/**
 * One line in the hive's merged narration: the Queen's own routing decisions and
 * every bee's, in the order the Queen saw them.
 *
 * `seq` is monotonic within a Queen process. A browser reconnecting to /events
 * gets the buffer replayed, and seq is how it drops the lines it already has
 * without comparing text. It resets on restart, which is correct — a restarted
 * Queen has a different history, and pretending otherwise would silently merge
 * two runs into one feed.
 */
export interface HiveLogEntry {
  seq: number;
  at: number;
  level: LogLevel;
  /** "queen", or the agentId of the bee that said it */
  source: string;
  text: string;
  taskId?: string;
}

const DEFAULT_CAP = 500;

/**
 * A bounded ring of recent log lines, plus a fan-out to live listeners.
 *
 * Deliberately not a logging library. The repo has none, on purpose — 91 call
 * sites of `console.log` with a bracketed prefix is the whole convention, and
 * adding winston to gain a feed would be a large dependency serving one screen.
 * What the console actually needs is two things this provides in sixty lines:
 * the last N lines for a tab that was just opened, and every line after that.
 *
 * Bounded is the load-bearing word. This is the one structure in the Queen that
 * grows with time rather than with work, so it is the one that must not grow at
 * all. `tasks`, `cache` and the session store are already unbounded (see the
 * roadmap in docs/DESIGN.md §9); a debug feed retaining every line of a
 * long-running hive would be the first to actually hurt.
 */
export class HiveLog {
  private readonly entries: HiveLogEntry[] = [];
  private readonly listeners = new Set<(e: HiveLogEntry) => void>();
  private seq = 0;

  constructor(private readonly cap: number = Number(process.env.HIVE_LOG_BUFFER ?? DEFAULT_CAP)) {
    if (!Number.isFinite(this.cap) || this.cap < 1) this.cap = DEFAULT_CAP;
  }

  push(entry: Omit<HiveLogEntry, "seq">): HiveLogEntry {
    const full: HiveLogEntry = { ...entry, seq: ++this.seq };
    this.entries.push(full);
    while (this.entries.length > this.cap) this.entries.shift();
    // A listener that throws must not take down the consumer that pushed. The
    // publisher here is a bus handler; an exception would dead-letter a real
    // message over a broken SSE socket.
    for (const cb of this.listeners) {
      try {
        cb(full);
      } catch {
        /* a broken listener is its own problem */
      }
    }
    return full;
  }

  /** Buffered lines at or above `threshold`, oldest first. */
  recent(threshold: LogLevel = "debug"): HiveLogEntry[] {
    return this.entries.filter((e) => atLeast(e.level, threshold));
  }

  /** Returns an unsubscribe function; callers must invoke it when their stream closes. */
  subscribe(cb: (e: HiveLogEntry) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get size(): number {
    return this.entries.length;
  }
}
