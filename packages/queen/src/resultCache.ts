import { ArtifactStore, type TaskResult, type TaskSpec } from "@hive/shared";

/**
 * How long a cached result stays answerable, and how many are kept. Same shape
 * and same defaults as the worker's `TaskGate.recent` (worker/src/gate.ts): both
 * answer a repeated request from memory, so the two should not disagree about
 * how long "recent" is.
 */
const RESULT_TTL_MS = Number(process.env.HIVE_RESULT_CACHE_TTL_MS ?? 10 * 60_000);
const RESULT_MAX = Number(process.env.HIVE_RESULT_CACHE_MAX ?? 200);

/**
 * Level-1 token minimization: a repeated task never reaches a model at all.
 * Keyed on a stable hash of the normalized task input.
 */
export class ResultCache {
  private cache = new Map<string, { result: TaskResult; at: number }>();

  constructor(
    private readonly ttlMs = RESULT_TTL_MS,
    private readonly max = RESULT_MAX,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Everything that changes what the answer is allowed to be, not just what it
   * says.
   *
   * `sensitivity` is in the key because it decides where the work may run. It
   * used to be absent, which meant a result produced for a normal-sensitivity
   * submission was served verbatim to a later confidential one with the same
   * wording — the request that promised to stay on the machine answered out of a
   * cache filled by one that made no such promise. That is a confidentiality
   * hole, not a tuning miss, and no amount of TTL fixes it.
   *
   * `continues` is in the key for the ordinary reason: a follow-up's meaning
   * depends on the session it continues, so two identically-worded follow-ups on
   * different sessions are different questions.
   */
  static key(spec: Pick<TaskSpec, "customerId" | "title" | "input" | "artifacts" | "sensitivity" | "continues">): string {
    return ArtifactStore.hashInput(
      spec.customerId,
      spec.title.trim().toLowerCase(),
      spec.input.trim(),
      spec.sensitivity,
      spec.continues ?? "",
      ...spec.artifacts,
    );
  }

  get(key: string): TaskResult | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.result;
  }

  put(key: string, result: TaskResult): void {
    if (!result.ok) return;
    this.cache.set(key, { result, at: this.now() });
    // Bounded by age and by count, the same two ways TaskGate bounds its own
    // recent-results map: this grows with traffic rather than with the size of
    // the fleet, so it is the one that has to be capped.
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.cache) if (v.at < cutoff) this.cache.delete(k);
    while (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** for tests and diagnostics */
  get size(): number {
    return this.cache.size;
  }
}
