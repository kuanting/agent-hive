import { STOPWORDS } from "../planner/memory/recall.js";

/**
 * Reading a request as a sequence rather than as a bag.
 *
 * `tokenize()` (planner/memory/recall.ts) returns an unordered `Set`, which is
 * exactly right for recall — a memory either shares a trigger word with the user's
 * message or it does not — and useless here. Finding the fixed part of a recurring
 * request means knowing which words came *in what order*, and finding the varying
 * part means knowing where in the original text to look.
 *
 * The stopword list is shared rather than copied, so the two sides cannot drift
 * apart about what counts as a content word.
 */

export interface Lexeme {
  /** lowercased, as everything downstream compares */
  lower: string;
  /** exactly as written, for showing a human an example value */
  raw: string;
  /** offsets into the source text, so a masked span can be put back */
  start: number;
  end: number;
  stop: boolean;
}

/**
 * Split on everything that is not part of a word, keeping the characters that
 * carry meaning inside one: `$` and `%` because a price and a percentage are
 * single values, `.` `/` `:` `_` `-` because part codes, paths, times and urls
 * are torn apart without them. That is deliberately looser than `tokenize`,
 * which is measuring similarity and can afford to shred; this is measuring
 * structure and cannot.
 */
const BOUNDARY = /[^A-Za-z0-9$€£¥%./:_-]+/;

/**
 * Punctuation that is meaningful *inside* a token and noise at its edges.
 *
 * `10:30`, `a.txt` and `claude-opus-4-6` are each one thing, so the separators
 * have to stay in the alphabet — which then makes `LM358N:` and `rows:` single
 * tokens too, with a colon glued on that belongs to the sentence. Left there it
 * defeats every whole-token test downstream: `LM358N:` is not a part code to a
 * regex anchored with `$`. Currency and percent signs are not trimmed, because
 * there they are the value's own notation rather than the sentence's.
 */
const EDGE_PUNCT = /^[.:/_-]+|[.:/_-]+$/g;

export function lex(text: string): Lexeme[] {
  const out: Lexeme[] = [];
  let i = 0;
  for (const piece of text.split(BOUNDARY)) {
    if (piece === "") {
      i += 1;
      continue;
    }
    const at = text.indexOf(piece, i);
    if (at < 0) continue;
    i = at + piece.length;

    const trimmed = piece.replace(EDGE_PUNCT, "");
    if (trimmed === "") continue;
    const start = at + piece.indexOf(trimmed);
    const lower = trimmed.toLowerCase();
    out.push({ lower, raw: trimmed, start, end: start + trimmed.length, stop: STOPWORDS.has(lower) });
  }
  return out;
}

/** n-grams of a lexeme sequence, joined by a space. */
export function ngrams(doc: Lexeme[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= doc.length; i++) {
    out.push(
      doc
        .slice(i, i + n)
        .map((l) => l.lower)
        .join(" "),
    );
  }
  return out;
}

/**
 * In how many documents each n-gram appears — documents, not occurrences.
 *
 * Repetition inside one request says nothing about whether a phrase is part of
 * the procedure; repetition *across* requests is the entire signal.
 */
export function docFreq(docs: Lexeme[][], n: number): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const g of new Set(ngrams(doc, n))) df.set(g, (df.get(g) ?? 0) + 1);
  }
  return df;
}

/**
 * The phrases nearly every request shares — the fixed procedure, as opposed to
 * the values filled into it.
 *
 * Maximal only: an n-gram contained in a longer kept one says nothing the longer
 * one does not, and keeping both would make "price for" and "the price for"
 * compete as separate anchors for the same position.
 */
export function invariantNgrams(docs: Lexeme[][], minDf: number, maxN = 5): string[] {
  if (docs.length === 0) return [];
  const threshold = minDf * docs.length;
  const kept: string[] = [];
  // Longest first, so a shorter phrase can be tested against what is already kept.
  for (let n = maxN; n >= 1; n--) {
    for (const [gram, count] of docFreq(docs, n)) {
      if (count < threshold) continue;
      if (kept.some((k) => k === gram || k.includes(` ${gram} `) || k.startsWith(`${gram} `) || k.endsWith(` ${gram}`))) {
        continue;
      }
      kept.push(gram);
    }
  }
  // Deterministic: by length then lexicographic, never by map iteration order.
  return kept.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * The single words nearly every request shares.
 *
 * Separate from `invariantNgrams` because it answers a different question and is
 * consumed differently: this is the exemption set that decides what masking is
 * allowed to touch, and it must be a membership test on one lexeme.
 */
export function invariantVocabulary(docs: Lexeme[][], minDf: number): Set<string> {
  const threshold = minDf * docs.length;
  const out = new Set<string>();
  if (docs.length === 0) return out;
  for (const [gram, count] of docFreq(docs, 1)) {
    if (count >= threshold) out.add(gram);
  }
  return out;
}
