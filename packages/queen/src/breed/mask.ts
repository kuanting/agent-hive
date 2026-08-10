import { lex, invariantVocabulary, type Lexeme } from "./lex.js";

/**
 * Seeing past the values to the shape of the request.
 *
 * Forty digikey lookups are the same job forty times, and to a token comparison
 * they look like forty different ones — because the part number is the only thing
 * that changes and it is the only thing that carries any weight:
 *
 *     "LM358N: $1.20, stock 4200"       -> {lm358n, stock, 4200}
 *     "ATMEGA328P-PU: $3.45, stock 87"  -> {atmega328p-pu, stock}
 *     jaccard 0.25, against a threshold of 0.50
 *
 * Masking replaces the values with placeholders so the template underneath can be
 * compared. It is also the thing that makes the procedure gate able to *run*: it
 * groups requests that differ only by their arguments, and without those groups
 * there is nothing to check determinism against.
 *
 * Placeholders are chosen to survive `tokenize()` intact — lowercase, hyphenated,
 * longer than two characters, no punctuation it would strip — so a masked
 * document tokenizes to one token per masked value rather than to nothing.
 */

export type MaskClass =
  | "url"
  | "email"
  | "path"
  | "uuid"
  | "date"
  | "time"
  | "money"
  | "pct"
  | "hex"
  | "code"
  | "num";

export const PLACEHOLDER: Record<MaskClass, string> = {
  url: "mask-url",
  email: "mask-email",
  path: "mask-path",
  uuid: "mask-uuid",
  date: "mask-date",
  time: "mask-time",
  money: "mask-money",
  pct: "mask-pct",
  hex: "mask-hex",
  code: "mask-code",
  num: "mask-num",
};

/**
 * Applied in order, and the order matters: a url contains dots and digits, so
 * anything matching it first prevents `num` from shredding it into placeholders.
 *
 * `code` and `num` are the two that earn the digikey case and the two most likely
 * to over-reach — `code` also matches `claude-opus-4-6` and `gpt-4o`, which are
 * procedure rather than value whenever they appear in every request. They are the
 * two the invariant exemption below protects against.
 */
const SPAN_RULES: Array<{ cls: MaskClass; re: RegExp }> = [
  { cls: "url", re: /\b(?:https?:\/\/|www\.)[^\s,;)]+/gi },
  { cls: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/gi },
  { cls: "uuid", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { cls: "path", re: /(?:[A-Za-z]:)?(?:\/|\\)(?:[\w.-]+(?:\/|\\))+[\w.-]+/g },
  { cls: "date", re: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g },
  {
    cls: "date",
    re: /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/gi,
  },
  { cls: "time", re: /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi },
  { cls: "money", re: /[$€£¥]\s?\d[\d,]*(?:\.\d+)?\b/g },
  { cls: "money", re: /\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|jpy|twd|dollars?|cents?)\b/gi },
  { cls: "pct", re: /\b\d+(?:\.\d+)?\s?%/g },
  { cls: "hex", re: /\b0x[0-9a-f]+\b/gi },
];

/**
 * The two aggressive rules, matched against a whole lexeme rather than anywhere
 * in the string.
 *
 * Whole-lexeme is what makes the exemption mean anything. Run as a string regex,
 * `num` matches *inside* a token — so an exempt `claude-opus-4-6` was protected
 * from `code` and then shredded into `claude-opus-mask-num-mask-num` by `num` on
 * the very next pass. An exemption that only holds until the following rule is
 * not an exemption. `code` and `num` are single-token concepts anyway; only the
 * span rules above describe things that legitimately cross a boundary.
 */
const TOKEN_RULES: Array<{ cls: MaskClass; re: RegExp }> = [
  // A letter and a digit in the same token, four characters or more: part codes,
  // SKUs, order ids.
  { cls: "code", re: /^(?=[\w-]*[A-Za-z])(?=[\w-]*\d)[A-Za-z][\w-]{3,}$/ },
  { cls: "num", re: /^\d[\d,]*(?:\.\d+)?$/ },
];

export interface Masked {
  text: string;
  /** how many lexemes became placeholders */
  maskCount: number;
  /** how many lexemes there were */
  total: number;
  classes: Partial<Record<MaskClass, number>>;
}

/**
 * Mask one document.
 *
 * @param exempt tokens the cluster shares, which the aggressive rules must leave
 * alone. A token appearing in nearly every request is part of the procedure
 * whatever it looks like; a token appearing in one is a value. That distinction is
 * the whole feature, and it is why masking cannot be a pure function of one string.
 */
export function maskText(text: string, exempt: ReadonlySet<string> = new Set()): Masked {
  const classes: Partial<Record<MaskClass, number>> = {};
  const bump = (cls: MaskClass) => {
    classes[cls] = (classes[cls] ?? 0) + 1;
    return PLACEHOLDER[cls];
  };

  let out = text;
  for (const { cls, re } of SPAN_RULES) {
    out = out.replace(new RegExp(re.source, re.flags), (m) =>
      // Never re-mask a placeholder an earlier rule already wrote.
      m.toLowerCase().startsWith("mask-") ? m : bump(cls),
    );
  }

  // Then the aggressive rules, one lexeme at a time, so the exemption survives
  // every pass rather than only the pass it was checked in.
  let rebuilt = "";
  let cursor = 0;
  for (const l of lex(out)) {
    rebuilt += out.slice(cursor, l.start);
    cursor = l.end;
    if (l.lower.startsWith("mask-") || exempt.has(l.lower)) {
      rebuilt += l.raw;
      continue;
    }
    const hit = TOKEN_RULES.find((r) => r.re.test(l.raw));
    rebuilt += hit ? bump(hit.cls) : l.raw;
  }
  rebuilt += out.slice(cursor);

  // Counted on the ordered lexeme list of the ORIGINAL, not on a de-duplicated
  // token set: three prices in one answer collapse to a single `mask-money` in a
  // set, and the ratio would then understate exactly the case it exists to catch.
  const total = lex(text).length;
  const maskCount = Object.values(classes).reduce((a: number, b) => a + (b ?? 0), 0);
  return { text: rebuilt, maskCount, total, classes };
}

export interface MaskedCluster {
  masked: Masked[];
  exempt: Set<string>;
  /** mean fraction of each document that became placeholder */
  meanMaskRatio: number;
}

/**
 * Mask a cluster's documents against their own shared vocabulary.
 *
 * Note the exemption set is computed from the *raw* lexemes before any masking,
 * so it describes the cluster as written.
 */
export function maskCluster(texts: string[], minDf: number): MaskedCluster {
  const docs: Lexeme[][] = texts.map(lex);
  const exempt = invariantVocabulary(docs, minDf);
  const masked = texts.map((t) => maskText(t, exempt));
  const ratios = masked.map((m) => (m.total === 0 ? 0 : m.maskCount / m.total));
  return {
    masked,
    exempt,
    meanMaskRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0,
  };
}

/** Collapse incidental whitespace, so "the same text" means what a person means. */
export const normalize = (s: string): string => s.trim().replace(/\s+/g, " ");
