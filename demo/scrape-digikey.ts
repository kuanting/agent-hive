import "@hive/shared/env";
import { resolve } from "node:path";
import { readSnapshot, scrapeTick } from "@hive/adapters";

/**
 * Fill the local price store one tick.
 *
 *   npm run scrape:digikey
 *
 * Stands in for the cron job a real deployment would run. The point of the shape
 * is that this is the ONLY thing that fetches: the tier-4 lookup reads what this
 * left behind and never goes out to answer somebody's request. A scrape on the
 * critical path buys a third party's rate limits, latency and outages, and a
 * request that waits for one has not been made cheaper.
 *
 * There is no network here. Every figure is seeded from the part number and the
 * tick, so two runs into a fresh store are identical while consecutive ticks
 * differ — which is what lets the corpus classify the shape as reading live data
 * rather than as a procedure that cannot make up its mind.
 */

const ROOT = resolve(process.env.HIVE_ROOT ?? ".");
const DATA = resolve(ROOT, process.env.HIVE_TOOL_DATA_DIR ?? "data/tool-data");

const before = (() => {
  try {
    return readSnapshot(DATA);
  } catch {
    return undefined;
  }
})();

const snap = scrapeTick(DATA);
const parts = Object.keys(snap.rows);
const moved = before ? parts.filter((sku) => before.rows[sku]?.breaks[0].usd !== snap.rows[sku].breaks[0].usd) : [];

console.log(`[scrape] tick ${snap.tick} -> ${DATA}/digikey/prices/`);
console.log(`[scrape] ${parts.length} part(s), ${snap.source}`);
if (before) {
  console.log(`[scrape] ${moved.length} price(s) moved since tick ${before.tick}`);
  for (const sku of moved.slice(0, 3)) {
    const was = before.rows[sku].breaks[0].usd.toFixed(4);
    const now = snap.rows[sku].breaks[0].usd.toFixed(4);
    console.log(`[scrape]   ${snap.rows[sku].mpn}: $${was} -> $${now}`);
  }
} else {
  console.log(`[scrape] first tick — run again to see the prices move.`);
}
