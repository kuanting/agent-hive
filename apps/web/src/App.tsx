import { useEffect, useRef, useState } from "react";
import { fetchStatus, streamChat, type ChatEvent, type HiveStatus } from "./api.js";

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
  phase: "planned" | "submitted" | "done" | "failed";
  tier?: number;
  runtime?: string;
  model?: string;
  costUsd?: number;
  degraded?: boolean;
}

/**
 * Tier is composition, billing is cost — the bee names carry both, which is why
 * they read better on a card than "T2 oss+paid" did.
 *   honey   prepaid subscription seat, $0 marginal
 *   metered per-token API, the only one that spends
 *   local   on this machine, $0 and no egress
 *   worker  a plain tool, no LLM at all
 */
const TIER_LABEL: Record<number, string> = {
  1: "🍯 T1 honey bee",
  2: "💵 T2 metered bee",
  3: "🏠 T3 local bee",
  4: "🐝 T4 worker bee",
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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tick = () => fetchStatus().then(setStatus).catch(() => {});
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, cards]);

  function upsertCard(key: string, patch: Partial<Card>) {
    setCards((prev) => ({ ...prev, [key]: { ...prev[key], key, ...patch } as Card }));
  }

  async function send() {
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    setSending(true);
    setCards({});
    setMessages((m) => [...m, { role: "user", content: message }]);

    try {
      await streamChat({ message, sessionId, customerId: "aiotlab" }, (ev: ChatEvent) => {
        switch (ev.type) {
          case "session":
            setSessionId(ev.sessionId);
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
              tier: ev.tier,
              runtime: ev.runtime,
              model: ev.model,
              costUsd: ev.costUsd,
              degraded: ev.degraded,
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
    }
  }

  return (
    <div className="app">
      <header>
        <h1>Agent Hive</h1>
        <span className="tag">conversational Queen</span>
        {sessionId && <span className="session">session {sessionId}</span>}
      </header>

      <div className="body">
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
                  <TaskCard key={c.key} c={c} />
                ))}
              </div>
            )}
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
                        <span key={i} className={`cap t${cap.tier}`}>
                          T{cap.tier} {cap.runtime}
                          {cap.model ? `/${cap.model.split(":")[0]}` : ""}
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

function TaskCard({ c }: { c: Card }) {
  return (
    <div className={`card ${c.phase}`}>
      <div className="card-head">
        <span className="key">{c.key}</span>
        <span className="title">{c.title}</span>
      </div>
      <div className="card-meta">
        <span className={`phase ${c.phase}`}>{c.phase}</span>
        {c.tier && (
          <span className="tier">
            {c.runtime === "personal" || c.runtime === "personal-mini"
              ? "🏡 T3 personal bee"
              : (TIER_LABEL[c.tier] ?? `T${c.tier}`)}
          </span>
        )}
        {c.runtime && <span>{c.runtime}{c.model ? `/${c.model.split(":")[0]}` : ""}</span>}
        {typeof c.costUsd === "number" && <span className="cost">${c.costUsd.toFixed(4)}</span>}
        {c.degraded && <span className="degraded">degraded</span>}
        {c.sensitivity === "confidential" && <span className="conf">confidential</span>}
      </div>
    </div>
  );
}
