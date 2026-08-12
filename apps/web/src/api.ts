/** Mirrors TurnPhase in packages/queen/src/planner/index.ts. */
export type TurnPhase =
  | "recalling"
  | "planning"
  | "decided"
  | "dispatching"
  | "waiting"
  | "synthesizing"
  | "learning"
  | "complete";

export type TaskPhase = "submitted" | "running" | "done" | "failed";

export type ChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "phase"; name: TurnPhase; elapsedMs: number; detail?: string }
  | { type: "planner"; model: string; tier: number; decision: string; costUsd: number }
  | { type: "clarify"; question: string }
  | { type: "plan"; rationale: string; tasks: Array<{ key: string; title: string; skills: string[]; sensitivity: string }> }
  | { type: "task"; key: string; taskId?: string; phase: TaskPhase; tier?: number; agent?: string; agentId?: string; runtime?: string; model?: string; costUsd?: number; degraded?: boolean; elapsedMs?: number }
  | { type: "recall"; memories: Array<{ id: string; type: string; name: string }>; chars: number }
  | { type: "learned"; memories: Array<{ id: string; type: string; name: string; observed: number; isNew: boolean; trust: number; retired: boolean }>; costUsd: number }
  | { type: "answer"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Streams a chat turn over SSE (POST /chat), decoding data: frames. */
export async function streamChat(
  body: { message: string; sessionId?: string; customerId?: string },
  onEvent: (ev: ChatEvent) => void,
): Promise<void> {
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error("no response stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as ChatEvent);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/** Mirrors HiveLogEntry in packages/queen/src/hiveLog.ts. */
export interface HiveLogEntry {
  seq: number;
  at: number;
  level: LogLevel;
  /** "queen", or the agentId of the bee that said it */
  source: string;
  text: string;
  taskId?: string;
}

/**
 * The hive's live narration. A GET, so this gets the browser's own SSE client and
 * its reconnection for free — the Activity tab is meant to be left open across a
 * Queen restart. Every entry carries a monotonic `seq`; the server replays its
 * buffer on connect, so the caller must drop seqs it already holds.
 *
 * Returns a close function. EventSource retries forever on its own, which is what
 * we want while the tab is open and exactly what we must stop when it isn't.
 */
export function subscribeEvents(level: LogLevel, onEntry: (e: HiveLogEntry) => void): () => void {
  const es = new EventSource(`/events?level=${level}`);
  es.onmessage = (ev) => {
    try {
      onEntry(JSON.parse(ev.data) as HiveLogEntry);
    } catch {
      /* ignore malformed frame */
    }
  };
  // Errors are transient by design here (Queen restarting, dev server reloading);
  // EventSource reconnects itself, so there is nothing to do but not crash.
  es.onerror = () => {};
  return () => es.close();
}

export interface HiveTask {
  taskId: string;
  spec: { title: string; customerId: string; sensitivity: string; skills: string[] };
  difficulty: string;
  status: "dispatched" | "deferred" | "done" | "failed";
  attempts: number;
  reason: string;
  tierUsed?: number;
  startedAt: number;
  lastProgressAt?: number;
  runningOn?: { agentId: string; tier: number; agent?: string; runtime: string; model?: string };
}

export interface HiveStatus {
  workers: Array<{
    agentId: string;
    site: string;
    capabilities: Array<{ tier: number; agent?: string; runtime: string; model?: string; billing: string; toolId?: string }>;
    /**
     * What this worker's machine could run, as opposed to what it promises.
     * Absent from a worker that predates the field — which is a different
     * claim from "nothing installed", so Setup must not conflate them.
     */
    host?: {
      ollamaUrl: string;
      ollamaUp: boolean;
      models: Array<{ name: string; cloud: boolean; tools: boolean }>;
      runtimes: Array<{ name: string; present: boolean; detail?: string }>;
      drops: Array<{ label: string; reason: string }>;
      notes: Array<{ label: string; reason: string }>;
    };
  }>;
  budget: {
    customers: Array<{ customerId: string; capUsd: number; spentUsd: number }>;
    seats: Array<{ seatId: string; remaining: number; tokensPerWindow: number }>;
  };
  plannerCostUsd: number;
  /**
   * Every task the Queen has seen this process lifetime. Returned by /status all
   * along and simply never read here — demo/watch.ts has been rendering its
   * "IN FLIGHT" section from it since the beginning.
   */
  tasks: HiveTask[];
  /** contributed by the planner via QueenCore.registerStatusSection */
  memory?: Array<{
    customerId: string;
    guideChars: number;
    memories: Array<{
      id: string;
      type: string;
      name: string;
      observed: number;
      lastSeen: string;
      trust: number;
      helped: number;
      misfired: number;
      retired: boolean;
    }>;
  }>;
}

export async function fetchStatus(): Promise<HiveStatus> {
  const res = await fetch("/status");
  // A 401 body is not a HiveStatus, and parsing it as one used to leave the
  // panels rendering an object with no fields — a blank screen for a
  // configuration mistake with a one-line fix. The console carries no key of its
  // own; the dev-server proxy supplies it (see vite.config.ts), so naming the
  // variable is the whole diagnosis.
  if (res.status === 401) {
    throw new Error(
      "the Queen rejected the console's key. HIVE_API_KEYS is set, so the dev server needs " +
        "HIVE_CONSOLE_KEY in .env naming one of those keys, then restart `npm run console`.",
    );
  }
  if (!res.ok) throw new Error(`/status returned ${res.status}`);
  return res.json();
}

