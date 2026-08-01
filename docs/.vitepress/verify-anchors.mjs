import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { designChapters } from "./design-chapters.mjs";

/**
 * Pins the DESIGN.md sidebar's anchors against the anchors VitePress actually
 * rendered, and fails the build when they diverge.
 *
 * The sidebar's fourteen chapter links are computed from a local copy of
 * VitePress's slugifier (see `design-chapters.mjs` for why it is a copy). A copy
 * can fall out of step — a VitePress release changes the rule, or a heading
 * grows a character the rule treats specially — and the failure mode is the
 * quietest one available: the link still renders, still clicks, and scrolls
 * nowhere. Nobody files a bug for that.
 *
 * So we check. This runs after `vitepress build`, reads the ids out of the page
 * that was just generated, and exits non-zero on the first mismatch. It also
 * catches the mermaid diagrams silently falling back to code blocks, which is
 * the other thing about this page that can break without erroring.
 */

const DIST = fileURLToPath(new URL("./dist/DESIGN.html", import.meta.url));

const html = readFileSync(DIST, "utf8");

const rendered = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
const derived = designChapters().map((c) => c.anchor);

const problems = [];

if (derived.length !== rendered.length) {
  problems.push(
    `sidebar derives ${derived.length} chapters but DESIGN.html rendered ${rendered.length} <h2> headings`,
  );
}

for (const [i, anchor] of derived.entries()) {
  if (anchor !== rendered[i]) {
    problems.push(
      `chapter ${i + 1}: sidebar links #${anchor}, page rendered #${rendered[i] ?? "(nothing)"}`,
    );
  }
}

// The four architecture diagrams are the reason this site needs a mermaid
// plugin at all. When the plugin fails to engage they degrade to a syntax-
// highlighted code block — legible, so easy to miss in a screenshot review.
const diagrams = (html.match(/<div class="mermaid/g) ?? []).length;
const unrendered = (html.match(/language-mermaid/g) ?? []).length;

if (diagrams !== 4 || unrendered !== 0) {
  problems.push(
    `expected 4 rendered mermaid diagrams and 0 raw mermaid code blocks, found ${diagrams} and ${unrendered}`,
  );
}

if (problems.length > 0) {
  console.error("\nDESIGN.md verification failed:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  process.exit(1);
}

console.log(
  `verified DESIGN.md: ${derived.length} chapter anchors match, ${diagrams} mermaid diagrams rendered`,
);
