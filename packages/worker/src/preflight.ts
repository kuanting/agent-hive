import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { apiCapabilityReady } from "@hive/adapters";
import type { CapabilityRecord } from "@hive/shared";

/**
 * Capability preflight: keep only the statically-configured records this host
 * can actually execute.
 *
 * The counterpart to discoverOllamaCapabilities, which already returns [] when
 * Ollama is absent. Without this, a bee configured for both Claude Code and
 * Codex on a machine that has only one of them would advertise a capability it
 * cannot serve — the Queen would route to it, the CLI would fail, and the task
 * would burn escalation attempts before landing somewhere that works.
 *
 * Advertising less is the honest failure mode: the Queen simply routes to the
 * next-cheapest bee that does exist.
 */
export function viableCapabilities(
  records: CapabilityRecord[],
  log: (msg: string) => void = () => {},
): CapabilityRecord[] {
  return records.filter((record) => {
    const reason = unavailableReason(record);
    if (reason) {
      // Discovery re-runs every 30s; report each drop once, not forever.
      const line = `skipping ${describe(record)}: ${reason}`;
      if (!reported.has(line)) {
        reported.add(line);
        log(line);
      }
      return false;
    }
    return true;
  });
}

const reported = new Set<string>();

/** Test seam: forget which drops have already been logged. */
export function resetPreflightLog(): void {
  reported.clear();
  pathCache.clear();
}

/** Why this capability can't run here, or undefined when it can. */
function unavailableReason(record: CapabilityRecord): string | undefined {
  switch (record.runtime) {
    case "claude-code":
      return onPath("claude") ? undefined : "'claude' not on PATH";
    case "codex":
      return onPath("codex") ? undefined : "'codex' not on PATH";
    case "api": {
      const ready = apiCapabilityReady(record.model);
      return ready.ok ? undefined : ready.reason;
    }
    // opencode/openclaw/hermes fall back to a direct Ollama call when the
    // runtime binary is missing, so they stay viable as long as Ollama answers —
    // which discovery already checks. Tools are filtered by the ToolAdapter.
    default:
      return undefined;
  }
}

function describe(record: CapabilityRecord): string {
  return `${record.runtime}${record.model ? `/${record.model}` : ""}`;
}

const pathCache = new Map<string, boolean>();

/**
 * Whether a command resolves to an executable on PATH. Walks PATH directly
 * rather than shelling out to `command -v`: no subprocess per capability per
 * discovery tick, and no shell to quote a name into. Cached, since PATH doesn't
 * change under a running worker.
 */
function onPath(command: string): boolean {
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
