import { createHash } from "node:crypto";
import { tokenize } from "../planner/memory/recall.js";
import type { TaskEpisode } from "../episode.js";

/**
 * Grouping the task corpus into recurring shapes.
 *
 * The question breeding starts from is "what does this hive do over and over?",
 * and the corpus answers it in the only currency that survives the privacy
 * ratchet: structure. Skills, difficulty, which `toolInput` keys were present,
 * whether artifacts were involved. None of that is content, so this stage works
 * at `metadata` — the default, and the fidelity most corpora will actually be at.
 *
 * Nothing here spends a token or reads a model. A shape is an arithmetic fact
 * about rows that already exist.
 */

/** How many title tokens enter the signature, when titles are available at all. */
export const TITLE_TOKENS = 4;

/**
 * What the signature was computed from.
 *
 * `structural` is skills + difficulty + toolInput key names + whether there were
 * artifacts. `structural+title` adds the leading content words of the title, which
 * discriminates far better — "summarize this csv" and "write a paragraph about the
 * trend" are both `reporting`/`standard` and are not the same work — but titles are
 * the planner's phrasing of the user's request, so they exist only at `full`.
 */
export type ShapeBasis = "structural" | "structural+title";

export interface Shape {
  shapeId: string;
  customerId: string;
  skills: string[];
  difficulty?: string;
  toolInputKeys: string[];
  hasArtifacts: boolean;
  /** the tokens that entered the signature; empty on the `structural` basis */
  titleTokens: string[];
  /** every occurrence, oldest first — including the ones served from cache */
  rows: TaskEpisode[];
}

export interface Corpus {
  basis: ShapeBasis;
  shapes: Shape[];
  /** rows considered, after any customer/time filter */
  rowsRead: number;
  /** how many of those carried task text, which is what naming a parameter requires */
  rowsWithText: number;
  /**
   * Rows dropped because the work was confidential.
   *
   * Reported rather than silently skipped: a count is not content, and an
   * unstated omission reads as a claim of completeness. Anything summarizing
   * this corpus should say how much of the traffic it was not allowed to see.
   */
  withheldRows: number;
}

/**
 * Confidential work never enters the corpus.
 *
 * The ratchet already strips its text (`toTaskMetadata`), so nothing sensitive
 * could leak through — but the row still *counted*, inflating occurrences with
 * work no recommendation may be built from, and dragging the whole corpus down
 * to the coarse basis. Excluding it outright is both the honest reading and the
 * one that stops a single confidential task from blinding the engine.
 */
const isConfidential = (r: TaskEpisode): boolean =>
  r.sensitivity === "confidential" || r.downgradedReason === "task was confidential";

/** The stable part of a signature: everything that survives `metadata`. */
function structuralParts(row: TaskEpisode): string[] {
  return [
    row.customerId,
    [...row.skills].sort().join(","),
    row.difficulty ?? "",
    [...(row.toolInputKeys ?? [])].sort().join(","),
    row.artifactCount > 0 ? "art" : "",
  ];
}

function titlePart(row: TaskEpisode): string {
  if (!row.title) return "";
  return [...tokenize(row.title)].sort().slice(0, TITLE_TOKENS).join(",");
}

function signature(row: TaskEpisode, basis: ShapeBasis): string {
  const parts = structuralParts(row);
  if (basis === "structural+title") parts.push(titlePart(row));
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

/**
 * Group rows into shapes.
 *
 * The basis is chosen once for the whole run rather than per row: mixing them
 * would silently fragment a cluster, hashing the same recurring work two ways so
 * that both halves look rarer than the one real shape — and frequency is the
 * first thing that reads this.
 *
 * But "once for the whole run" used to mean *degrading everyone to the weakest
 * row present*, so a single text-free row among twenty thousand dropped the
 * entire corpus to the coarse basis. The fix is to let the majority decide and
 * exclude the rows that cannot participate, rather than to level down to them.
 * Excluded rows are still counted — they are evidence of recurrence even when
 * they cannot be clustered finely.
 */
export function buildCorpus(rows: TaskEpisode[]): Corpus {
  const withheldRows = rows.filter(isConfidential).length;
  const usable = rows.filter((r) => !isConfidential(r));
  const rowsWithText = usable.filter((r) => r.title !== undefined).length;

  // Title-based clustering is worth having as soon as most rows can support it.
  // Below that the fine basis would describe a minority and mis-sort the rest.
  const basis: ShapeBasis = rowsWithText > 0 && rowsWithText >= usable.length * 0.8 ? "structural+title" : "structural";
  // On the fine basis a row without a title cannot be placed: it would hash as
  // though its title were empty and collide with every other text-free row.
  const clustered = basis === "structural+title" ? usable.filter((r) => r.title !== undefined) : usable;

  const byId = new Map<string, Shape>();
  for (const row of clustered) {
    const shapeId = signature(row, basis);
    const shape = byId.get(shapeId) ?? {
      shapeId,
      customerId: row.customerId,
      skills: [...row.skills].sort(),
      difficulty: row.difficulty,
      toolInputKeys: [...(row.toolInputKeys ?? [])].sort(),
      hasArtifacts: row.artifactCount > 0,
      titleTokens: basis === "structural+title" ? titlePart(row).split(",").filter(Boolean) : [],
      rows: [],
    };
    shape.rows.push(row);
    byId.set(shapeId, shape);
  }

  for (const s of byId.values()) s.rows.sort((a, b) => a.at - b.at);
  return {
    basis,
    shapes: [...byId.values()].sort((a, b) => b.rows.length - a.rows.length),
    rowsRead: rows.length,
    rowsWithText,
    withheldRows,
  };
}

/** `30d`, `12h`, `90m` -> epoch ms, or undefined for "everything". */
export function parseSince(spec: string | undefined, now: number): number | undefined {
  if (!spec) return undefined;
  const m = /^(\d+)([dhm])$/.exec(spec.trim());
  if (!m) throw new Error(`unrecognized --since "${spec}" (expected e.g. 30d, 12h, 90m)`);
  const scale = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as "d" | "h" | "m"];
  return now - Number(m[1]) * scale;
}
