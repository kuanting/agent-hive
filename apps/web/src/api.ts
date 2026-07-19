export type ChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "planner"; model: string; tier: number; decision: string; costUsd: number }
  | { type: "clarify"; question: string }
  | { type: "plan"; rationale: string; tasks: Array<{ key: string; title: string; skills: string[]; sensitivity: string }> }
  | { type: "task"; key: string; taskId?: string; phase: "submitted" | "done" | "failed"; tier?: number; runtime?: string; model?: string; costUsd?: number; degraded?: boolean }
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

export interface HiveStatus {
  workers: Array<{ agentId: string; site: string; capabilities: Array<{ tier: number; runtime: string; model?: string; billing: string }> }>;
  budget: {
    customers: Array<{ customerId: string; capUsd: number; spentUsd: number }>;
    seats: Array<{ seatId: string; remaining: number; tokensPerWindow: number }>;
  };
  plannerCostUsd: number;
}

export async function fetchStatus(): Promise<HiveStatus> {
  const res = await fetch("/status");
  return res.json();
}
