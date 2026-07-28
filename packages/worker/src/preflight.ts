import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { apiCapabilityReady } from "@hive/adapters";
import {
  agentName,
  describeCapability,
  type CapabilityNote,
  type CapabilityRecord,
  type HostInventory,
} from "@hive/shared";

/**
 * Capability preflight: keep only the configured records this host can actually
 * execute, and say why about the rest.
 *
 * Without it, a bee configured for both Claude Code and Codex on a machine that
 * has only one of them would advertise a capability it cannot serve — the Queen
 * would route to it, the CLI would fail, and the task would burn escalation
 * attempts before landing somewhere that works. Advertising less is the honest
 * failure mode: the Queen simply routes to the next-cheapest bee that exists.
 *
 * Pure and synchronous: every probe it needs already happened in probeHost().
 * That is what lets the console's Setup view and these drop reasons come from
 * one set of facts instead of two that can disagree — and it makes the rules
 * testable from a fixture instead of a stubbed fetch.
 */
export interface PreflightReport {
  /** records this host will advertise */
  kept: CapabilityRecord[];
  /** configured but refused, with the reason an operator can act on */
  drops: CapabilityNote[];
  /** advertised, but it will not run the way the config reads */
  notes: CapabilityNote[];
}

export function preflight(records: CapabilityRecord[], host: HostInventory): PreflightReport {
  const report: PreflightReport = { kept: [], drops: [], notes: [] };
  for (const record of records) {
    const label = describeCapability(record);
    const reason = unavailableReason(record, host);
    if (reason) {
      report.drops.push({ label, reason });
      continue;
    }
    const note = degradedReason(record, host);
    if (note) report.notes.push({ label, reason: note });
    report.kept.push(record);
  }
  return report;
}

/** Preflight plus the once-per-reason logging the worker wants. */
export function viableCapabilities(
  records: CapabilityRecord[],
  host: HostInventory,
  log: (msg: string) => void = () => {},
): PreflightReport {
  const report = preflight(records, host);
  // Discovery re-runs every 30s; report each line once, not forever.
  for (const d of report.drops) say(`skipping ${d.label}: ${d.reason}`);
  for (const n of report.notes) say(`${n.label}: ${n.reason}`);
  function say(line: string) {
    if (reported.has(line)) return;
    reported.add(line);
    log(line);
  }
  return report;
}

const reported = new Set<string>();

/** Test seam: forget which drops have already been logged. */
export function resetPreflightLog(): void {
  reported.clear();
  pathCache.clear();
}

/** Runtimes served by a model the local Ollama daemon holds. */
const OLLAMA_BACKED = new Set(["opencode", "openclaw", "hermes", "ollama"]);

/** Why this capability can't run here, or undefined when it can. */
function unavailableReason(record: CapabilityRecord, host: HostInventory): string | undefined {
  switch (record.runtime) {
    case "claude-code":
      return onPath("claude") ? undefined : "'claude' not on PATH";
    case "codex":
      return onPath("codex") ? undefined : "'codex' not on PATH";
    case "api": {
      const ready = apiCapabilityReady(record.model);
      return ready.ok ? undefined : ready.reason;
    }
    case "personal": {
      // Viable if any backend can serve it: an OpenClaw gateway, a Hermes CLI,
      // or a local Ollama model for the built-in mini agent.
      const hermes = process.env.HERMES_CMD ?? "hermes";
      if (present(host, "openclaw") || onPath(hermes) || host.models.length > 0) return undefined;
      return `no OpenClaw gateway, no '${hermes}' on PATH, and no local Ollama models`;
    }
    case "tool":
      return undefined;
    default: {
      // Ollama-backed runtimes degrade to a direct call when their agent binary
      // is missing, so the binary is not required — but the MODEL is. Discovery
      // used to prove a model existed by only ever registering installed ones;
      // now that the operator declares them, this is where a typo or an
      // un-pulled tag gets caught, instead of at dispatch.
      if (!OLLAMA_BACKED.has(record.runtime)) return undefined;
      if (!host.ollamaUp) return `no Ollama daemon answering at ${host.ollamaUrl}`;
      if (record.model && !host.models.some((m) => sameTag(m.name, record.model!))) {
        return `'${record.model}' not installed in local Ollama (try \`ollama pull ${record.model}\`)`;
      }
      return undefined;
    }
  }
}

/** It will run, but not the way the config reads. Kept, and said out loud. */
function degradedReason(record: CapabilityRecord, host: HostInventory): string | undefined {
  const name = agentName(record);
  if (["opencode", "openclaw", "hermes"].includes(record.runtime) && !present(host, record.runtime)) {
    return `${record.runtime} not available here — tasks will run via ollama-direct`;
  }
  if (record.runtime === "hermes" || (record.runtime === "personal" && name === "hermes")) {
    const model = host.models.find((m) => record.model && sameTag(m.name, record.model));
    if (model && !model.tools) {
      return `'${model.name}' does not support tool calling, which hermes requires — it will fall back`;
    }
  }
  return undefined;
}

function present(host: HostInventory, name: string): boolean {
  return host.runtimes.some((r) => r.name === name && r.present);
}

/** Ollama reports `name:tag`; a bare name means `:latest`. */
function sameTag(a: string, b: string): boolean {
  const norm = (s: string) => (s.includes(":") ? s : `${s}:latest`);
  return norm(a) === norm(b);
}

const pathCache = new Map<string, boolean>();

/**
 * Whether a command resolves to an executable on PATH. Walks PATH directly
 * rather than shelling out to `command -v`: no subprocess per capability per
 * discovery tick, and no shell to quote a name into. Cached, since PATH doesn't
 * change under a running worker.
 */
export function onPath(command: string): boolean {
  const cached = pathCache.get(command);
  if (cached !== undefined) return cached;
  const found = (process.env.PATH ?? "").split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  pathCache.set(command, found);
  return found;
}
