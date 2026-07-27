import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Filesystem sandbox for the personal bee. Every path an agent touches is
 * resolved against a single configured root and re-checked after realpath, so
 * neither "../" traversal nor a symlink can reach data outside the personal
 * corpus. Reads are size- and count-capped to keep prompts small and to make a
 * hostile fixture (a giant file, a huge directory) harmless.
 */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_DIR_ENTRIES = 200;
const MAX_MAIL_RESULTS = 20;

export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface MailMessage {
  id: string;
  from: string;
  to?: string;
  date?: string;
  subject: string;
  body: string;
  labels?: string[];
}

const within = (candidate: string, base: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

/**
 * Resolve `rel` inside `root` and guarantee the result stays within it. Rejects
 * absolute paths and any escape via ".." or a symlink. Non-existent paths are
 * allowed through (the prefix check already passed) so callers get a clean
 * ENOENT rather than a sandbox error for a simple typo.
 */
export function safeResolve(root: string, rel: string): string {
  if (!rel || typeof rel !== "string") throw new SandboxError("empty path");
  if (rel.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("\\")) {
    throw new SandboxError(`absolute paths are not allowed: ${rel}`);
  }
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, rel);
  if (!within(target, rootResolved)) {
    throw new SandboxError(`path escapes the personal-data root: ${rel}`);
  }
  try {
    const realTarget = realpathSync(target);
    const realRoot = realpathSync(rootResolved);
    if (!within(realTarget, realRoot)) {
      throw new SandboxError(`path escapes the personal-data root via symlink: ${rel}`);
    }
    return realTarget;
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    // ENOENT and friends: the path simply doesn't exist yet. The prefix check
    // above already proved it would be inside the root; let the caller's read
    // surface the real error.
    return target;
  }
}

export function readPersonalFile(root: string, rel: string): string {
  const p = safeResolve(root, rel);
  const st = statSync(p);
  if (!st.isFile()) throw new SandboxError(`not a file: ${rel}`);
  return readFileSync(p).subarray(0, MAX_FILE_BYTES).toString("utf8");
}

export function listPersonalDir(root: string, rel = "."): DirEntry[] {
  const p = safeResolve(root, rel);
  const st = statSync(p);
  if (!st.isDirectory()) throw new SandboxError(`not a directory: ${rel}`);
  return readdirSync(p, { withFileTypes: true })
    .slice(0, MAX_DIR_ENTRIES)
    .map((d) => ({ name: d.name, type: d.isDirectory() ? "dir" : "file" }));
}

/** Bounded recursive file listing, relative paths, for building a data overview. */
export function walkFiles(root: string, opts?: { maxFiles?: number; maxDepth?: number }): string[] {
  const maxFiles = opts?.maxFiles ?? 100;
  const maxDepth = opts?.maxDepth ?? 3;
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries: DirEntry[];
    try {
      entries = listPersonalDir(root, rel);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      const childRel = rel === "." ? e.name : `${rel}/${e.name}`;
      if (e.type === "dir") walk(childRel, depth + 1);
      else out.push(childRel);
    }
  };
  walk(".", 0);
  return out;
}

function coerceMessage(m: Record<string, unknown>): MailMessage {
  return {
    id: String(m.id ?? ""),
    from: String(m.from ?? ""),
    to: m.to == null ? undefined : String(m.to),
    date: m.date == null ? undefined : String(m.date),
    subject: String(m.subject ?? ""),
    body: String(m.body ?? ""),
    labels: Array.isArray(m.labels) ? m.labels.map(String) : undefined,
  };
}

/** Parse the mock mailbox defensively; a malformed file yields an empty inbox, never a throw. */
export function listMailbox(root: string, file = "mailbox.json"): MailMessage[] {
  let raw: string;
  try {
    raw = readPersonalFile(root, file);
  } catch {
    return [];
  }
  try {
    const data = JSON.parse(raw) as unknown;
    const arr = Array.isArray(data)
      ? data
      : Array.isArray((data as { messages?: unknown[] })?.messages)
        ? (data as { messages: unknown[] }).messages
        : [];
    return arr
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
      .map(coerceMessage);
  } catch {
    return [];
  }
}

/** Case-insensitive substring search over subject/from/body/labels, ranked by term hits. */
export function searchMailbox(root: string, query: string, file = "mailbox.json"): MailMessage[] {
  const all = listMailbox(root, file);
  const q = query.toLowerCase().trim();
  if (!q) return all.slice(0, MAX_MAIL_RESULTS);
  const terms = [...new Set(q.split(/\s+/).filter((t) => t.length > 2))];
  if (terms.length === 0) return all.slice(0, MAX_MAIL_RESULTS);
  return all
    .map((m) => {
      const hay = `${m.subject} ${m.from} ${m.body} ${(m.labels ?? []).join(" ")}`.toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MAIL_RESULTS)
    .map((x) => x.m);
}
