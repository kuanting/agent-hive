import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What one task's execution can be told and can tell back, without every
 * adapter method growing two more parameters.
 *
 * Cancellation has to reach the innermost `fetch` or `execFile` of whichever
 * backend is running, and those sit three or four calls deep (api-model's
 * provider helpers, the personal adapter's fallback chain). Threading a signal
 * through each signature would touch every one of them and still miss the next
 * helper someone adds. A per-task context reaches all of them by construction:
 * the worker runs the adapter inside `runWithExecContext`, and each call site
 * asks for `execSignal` instead of building its own timeout.
 */
export interface ExecContext {
  /** aborted when the Queen cancels the task */
  signal?: AbortSignal;
  /** a label for what the runtime is doing now; never content (see TaskProgress.phase) */
  onStep?: (phase: string, step?: { n: number; of?: number }) => void;
}

const store = new AsyncLocalStorage<ExecContext>();

export function runWithExecContext<T>(ctx: ExecContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

/**
 * The signal a long call should honour: its own timeout, plus the task's
 * cancellation when there is one. Outside a task (tests, probes) it is just the
 * timeout, which is exactly what every call site used before.
 */
export function execSignal(timeoutMs: number): AbortSignal {
  const cancel = store.getStore()?.signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return cancel ? AbortSignal.any([timeout, cancel]) : timeout;
}

/** The task's cancellation alone, for `execFile`, which already has its own `timeout` option. */
export function cancelSignal(): AbortSignal | undefined {
  return store.getStore()?.signal;
}

/** Tell whoever is watching what the runtime is doing. Best-effort, and a no-op outside a task. */
export function reportStep(phase: string, step?: { n: number; of?: number }): void {
  try {
    store.getStore()?.onStep?.(phase, step);
  } catch {
    /* reporting must never break the work */
  }
}
