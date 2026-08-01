import { useEffect, useRef, useState } from "react";
import { fetchStatus, streamChat, subscribeEvents, type ChatEvent, type HiveLogEntry, type HiveStatus, type TurnPhase } from "./api.js";
import { Activity, fmtElapsed, useElapsed } from "./Activity.js";
import { KNOWN_COMMANDS, parseCommand, type Command } from "./commands.js";
import { agentLabel, describeCapability, isRuntimeFallback, TIER_LABEL } from "./labels.js";
import { Setup } from "./Setup.js";

interface Msg {
  role: "user" | "queen";
  content: string;
  note?: string;
}

interface Card {
  key: string;
  title: string;
  skills: string[];
  sensitivity: string;
  phase: "planned" | "submitted" | "running" | "done" | "failed";
  tier?: number;
  agent?: string;
  agentId?: string;
  runtime?: string;
  model?: string;
  costUsd?: number;
  degraded?: boolean;
  /** when this step was submitted, so the card can count up on its own between ticks */
  startedAt?: number;
  /** bee-reported while running, the result's durationMs once finished */
  elapsedMs?: number;
  taskId?: string;
}

/**
 * What each phase of the Queen's turn is called in the strip.
 *
 * Phrased as what she is doing, present tense, because the strip is read while it
 * is happening. `complete` is absent on purpose: the strip disappears when the
 * turn ends, and the answer below it is the better ending.
 */
/** `at` is when the browser saw the phase event, so the strip can keep counting between them. */
interface Turn {
  name: TurnPhase;
  elapsedMs: number;
  detail?: string;
  at: number;
}

const PHASE_LABEL: Record<TurnPhase, string> = {
  recalling: "checking what I remember",
  planning: "planning",
  decided: "decided",
  dispatching: "handing work to the hive",
  waiting: "waiting on the bees",
  synthesizing: "writing the answer",
  learning: "noting what to remember",
  complete: "done",
};

export function App() {
  const [messages, setMessages] = useState<Msg[]>([
    { role: "queen", content: "I am the Queen. Tell me what you need and I will put the hive to work." },
  ]);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [status, setStatus] = useState<HiveStatus>();
  // Home is what the hive promises; Setup is what the machines could do;
  // Activity is what they are doing right now.
  const [view, setView] = useState<"home" | "setup" | "activity">("home");
  // The live strip for the turn in progress. Cleared when the turn ends, because
  // a finished turn's timings belong in the trace lines, not in a "doing this now".
  const [turn, setTurn] = useState<Turn>();
  // Per-task log lines, so expanding a card shows that step's own narration
  // instead of making you go find it in the Activity feed.
  const [taskLog, setTaskLog] = useState<Record<string, HiveLogEntry[]>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tick = () => fetchStatus().then(setStatus).catch(() => {});
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);

  // Home subscribes at `info` and keeps only the task-scoped lines. Activity has
  // its own subscription with its own level, so the two never fight over one.
  useEffect(
    () =>
      subscribeEvents("info", (entry) => {
        if (!entry.taskId) return;
        setTaskLog((prev) => {
          const key = entry.taskId!;
          const existing = prev[key] ?? [];
          if (existing.some((e) => e.seq === entry.seq)) return prev;
          return { ...prev, [key]: [...existing, entry].slice(-20) };
        });
      }),
    [],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, cards]);

  function upsertCard(key: string, patch: Partial<Card>) {
    setCards((prev) => ({ ...prev, [key]: { ...prev[key], key, ...patch } as Card }));
  }

  /** Answers a console command. See commands.ts for why none of these reach the planner. */
  function runCommand(cmd: Extract<Command, { kind: "moved" | "unknown" }>): void {
    const note =
      cmd.kind === "moved"
        ? `/${cmd.name} is not available from the console — use ${cmd.use}`
        : `unknown command /${cmd.name}` +
          (KNOWN_COMMANDS.length ? ` — known: ${KNOWN_COMMANDS.map((c) => `/${c}`).join(", ")}` : "");
    setMessages((m) => [...m, { role: "queen", content: "", note }]);
  }

  async function send() {
    const message = input.trim();
    if (!message || sending) return;
    setInput("");

    const cmd = parseCommand(message);
    if (cmd.kind !== "chat") {
      setMessages((m) => [...m, { role: "user", content: message }]);
      runCommand(cmd);
      return;
    }

    setSending(true);
    setCards({});
    setTurn(undefined);
    setMessages((m) => [...m, { role: "user", content: message }]);

    try {
      await streamChat({ message, sessionId, customerId: "aiotlab" }, (ev: ChatEvent) => {
        switch (ev.type) {
          case "session":
            setSessionId(ev.sessionId);
            break;
          case "phase":
            // Updates in place rather than appending. A line per phase would be
            // eight lines of scrollback per turn for something only interesting
            // while it is true.
            setTurn(
              ev.name === "complete" ? undefined : { name: ev.name, elapsedMs: ev.elapsedMs, detail: ev.detail, at: Date.now() },
            );
            break;
          case "planner":
            setMessages((m) => [...m, { role: "queen", content: "", note: `planner: ${ev.model} (tier ${ev.tier}), decided to ${ev.decision}, $${ev.costUsd.toFixed(4)}` }]);
            break;
          case "clarify":
            setMessages((m) => [...m, { role: "queen", content: ev.question, note: "needs clarification" }]);
            break;
          case "plan":
            setCards(Object.fromEntries(ev.tasks.map((t) => [t.key, { ...t, phase: "planned" } as Card])));
            break;
          case "task":
            upsertCard(ev.key, {
              phase: ev.phase,
              taskId: ev.taskId,
              tier: ev.tier,
              agent: ev.agent,
              agentId: ev.agentId,
              runtime: ev.runtime,
              model: ev.model,
              costUsd: ev.costUsd,
              degraded: ev.degraded,
              elapsedMs: ev.elapsedMs,
              // Stamped once, on submission, so the card can count up locally
              // between the bee's five-second ticks.
              ...(ev.phase === "submitted" ? { startedAt: Date.now() } : {}),
            });
            break;
          case "recall":
            setMessages((m) => [
              ...m,
              { role: "queen", content: "", note: `recalled ${ev.memories.length} note(s), ${ev.chars} chars: ${ev.memories.map((x) => x.name).join(" | ")}` },
            ]);
            break;
          case "learned":
            setMessages((m) => [
              ...m,
              { role: "queen", content: "", note: `learned: ${ev.memories.map((x) => `${x.isNew ? "new" : `x${x.observed}`} ${x.retired ? "retired " : ""}${x.type} — ${x.name}`).join(" | ")}` },
            ]);
            break;
          case "answer":
            setMessages((m) => [...m, { role: "queen", content: ev.text }]);
            break;
          case "error":
            setMessages((m) => [...m, { role: "queen", content: `Error: ${ev.message}`, note: "error" }]);
            break;
        }
      });
    } catch (err) {
      setMessages((m) => [...m, { role: "queen", content: `Connection failed: ${String(err)}`, note: "error" }]);
    } finally {
      setSending(false);
      setTurn(undefined);
    }
  }

  // Ambiguity is judged across the whole hive, not per worker: two bees each
  // running one `opencode` are indistinguishable to the person reading this.
  const allCaps = (status?.workers ?? []).flatMap((w) => w.capabilities);
  // A count on the tab, so work happening elsewhere in the hive is discoverable
  // without having to already be looking at it.
  const inFlight = (status?.tasks ?? []).filter((t) => t.status === "dispatched" || t.status === "deferred").length;

  return (
    <div className="app">
      <header>
        <h1>Agent Hive</h1>
        <span className="tag">conversational Queen</span>
        <nav className="tabs">
          <button className={view === "home" ? "tab active" : "tab"} onClick={() => setView("home")}>
            Home
          </button>
          <button className={view === "setup" ? "tab active" : "tab"} onClick={() => setView("setup")}>
            Setup
          </button>
          <button className={view === "activity" ? "tab active" : "tab"} onClick={() => setView("activity")}>
            Activity
            {inFlight > 0 && <span className="tab-badge">{inFlight}</span>}
          </button>
        </nav>
        {sessionId && <span className="session">session {sessionId}</span>}
      </header>

      {view === "setup" && <Setup status={status} />}
      {view === "activity" && <Activity status={status} />}
      <div className="body" hidden={view !== "home"}>
        <section className="chat">
          <div className="messages" ref={scrollRef}>
            {messages.map((m, i) =>
              m.content === "" && m.note ? (
                <div key={i} className="trace">{m.note}</div>
              ) : (
                <div key={i} className={`msg ${m.role}`}>
                  {m.note && <div className="note">{m.note}</div>}
                  <div className="bubble">{m.content}</div>
                </div>
              ),
            )}
            {Object.keys(cards).length > 0 && (
              <div className="cards">
                {Object.values(cards).map((c) => (
                  <TaskCard key={c.key} c={c} workers={status?.workers} log={c.taskId ? taskLog[c.taskId] : undefined} />
                ))}
              </div>
            )}
            {turn && <TurnStrip turn={turn} />}
          </div>
          <div className="composer">
            <textarea
              value={input}
              placeholder="Ask the Queen. Try: look into last week's yield drop on line 3"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button onClick={() => void send()} disabled={sending}>
              {sending ? "working" : "send"}
            </button>
          </div>
        </section>

        <aside className="hive">
          <h2>Hive</h2>
          {status ? (
            <>
              <div className="panel">
                <h3>Budget</h3>
                {status.budget.customers.map((c) => (
                  <div key={c.customerId} className="row">
                    <span>{c.customerId}</span>
                    <span>${c.spentUsd.toFixed(2)} / ${c.capUsd}</span>
                  </div>
                ))}
                <div className="row planner">
                  <span>planner brain</span>
                  <span>${status.plannerCostUsd.toFixed(4)}</span>
                </div>
              </div>
              <div className="panel">
                <h3>Seats</h3>
                {status.budget.seats.map((s) => (
                  <div key={s.seatId} className="row">
                    <span>{s.seatId}</span>
                    <span>{Math.round((s.remaining / s.tokensPerWindow) * 100)}% quota</span>
                  </div>
                ))}
                {status.budget.seats.length === 0 && <div className="empty">no seats</div>}
              </div>
              <div className="panel">
                <h3>Workers</h3>
                {status.workers.map((w) => (
                  <div key={w.agentId} className="worker">
                    <div className="row">
                      <span>{w.agentId}</span>
                      <span>{w.site}</span>
                    </div>
                    <div className="caps">
                      {w.capabilities.map((cap, i) => (
                        <span key={i} className={`cap t${cap.tier}`} title={describeCapability(cap)}>
                          T{cap.tier} {agentLabel(cap, allCaps)}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                {status.workers.length === 0 && <div className="empty">no workers registered</div>}
              </div>
              <div className="panel">
                <h3>Memory</h3>
                {(status.memory ?? []).map((c) => (
                  <div key={c.customerId} className="worker">
                    <div className="row">
                      <span>{c.customerId}</span>
                      <span>guide {c.guideChars} ch</span>
                    </div>
                    {c.memories.map((m) => (
                      <div
                        key={m.id}
                        className={`row memory${m.retired ? " retired" : ""}`}
                        title={`${m.name}\n\nobserved ${m.observed} · helped ${m.helped} · misfired ${m.misfired}`}
                      >
                        <span className={`cap mem-${m.type}`}>{m.retired ? "retired" : m.type}</span>
                        <span className="mem-name">{m.name}</span>
                        <span className="mem-trust" title="how often this lesson actually changed the plan">
                          {Math.round(m.trust * 100)}%
                        </span>
                        <span>x{m.observed}</span>
                      </div>
                    ))}
                    {c.memories.length === 0 && <div className="empty">nothing learned yet</div>}
                  </div>
                ))}
                {(status.memory ?? []).length === 0 && <div className="empty">memory off</div>}
              </div>
            </>
          ) : (
            <div className="empty">Queen offline</div>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * Which bee ran this, by joining the result's agentId against the live roster.
 *
 * The old rule guessed from the runtime string — `personal`/`personal-mini`
 * meant the personal bee — which broke the moment that bee started serving
 * tasks through Hermes: `runtime` became "hermes" and the card claimed a local
 * bee. The owner is a fact the roster already knows, so ask it instead of
 * inferring it. Roster not loaded yet falls back to the tier label.
 */
function beeLabel(c: Card, workers: HiveStatus["workers"] | undefined): string {
  const tierLabel = c.tier ? (TIER_LABEL[c.tier] ?? `T${c.tier}`) : "";
  const owner = workers?.find((w) => w.agentId === c.agentId);
  const personal = owner?.capabilities.some((cap) => cap.runtime === "personal" && cap.tier === c.tier);
  return personal ? `🏡 T${c.tier} personal bee` : tierLabel;
}

/**
 * One line saying where this step is, in words rather than a state name.
 *
 * `submitted` is the state that used to sit there indefinitely looking like
 * nothing: the task is on a queue and no bee has claimed it yet. Saying that is
 * more useful than the word "submitted", because it points at the right thing to
 * check — whether a bee for that tier is even running.
 */
function statusLine(c: Card, workers?: HiveStatus["workers"]): string {
  switch (c.phase) {
    case "planned":
      return "queued behind an earlier step";
    case "submitted":
      return "on the queue, waiting for a bee to take it";
    case "running": {
      const who = beeLabel(c, workers) || "a bee";
      return `running on ${who}${c.model ? ` · ${c.model}` : ""}`;
    }
    case "done":
      return "done";
    case "failed":
      return "failed — the Queen may escalate and retry";
  }
}

function TaskCard({ c, workers, log }: { c: Card; workers?: HiveStatus["workers"]; log?: HiveLogEntry[] }) {
  const [open, setOpen] = useState(false);
  // agent is what the bee promised, runtime is what answered. A different
  // runtime is a substitution, and saying so is the whole reason both fields
  // travel — but `tool` answering as `tool:csv-report` is not one.
  const fellBack = isRuntimeFallback(c.agent, c.runtime);
  const live = c.phase === "submitted" || c.phase === "running";
  // Ticks arrive every few seconds; this fills the gaps so the number never looks
  // frozen. Once the task is done the bee's own durationMs is authoritative.
  const localElapsed = useElapsed(live ? c.startedAt : undefined);
  const elapsed = live ? Math.max(localElapsed, c.elapsedMs ?? 0) : c.elapsedMs;

  return (
    <div className={`card ${c.phase}`}>
      <div className="card-head">
        <span className="key">{c.key}</span>
        <span className="title">{c.title}</span>
        {typeof elapsed === "number" && <span className={live ? "elapsed live" : "elapsed"}>{fmtElapsed(elapsed)}</span>}
      </div>
      <div className="card-meta">
        <span className={`phase ${c.phase}`}>{c.phase}</span>
        {c.tier && <span className="tier">{beeLabel(c, workers)}</span>}
        {(c.agent || c.runtime) && (
          <span title={[c.agent && `configured: ${c.agent}`, c.runtime && `ran: ${c.runtime}`, c.model && `model: ${c.model}`].filter(Boolean).join(" · ")}>
            {c.agent ?? c.runtime}
          </span>
        )}
        {fellBack && <span className="fallback">{c.agent} → {c.runtime}</span>}
        {typeof c.costUsd === "number" && <span className="cost">${c.costUsd.toFixed(4)}</span>}
        {c.degraded && <span className="degraded">degraded</span>}
        {c.sensitivity === "confidential" && <span className="conf">confidential</span>}
      </div>
      <div className="card-status">{statusLine(c, workers)}</div>
      {log && log.length > 0 && (
        <>
          <button className="card-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? "hide" : "show"} {log.length} log line{log.length === 1 ? "" : "s"}
          </button>
          {open && (
            <div className="card-log">
              {log.map((e) => (
                <div key={e.seq} className={`feed-row ${e.level}`}>
                  <span className="feed-source">{e.source === "queen" ? "👑 queen" : e.source}</span>
                  <span className="feed-text">{e.text}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The Queen's turn, live and in one line.
 *
 * Deliberately one line that changes rather than a growing list: what someone
 * waiting wants to know is which part is taking the time, and that is a single
 * fact at any moment. The elapsed counter is the turn's, not the phase's, so it
 * answers "has this been going long" without arithmetic.
 */
function TurnStrip({ turn }: { turn: Turn }) {
  // Phase events fire at boundaries, and `planning` is the long one — a counter
  // that only moved when a phase changed would freeze exactly where someone is
  // most likely to be watching it. So carry the server's elapsed forward locally.
  const sinceEvent = useElapsed(turn.at);
  return (
    <div className="turn-strip">
      <span className="turn-dot" />
      <span className="turn-name">{PHASE_LABEL[turn.name]}</span>
      {turn.detail && <span className="turn-detail">{turn.detail}</span>}
      <span className="turn-elapsed">{fmtElapsed(turn.elapsedMs + sinceEvent)}</span>
    </div>
  );
}
