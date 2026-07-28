import { z } from "zod";

/**
 * What a worker's machine COULD run, as opposed to what its bee promises.
 *
 * The two are deliberately different things. A capability is a promise the
 * operator made — "this bee runs Hermes on gemma4:12b" — and the Queen routes on
 * promises. This is the raw material behind them: which models Ollama has, which
 * agent binaries are on PATH, and which configured records were refused and why.
 * It exists so the console can answer "what do I still have to set up?" without
 * the hive inventing capabilities nobody asked for.
 *
 * Advisory in the strictest sense: nothing here is ever routed on. It rides the
 * hello because that message is already "who I am and what I offer", is already
 * re-published when things change, and is already stored and served by /status —
 * so this reaches the console with no second consumer and no second staleness
 * rule. There is no timestamp field: the registry already dates the record, and
 * a clock in the payload would make every tick differ and force a pointless
 * re-registration.
 */

export const HostModel = z.object({
  name: z.string(),
  /** an Ollama cloud tag: would be tier 2 on a plan seat, not tier 3 */
  cloud: z.boolean().default(false),
  /** advertises tool support — Hermes needs it, and gemma3 famously lacks it */
  tools: z.boolean().default(false),
});
export type HostModel = z.infer<typeof HostModel>;

export const HostRuntime = z.object({
  name: z.string(),
  present: z.boolean(),
  detail: z.string().optional(),
});
export type HostRuntime = z.infer<typeof HostRuntime>;

/** A configured capability that was refused, or kept but degraded, with why. */
export const CapabilityNote = z.object({ label: z.string(), reason: z.string() });
export type CapabilityNote = z.infer<typeof CapabilityNote>;

export const HostInventory = z.object({
  ollamaUrl: z.string(),
  ollamaUp: z.boolean().default(false),
  models: z.array(HostModel).default([]),
  runtimes: z.array(HostRuntime).default([]),
  /** configured but not advertised — preflight's verbatim reason */
  drops: z.array(CapabilityNote).default([]),
  /** advertised, but it will not run the way the config reads */
  notes: z.array(CapabilityNote).default([]),
});
export type HostInventory = z.infer<typeof HostInventory>;
