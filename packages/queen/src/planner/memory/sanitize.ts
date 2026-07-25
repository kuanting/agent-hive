import { MEMORY_BODY_CHARS, MEMORY_NAME_CHARS } from "./types.js";

/**
 * Memory is written by a model and later re-fed to that same model, and the
 * files sit on disk where a human can edit them. So the same filter runs on
 * write and on read — a file that was clean when stored is not assumed clean
 * when loaded.
 *
 * This is defense in depth, not the load-bearing control. The real bound is
 * structural: PlannedTask and TaskSpec have no tier/maxUsd/billing field, so a
 * poisoned memory yields a badly shaped plan, never a route or budget escape.
 */

/** Lines that would let a body forge prompt structure or impersonate a role. */
const STRUCTURE = [
  /^\s*```/, // fenced block: could smuggle a JSON "decision"
  /^\s*---\s*$/, // bare rule: would forge a frontmatter boundary on rewrite
  /^\s*(system|assistant|user)\s*:/i,
];

/** Phrasings whose only purpose is to override the instructions above them. */
const OVERRIDE = [
  /ignore\s+(all\s+)?(previous|prior|above)/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /\bnew\s+instructions?\b/i,
];

/** Shapes that must never be persisted even if a model echoes them back. */
const SECRETS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{12,}\b/g, "[redacted]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted]"],
  [/\b[0-9a-f]{32,}\b/gi, "[redacted]"],
];

export interface SanitizeResult {
  text: string;
  /** true when the text still looked like an injection after stripping */
  rejected: boolean;
}

/**
 * Strip structure-forging lines and secrets. If an override phrase survives the
 * strip, the caller must drop the memory entirely rather than store a mangled
 * one — a half-scrubbed instruction is worse than no memory.
 */
export function sanitizeText(raw: string, maxChars: number): SanitizeResult {
  let text = String(raw ?? "")
    // strip control characters, keeping \t (09) and \n (0A)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .split("\n")
    .filter((line) => !STRUCTURE.some((r) => r.test(line)))
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  for (const [pattern, replacement] of SECRETS) text = text.replace(pattern, replacement);

  if (OVERRIDE.some((r) => r.test(text))) return { text: "", rejected: true };
  return { text: text.slice(0, maxChars), rejected: false };
}

export const sanitizeBody = (raw: string) => sanitizeText(raw, MEMORY_BODY_CHARS);
export const sanitizeName = (raw: string) => sanitizeText(raw.replace(/\n/g, " "), MEMORY_NAME_CHARS);
