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
  private warnedOverlap = new Set<string>();

  hello(msg: AgentHello): void {
    this.workers.set(msg.agentId, {
      agentId: msg.agentId,
      site: msg.site,
      capabilities: msg.capabilities,
      lastSeen: Date.now(),
    });
    this.warnOnMqttOverlap(msg.agentId);
  }

  /**
   * The embedded MQTT broker (Aedes) has no shared subscriptions, so it can't
   * load-balance a task across two workers that serve the same tier+skill — both
   * would run it (double token spend). Warn once per overlapping capability so the
   * operator knows to run one worker per capability, or switch to the amqp backend.
   */
  private warnOnMqttOverlap(agentId: string): void {
    if (process.env.HIVE_BROKER !== "mqtt") return;
    const self = this.workers.get(agentId);
    if (!self) return;
    const keysOf = (caps: CapabilityRecord[]): string[] =>
      caps.flatMap((c) =>
        c.tier === 4 && c.toolId
          ? [`t4:${c.toolId}`]
          : [...c.skills, "general"].map((s) => `t${c.tier}:${s}`),
      );
    const now = Date.now();
    const selfKeys = new Set(keysOf(self.capabilities));
    for (const w of this.workers.values()) {
      if (w.agentId === agentId || now - w.lastSeen >= STALE_MS) continue;
      for (const k of new Set(keysOf(w.capabilities))) {
        if (selfKeys.has(k) && !this.warnedOverlap.has(k)) {
          this.warnedOverlap.add(k);
          console.warn(
            `[registry] MQTT backend can't load-balance overlapping workers: '${agentId}' and ` +
              `'${w.agentId}' both serve ${k}, so both receive each such task (double spend). Run one ` +
              `worker per capability in solo/MQTT mode, or use the amqp backend for horizontal scale.`,
          );
        }
      }
    }
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
