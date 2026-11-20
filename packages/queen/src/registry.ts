import type { AgentHello, CapabilityRecord, HostInventory } from "@hive/shared";

/** Whom a scoped bee works for; see AgentHello.owner. */
export interface WorkerOwner {
  memberId?: string;
  departmentId?: string;
}

export interface WorkerInfo {
  agentId: string;
  site: string;
  /** present on a scoped bee: it serves only this member or department */
  owner?: WorkerOwner;
  capabilities: CapabilityRecord[];
  /** whether this worker also binds the per-tier "general" fan-in queue */
  bindsGeneral: boolean;
  /** what this worker's machine could run; advisory, never routed on */
  host?: HostInventory;
  lastSeen: number;
}

const STALE_MS = 60_000;

/** One capability on one live bee, with the bee it belongs to. */
export interface LiveEntry {
  agentId: string;
  /** the very record the bee advertised, by reference; `decide` hands it back the same way */
  capability: CapabilityRecord;
  owner?: WorkerOwner;
}

/** A bee with an owner takes only its owner's work, and only from its direct queue. */
export function isScoped(owner: WorkerOwner | undefined): boolean {
  return !!(owner?.memberId || owner?.departmentId);
}

/** Live view of the hive: who is out there, which agents they offer, and what their hosts could run. */
export class WorkerRegistry {
  private workers = new Map<string, WorkerInfo>();
  private warnedOverlap = new Set<string>();

  /**
   * @returns true when this hello told us something we did not already know —
   * a new worker, or an existing one whose capabilities changed.
   *
   * Workers announce themselves five times on startup on purpose: a one-shot
   * hello can lose a race with the Queen's control consumer, and a missed hello
   * means the bee never registers at all. Idempotent and cheap on the wire — but
   * four bees booting produce twenty identical lines, which at the top of a live
   * feed is the whole screen. So the caller logs the ones that carry news and
   * drops the repeats to debug. What matters is "worker-bee-1 registered", once.
   */
  hello(msg: AgentHello): boolean {
    const previous = this.workers.get(msg.agentId);
    const news =
      !previous ||
      JSON.stringify(previous.capabilities) !== JSON.stringify(msg.capabilities) ||
      JSON.stringify(previous.owner ?? null) !== JSON.stringify(isScoped(msg.owner) ? msg.owner : null);
    this.workers.set(msg.agentId, {
      agentId: msg.agentId,
      site: msg.site,
      owner: isScoped(msg.owner) ? msg.owner : undefined,
      capabilities: msg.capabilities,
      bindsGeneral: msg.bindsGeneral ?? true,
      host: msg.host,
      lastSeen: Date.now(),
    });
    this.warnOnMqttOverlap(msg.agentId);
    return news;
  }

  /**
   * The embedded MQTT broker (Aedes) has no shared subscriptions, so it can't
   * load-balance a task across two workers that serve the same tier+skill — both
   * would run it (double token spend). Warn once per overlapping capability.
   *
   * Note this is keyed per tier+skill, not per worker: several workers coexist
   * happily on the embedded broker as long as their bindings don't overlap,
   * which is how the solo launcher runs four bees at once. The fix for a warning
   * is to make the capabilities disjoint, or move to the amqp backend.
   */
  private warnOnMqttOverlap(agentId: string): void {
    if (process.env.HIVE_BROKER !== "mqtt") return;
    const self = this.workers.get(agentId);
    if (!self) return;
    // A scoped bee binds only its direct queue, so it can never overlap anyone.
    const keysOf = (w: WorkerInfo): string[] =>
      isScoped(w.owner) ? [] : w.capabilities.flatMap((c) =>
        c.tier === 4 && c.toolId
          ? [`t4:${c.toolId}`]
          : [...c.skills, ...(w.bindsGeneral ? ["general"] : [])].map((s) => `t${c.tier}:${s}`),
      );
    const now = Date.now();
    const selfKeys = new Set(keysOf(self));
    for (const w of this.workers.values()) {
      if (w.agentId === agentId || now - w.lastSeen >= STALE_MS) continue;
      for (const k of new Set(keysOf(w))) {
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

  /**
   * Drop a worker that told us it is leaving.
   *
   * Distinct from letting it go stale: a bee that said goodbye is gone on
   * purpose and should stop appearing in the roster immediately, rather than
   * lingering for STALE_MS as a capability the Queen might still route to.
   * Silence is what STALE_MS is for; this is the case where we were told.
   */
  forget(agentId: string): void {
    this.workers.delete(agentId);
  }

  heartbeat(agentId: string): void {
    const w = this.workers.get(agentId);
    if (w) w.lastSeen = Date.now();
  }

  /**
   * Whether one named worker is still live. Same staleness rule as
   * liveCapabilities, in one place, so a caller that needs to ask about a
   * specific bee cannot drift from the rule the router uses.
   */
  isLive(agentId: string): boolean {
    const w = this.workers.get(agentId);
    return w !== undefined && Date.now() - w.lastSeen < STALE_MS;
  }

  /** the capability records one live worker advertises; empty if it is gone or stale */
  liveCapabilitiesOf(agentId: string): CapabilityRecord[] {
    return this.isLive(agentId) ? (this.workers.get(agentId)?.capabilities ?? []) : [];
  }

  /**
   * Capability records advertised by live SHARED workers: the pool ordinary hive
   * work is routed over.
   *
   * Scoped bees are left out, and that is the whole isolation story for work
   * with no member attached. `decide` prices against this list, so a scoped
   * bee's record here would let an anonymous task be priced against Amy's
   * desktop and then published to a tier queue her bee never binds, where it
   * would sit until the reaper gave up on it.
   */
  liveCapabilities(): CapabilityRecord[] {
    const now = Date.now();
    return [...this.workers.values()]
      .filter((w) => now - w.lastSeen < STALE_MS && !isScoped(w.owner))
      .flatMap((w) => w.capabilities);
  }

  /** Every live bee's records, scoped ones included, each tagged with its bee. For member routing. */
  liveEntries(): LiveEntry[] {
    const now = Date.now();
    return [...this.workers.values()]
      .filter((w) => now - w.lastSeen < STALE_MS)
      .flatMap((w) => w.capabilities.map((capability) => ({ agentId: w.agentId, capability, owner: w.owner })));
  }

  ownerOf(agentId: string): WorkerOwner | undefined {
    return this.workers.get(agentId)?.owner;
  }

  snapshot(): WorkerInfo[] {
    return [...this.workers.values()];
  }
}
