import { useEffect, useMemo, useRef, useState } from "react";
import { subscribeEvents, LOG_LEVELS, type HiveLogEntry, type HiveStatus, type LogLevel } from "./api.js";
import { TIER_LABEL } from "./labels.js";

/**
 * What the hive is doing right now — the browser twin of `npm run watch`.
 *
 * Home answers "what did the Queen do with my request". This answers "what is the
 * machinery doing", which is a different question with a different appetite for
 * noise. Keeping them apart is the whole point: a feed that streams every bee's
 * narration would bury the Queen's answer if it lived in the chat, and four bees
 * today is the small case. Here it costs nothing, because you only look when you
 * are asking.
 *
 * Two sources, deliberately, the same pairing watch.ts uses: /status is the
 * Queen's own view of task state (polled by App and passed down), and /events is
 * the narration as it happens (streamed). Seeing both makes it obvious the
 * console isn't inventing anything.
 */

/** Bounded for the same reason the server's buffer is: this is the one list that grows with time rather than with work. */
const MAX_ROWS = 300;

export function Activity({ status }: { status?: HiveStatus }) {
  const [level, setLevel] = useState<LogLevel>("info");
  const [source, setSource] = useState("all");
  const [paused, setPaused] = useState(false);
  const [entries, setEntries] = useState<HiveLogEntry[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  // Pause must freeze the view, not the subscription — dropping the stream would
  // mean resuming into a gap, and a gap in a debug feed is worse than a wall.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    // Re-subscribing on level change lets the server replay its buffer at the new
    // threshold, so widening to `debug` shows the recent past too, not just the future.
    setEntries([]);
    return subscribeEvents(level, (entry) => {
      if (pausedRef.current) return;
      setEntries((prev) => {
        // The server replays its ring on connect, so a reconnect re-sends lines we
        // already have. seq is monotonic per Queen process; dedupe on it.
        if (prev.some((e) => e.seq === entry.seq)) return prev;
        const next = [...prev, entry];
        return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
      });
    });
  }, [level]);

  useEffect(() => {
    if (!paused) feedRef.current?.scrollTo(0, feedRef.current.scrollHeight);
  }, [entries, paused]);

  const sources = useMemo(
    () => ["all", "queen", ...(status?.workers ?? []).map((w) => w.agentId)],
    [status?.workers],
  );
  const shown = source === "all" ? entries : entries.filter((e) => e.source === source);

  const active = (status?.tasks ?? []).filter((t) => t.status === "dispatched" || t.status === "deferred");

  return (
    <div className="activity">
      <section>
        <h2>
          In flight <span className="muted">{active.length === 0 ? "· idle" : `· ${active.length}`}</span>
        </h2>
        {active.length === 0 ? (
          <div className="empty">Nothing running. The hive is waiting for work.</div>
        ) : (
          active.map((t) => <InFlight key={t.taskId} task={t} />)
        )}
      </section>

      <section className="feed-section">
        <h2>
          Wire <span className="muted">· hive.tasks / hive.control / hive.telemetry</span>
        </h2>
        <div className="feed-controls">
          <label>
            level{" "}
            <select value={level} onChange={(e) => setLevel(e.target.value as LogLevel)}>
              {LOG_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            from{" "}
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button className={paused ? "toggle on" : "toggle"} onClick={() => setPaused((p) => !p)}>
            {paused ? "resume" : "pause"}
          </button>
          <button className="toggle" onClick={() => setEntries([])}>
            clear
          </button>
          <span className="muted">
            {shown.length} line{shown.length === 1 ? "" : "s"}
            {paused && " · paused, new lines dropped"}
          </span>
        </div>
        <div className="feed" ref={feedRef}>
          {shown.length === 0 ? (
            <div className="empty">
              Nothing at this level yet. Ask the Queen something on Home, or widen the level to debug.
            </div>
          ) : (
            shown.map((e) => <FeedRow key={e.seq} entry={e} />)
          )}
        </div>
      </section>
    </div>
  );
}

function InFlight({ task }: { task: NonNullable<HiveStatus["tasks"]>[number] }) {
  const elapsed = useElapsed(task.startedAt);
  const bee = task.runningOn ?? (task.tierUsed ? { tier: task.tierUsed } : undefined);
  // Deferred is the state that looks like nothing happening. Its `reason` is the
  // Queen's own explanation ("quota window on X empty, waiting 300s for reset"),
  // and surfacing it is most of why this section exists.
  return (
    <div className={`inflight ${task.status}`}>
      <div className="inflight-head">
        <span className="key">{task.taskId}</span>
        <span className="title">{task.spec.title}</span>
        <span className="elapsed">{fmtElapsed(elapsed)}</span>
      </div>
      <div className="inflight-meta">
        <span className={`phase ${task.status}`}>{task.status}</span>
        {bee?.tier && <span className="tier">{TIER_LABEL[bee.tier] ?? `T${bee.tier}`}</span>}
        {task.runningOn && (
          <span title={`ran by ${task.runningOn.agentId}`}>
            {task.runningOn.agent ?? task.runningOn.runtime}
            {task.runningOn.model ? `/${task.runningOn.model}` : ""}
          </span>
        )}
        {task.attempts > 1 && <span className="retry">attempt {task.attempts}</span>}
        <span className="reason">{task.reason}</span>
      </div>
    </div>
  );
}

function FeedRow({ entry }: { entry: HiveLogEntry }) {
  return (
    <div className={`feed-row ${entry.level}`}>
      <span className="feed-time">{new Date(entry.at).toLocaleTimeString()}</span>
      <span className="feed-source">{entry.source === "queen" ? "👑 queen" : entry.source}</span>
      <span className="feed-text">{entry.text}</span>
    </div>
  );
}

/** Live milliseconds since `since`, ticking once a second. Exported so the task cards on Home count the same way. */
export function useElapsed(since?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since ? now - since : 0;
}

export function fmtElapsed(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
