import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The chapter list for DESIGN.md, derived from the file itself.
 *
 * DESIGN.md is deliberately *not* split into one file per chapter: it carries
 * twenty-two plain-text "§N" cross-references and README deep-links it four
 * times, so cutting it up would break both for no gain the on-page outline
 * doesn't already give. What it lacks is a chapter list in the left rail — so
 * we build one out of its own `##` headings.
 *
 * Deriving beats hardcoding because the ways a hardcoded list rots are the same
 * ways this rots, and one of them is silent: a renamed heading changes its
 * anchor, and a sidebar entry pointing at a stale anchor is a no-op scroll
 * rather than a build error. Reading the headings at config time means renaming
 * a chapter renames its sidebar entry with it.
 *
 * Plain `.mjs` rather than `.ts` so `verify-anchors.mjs` can import it under a
 * bare `node` in CI, without a type-stripping flag that Node 20 does not have.
 * `scripts/*.mjs` at the repo root already establishes the pattern.
 */

const DESIGN = fileURLToPath(new URL("../DESIGN.md", import.meta.url));

const COMBINING = /[\u0300-\u036F]/g;
const CONTROL = /[\u0000-\u001F]/g;
const SPECIAL = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g;

/**
 * VitePress's heading slugifier, from `@mdit-vue/shared`.
 *
 * Reimplemented rather than imported because VitePress bundles that package
 * into its own dist and does not re-export it. The clause worth noticing is the
 * last-but-one: an id may not begin with a digit, so every numbered chapter in
 * DESIGN.md gets an underscore prefix — `_5c-a-queen-that-learns…`, not
 * `5c-a-queen-that-learns…`. That is exactly where GitHub's slugs and
 * VitePress's diverge, which is why an anchor copied out of the GitHub reader
 * fails here silently rather than loudly.
 *
 * `verify-anchors.mjs` runs after every build and pins this against the real
 * rendered HTML, so a VitePress release that changes the rule breaks the build
 * instead of quietly breaking fourteen sidebar links.
 *
 * @param {string} str
 * @returns {string}
 */
export function slugify(str) {
  return str
    .normalize("NFKD")
    .replace(COMBINING, "")
    .replace(CONTROL, "")
    .replace(SPECIAL, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase();
}

/**
 * Every `## ` heading in DESIGN.md, in document order, ignoring fenced code.
 *
 * @param {string} markdown
 * @returns {{ text: string, anchor: string }[]}
 */
export function chapters(markdown) {
  const out = [];
  let inFence = false;

  for (const line of markdown.split("\n")) {
    // Chapter 3's mermaid flowchart can contain `#`-prefixed lines; without
    // this they would become phantom sidebar entries.
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^## +(.*?)\s*$/.exec(line);
    if (match) out.push({ text: match[1], anchor: slugify(match[1]) });
  }

  return out;
}

/** The chapters of the DESIGN.md sitting next to this file. */
export function designChapters() {
  return chapters(readFileSync(DESIGN, "utf8"));
}
