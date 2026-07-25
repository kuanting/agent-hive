import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The plan guide: hand-authored markdown that shapes how the Queen decomposes
 * work. Advice, never authority — it says how to split a request, which skill
 * tags exist and when to fill toolInput, and it never mentions tiers or dollars.
 * Those stay in customers/<id>.yaml (budget:/policy:) and are decided by
 * QueenCore, which this file cannot reach.
 *
 * Two layers, both checked in beside the profiles they belong to:
 *   customers/plan-guide.md            house guide, every customer
 *   customers/<customerId>.plan-guide.md   per-customer overlay
 *
 * loadCustomers filters on .yaml/.yml, so .md files in customers/ are invisible
 * to it. The overlay loads last: small models weight the end of a prompt hardest.
 */

/** Hard char cap, in the spirit of buildPrompt's artifactBudgetChars. The default
 *  planner brain is gemma3:4b, which degrades on prompt bloat, so this is sized
 *  well below what a frontier model would tolerate. */
const GUIDE_BUDGET_CHARS = Number(process.env.HIVE_GUIDE_BUDGET_CHARS ?? 1200);
const ENABLED = process.env.HIVE_PLAN_GUIDE !== "0";

interface CacheEntry {
  mtimeMs: number;
  text: string;
}
const cache = new Map<string, CacheEntry>();

/**
 * Read one guide file, memoized on mtime so editing a guide takes effect on the
 * next turn without restarting the Queen. A missing or unreadable file is not an
 * error: it means this layer simply has nothing to say.
 */
function readLayer(path: string): string {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.text;
    // HTML comments are authoring notes for the human editing the file. They are
    // not instructions for the model, so they must not be charged to the budget
    // — a well-documented guide would otherwise crowd out its own content.
    const text = readFileSync(path, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
    cache.set(path, { mtimeMs, text });
    return text;
  } catch {
    cache.delete(path);
    return "";
  }
}

/**
 * Trim to the budget by dropping whole trailing `##` sections rather than
 * cutting mid-sentence. An author can see exactly what will be cut by counting
 * sections; a mid-word truncation in a prompt is the kind of bug nobody finds.
 * A preamble longer than the budget on its own is the one case that still gets
 * a hard cut — there are no section boundaries left to respect.
 */
function trimToSections(text: string, budget: number): string {
  if (text.length <= budget) return text;

  // Split on `##` headings, keeping any preamble as the first chunk. Then take
  // whole sections while they fit and stop at the first that does not — once a
  // section is too big, everything after it goes too. Taking later sections
  // just because they happen to be smaller would silently reorder the author's
  // priorities, and resuming mid-document leaves a half-sentence in the prompt.
  const sections = text.split(/\n(?=##\s)/);
  const kept: string[] = [];
  let len = 0;

  for (const section of sections) {
    const cost = section.length + (kept.length ? 1 : 0);
    if (len + cost > budget) break;
    kept.push(section);
    len += cost;
  }

  // Nothing fit — either a preamble or a single first section longer than the
  // whole budget. No section boundary is left to respect, so fall back to the
  // last line boundary rather than cutting mid-word.
  if (kept.length === 0) {
    const cut = text.slice(0, budget);
    const lastBreak = cut.lastIndexOf("\n");
    return (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd();
  }
  return kept.join("\n").trimEnd();
}

/**
 * House guide + customer overlay, concatenated and trimmed to one shared budget.
 * Returns "" when both layers are absent or the feature is switched off, which
 * callers treat as "add nothing to the prompt".
 */
export function loadGuide(root: string, customerId: string): string {
  if (!ENABLED) return "";
  const dir = join(root, "customers");
  const house = readLayer(join(dir, "plan-guide.md"));
  const overlay = readLayer(join(dir, `${customerId}.plan-guide.md`));

  // Budget the layers separately. Trimming the joined text would drop trailing
  // sections first, and the overlay is last — so the customer-specific layer,
  // the more valuable one, would be the first thing discarded.
  //
  // Half the budget is a FLOOR for each layer, not a ceiling: whatever one
  // layer does not need flows to the other. Capping the overlay at half
  // outright meant a short house guide left headroom unused while overlay
  // sections were dropped.
  const houseFloor = Math.floor(GUIDE_BUDGET_CHARS / 2);
  const overlayBudget = GUIDE_BUDGET_CHARS - Math.min(house.length, houseFloor);
  const trimmedOverlay = trimToSections(overlay, overlayBudget);

  const houseBudget = GUIDE_BUDGET_CHARS - trimmedOverlay.length - (trimmedOverlay ? 2 : 0);
  const trimmedHouse = trimToSections(house, Math.max(0, houseBudget));

  return [trimmedHouse, trimmedOverlay].filter(Boolean).join("\n\n");
}

export const GUIDE_BUDGET = GUIDE_BUDGET_CHARS;
