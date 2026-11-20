import { ArtifactStore, type Passthrough, type TaskResult, type TaskSpec } from "@hive/shared";

/**
 * How long a cached result stays answerable, and how many are kept. Same shape
 * and same defaults as the worker's `TaskGate.recent` (worker/src/gate.ts): both
 * answer a repeated request from memory, so the two should not disagree about
 * how long "recent" is.
 */
const RESULT_TTL_MS = Number(process.env.HIVE_RESULT_CACHE_TTL_MS ?? 10 * 60_000);
const RESULT_MAX = Number(process.env.HIVE_RESULT_CACHE_MAX ?? 200);

/**
 * `JSON.stringify` with keys sorted at every level, so two structurally equal
 * payloads hash the same however they were built. Absent input is the empty
 * string rather than "undefined", which keeps the key of a task that has no
 * toolInput byte-identical to what it was before toolInput joined the key.
 */
function stableJson(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

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
   *
   * `skills` and `toolInput` are here because between them they decide *which
   * capability answers*, and a cache that ignores them serves one bee's answer
   * to a request that asked for another. `skills` is half of the tier-4 match
   * (analyzer.ts `matchTool` requires an overlap), so the same sentence tagged
   * `reporting` runs as a zero-token tool and tagged `writing` runs on a model —
   * two different answers at two different prices, previously sharing one entry.
   * `toolInput` is what a tool actually *does*: two training runs differing only
   * in their hyperparameters are the same words and emphatically not the same
   * question.
   */
  static key(
    spec: Pick<TaskSpec, "customerId" | "title" | "input" | "artifacts" | "sensitivity" | "continues" | "skills" | "toolInput">,
    /**
     * The capability the caller named, when they named one. In the key for the
     * same reason `sensitivity` is: it decides who may answer. Asking Gemini for
     * grounded search and asking the hive to choose are different requests even
     * when the words are identical, and serving one from the other's cache would
     * quietly undo the naming.
     */
    require?: { label: string },
    /**
     * The caller's own conversation, when they brought one.
     *
     * The most load-bearing entry in this key, because for a passthrough request
     * the spec barely describes the question: `title` is `chat <model>` and
     * `input` is only the *last user turn* (routes/openai.ts). A caller's tool
     * loop appends an assistant `tool_calls` turn and a `role: "tool"` turn and
     * leaves that last user turn exactly where it was — so turn 2 hashed
     * identically to turn 1 and was answered with turn 1's stored result, tool
     * call and all. The caller ran the tool, posted the result, and got the same
     * call back for the whole TTL: a loop that never reached a model.
     *
     * Messages are order-sensitive and `stableJson` sorts object keys but never
     * array elements, which is what makes a transcript hashable at all.
     */
    passthrough?: Passthrough,
    /**
     * Who is asking, when the intake knew.
     *
     * `customerId` above was the only identity in this key, which was right while
     * a customer was a lab whose members shared their work. It is wrong the
     * moment a customer is a team of separate people: two of them asking the same
     * question inside the TTL meant the second was handed the first's answer
     * *text*, verbatim, having never reached a bee. That is a disclosure, not a
     * caching nicety, and no TTL fixes it.
     *
     * `memberId` matters even more than `userId` for a company's hive: a
     * member's task reads that member's own files on their own desktop, so the
     * answer itself is theirs. One API key (the Hive Link) asks for every
     * employee, so `userId` alone would not tell them apart.
     *
     * What it costs is small. A passthrough transcript almost never collides
     * across people, and the structured-intake repeats this cache exists to serve
     * usually come from the same submitter anyway.
     */
    caller?: { userId?: string; memberId?: string },
  ): string {
    return ArtifactStore.hashInput(
      require?.label ?? "",
      caller?.memberId ? `member:${caller.memberId}` : "",
      spec.customerId,
      caller?.userId ?? "",
      spec.title.trim().toLowerCase(),
      spec.input.trim(),
      spec.sensitivity,
      spec.continues ?? "",
      // Sorted so that tag order — which nothing else in the hive treats as
      // meaningful — cannot split one cache entry into two.
      [...spec.skills].sort().join(","),
      stableJson(spec.toolInput),
      stableJson(passthrough),
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
