import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UsageBucket } from "./protocol.js";

const HOUR_MS = 3_600_000;
/** How long the box keeps buckets to resend after a reconnect. The cloud keeps them for good. */
const RETENTION_MS = 72 * HOUR_MS;

export function hourStart(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/** Billing that costs nothing per call, which is what "local share" counts. */
export function isLocalBilling(billing: string | undefined): boolean {
  return billing === "local" || billing === "free";
}

/** One finished task or chat turn, as the rollup needs it. */
export interface RollupEntry {
  /** the member's id, or "org" for work no member asked for */
  memberKey: string;
  departmentId?: string;
  at: number;
  ok: boolean;
  chat: boolean;
  tier?: number;
  billing?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  counterfactualUsd: number;
  durationMs: number;
}

/**
 * Per member, per UTC hour: what their agent did and what it cost.
 *
 * Buckets hold absolute totals, so the cloud overwrites instead of adding, and a
 * bucket resent after a reconnect cannot be counted twice. Kept on the box for
 * three days, which comfortably outlasts any outage a reconnect has to repair;
 * the cloud is where history lives.
 */
export class UsageRollups {
  private readonly buckets = new Map<string, UsageBucket>();

  constructor(private readonly persistPath?: string) {
    if (persistPath && existsSync(persistPath)) {
      try {
        const saved = JSON.parse(readFileSync(persistPath, "utf8")) as UsageBucket[];
        for (const b of saved) this.buckets.set(keyOf(b.memberKey, b.bucketStart), b);
      } catch {
        // A rollup file is a cache of what the cloud already has. Starting
        // empty costs a few resends, never a wrong number.
      }
    }
  }

  /** Fold one entry in, returning the bucket it landed in (to send). */
  add(e: RollupEntry): UsageBucket {
    const bucketStart = hourStart(e.at);
    const key = keyOf(e.memberKey, bucketStart);
    const b: UsageBucket = this.buckets.get(key) ?? {
      memberKey: e.memberKey,
      departmentId: e.departmentId,
      bucketStart,
      tasks: 0,
      tasksOk: 0,
      tasksFailed: 0,
      chatTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      localTokens: 0,
      cloudTokens: 0,
      costUsd: 0,
      counterfactualUsd: 0,
      durationMs: 0,
      tierMix: {},
    };
    if (e.chat) b.chatTurns += 1;
    else {
      b.tasks += 1;
      if (e.ok) b.tasksOk += 1;
      else b.tasksFailed += 1;
    }
    const tokens = e.inputTokens + e.outputTokens;
    b.inputTokens += e.inputTokens;
    b.outputTokens += e.outputTokens;
    if (isLocalBilling(e.billing)) b.localTokens += tokens;
    else b.cloudTokens += tokens;
    b.costUsd = round6(b.costUsd + e.costUsd);
    b.counterfactualUsd = round6(b.counterfactualUsd + e.counterfactualUsd);
    b.durationMs += e.durationMs;
    if (e.tier !== undefined) b.tierMix[String(e.tier)] = (b.tierMix[String(e.tier)] ?? 0) + 1;
    this.buckets.set(key, b);
    this.prune(e.at);
    this.save();
    return b;
  }

  /** Every bucket still held, oldest first: what a reconnect resends. */
  all(): UsageBucket[] {
    return [...this.buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart);
  }

  private prune(now: number): void {
    for (const [k, b] of this.buckets) if (now - b.bucketStart > RETENTION_MS) this.buckets.delete(k);
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.all()));
      renameSync(tmp, this.persistPath);
    } catch {
      /* best-effort: see the constructor */
    }
  }
}

function keyOf(memberKey: string, bucketStart: number): string {
  return `${memberKey}|${bucketStart}`;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
