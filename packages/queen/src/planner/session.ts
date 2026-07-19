import { randomUUID } from "node:crypto";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationState {
  sessionId: string;
  customerId: string;
  messages: ChatMessage[];
  /** local planner task key -> hive taskId, for reconnect and display */
  taskKeys: Record<string, string>;
}

/** In-memory conversation store. PoC only; production swaps a durable store. */
export class SessionStore {
  private sessions = new Map<string, ConversationState>();

  getOrCreate(sessionId: string | undefined, customerId: string): ConversationState {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) return existing;
    }
    const id = sessionId ?? randomUUID().slice(0, 8);
    const state: ConversationState = { sessionId: id, customerId, messages: [], taskKeys: {} };
    this.sessions.set(id, state);
    return state;
  }

  get(sessionId: string): ConversationState | undefined {
    return this.sessions.get(sessionId);
  }
}
