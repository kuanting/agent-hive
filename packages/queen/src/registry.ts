import type { AgentHello, CapabilityRecord } from "@hive/shared";

export interface WorkerInfo {
  agentId: string;
  site: string;
  capabilities: CapabilityRecord[];
  lastSeen: number;
}

const STALE_MS = 60_000;

/** Live view of the hive: who is out there and what (agentType x model) pairs they offer. */
export class WorkerRegistry {
  private workers = new Map<string, WorkerInfo>();

  hello(msg: AgentHello): void {
    this.workers.set(msg.agentId, {
      agentId: msg.agentId,
      site: msg.site,
      capabilities: msg.capabilities,
      lastSeen: Date.now(),
    });
  }

  heartbeat(agentId: string): void {
    const w = this.workers.get(agentId);
    if (w) w.lastSeen = Date.now();
  }

  /** all capability records advertised by live workers */
  liveCapabilities(): CapabilityRecord[] {
    const now = Date.now();
    return [...this.workers.values()]
      .filter((w) => now - w.lastSeen < STALE_MS)
      .flatMap((w) => w.capabilities);
  }

  snapshot(): WorkerInfo[] {
    return [...this.workers.values()];
  }
}
