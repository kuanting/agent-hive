import { ArtifactStore, type TaskResult } from "@hive/shared";

/**
 * Level-1 token minimization: a repeated task never reaches a model at all.
 * Keyed on a stable hash of the normalized task input.
 */
export class ResultCache {
  private cache = new Map<string, TaskResult>();

  static key(customerId: string, title: string, input: string, artifacts: string[]): string {
    return ArtifactStore.hashInput(customerId, title.trim().toLowerCase(), input.trim(), ...artifacts);
  }

  get(key: string): TaskResult | undefined {
    return this.cache.get(key);
  }

  put(key: string, result: TaskResult): void {
    if (result.ok) this.cache.set(key, result);
  }
}
