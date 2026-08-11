import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HardcodedTool, ToolData } from "./index.js";

/**
 * A part-price lookup, and the scraper that feeds it.
 *
 * This tool exists because the usage corpus said so. Six agent loops ran
 * `digikey_search -> get_price` against a model, `npm run breed -- flows`
 * reported the procedure and what it cost, and this is what somebody wrote after
 * reading that — the loop the whole breeding idea describes, closed once.
 *
 * The shape is the part worth copying. A price lookup is NOT a scrape: the
 * scraper runs on a schedule and writes a local store, and this reads it. Doing
 * it the other way puts a third party on the critical path of a user's request,
 * which buys their rate limits, their latency and their outages — and a request
 * that has to wait for a scrape has not been made cheaper, only differently
 * expensive.
 *
 * Writer and reader live in one file on purpose. Two files agreeing about a
 * format is a thing that stops being true quietly.
 *
 * The data is fabricated. There is no network here, and every price is a seeded
 * function of the part number and the scrape tick — enough to demonstrate the
 * architecture and the `live` classification, and not a claim about any real
 * price. Every answer says so.
 */

const STORE = "digikey";
const CATALOG = `${STORE}/catalog.json`;
const LATEST = `${STORE}/prices/latest.json`;

/** A dozen real part numbers, so the demo reads like the thing it stands in for. */
const PARTS: Array<{ mpn: string; sku: string; manufacturer: string; base: number }> = [
  { mpn: "LM358N", sku: "296-1395-5-ND", manufacturer: "Texas Instruments", base: 0.62 },
  { mpn: "NE555P", sku: "296-1857-5-ND", manufacturer: "Texas Instruments", base: 0.51 },
  { mpn: "ATMEGA328P-PU", sku: "ATMEGA328P-PU-ND", manufacturer: "Microchip", base: 2.34 },
  { mpn: "STM32F103C8T6", sku: "497-6063-ND", manufacturer: "STMicroelectronics", base: 2.41 },
  { mpn: "ESP32-WROOM-32E", sku: "1965-ESP32-WROOM-32E-ND", manufacturer: "Espressif", base: 3.12 },
  { mpn: "RC0402FR-0710KL", sku: "311-10.0KLRCT-ND", manufacturer: "Yageo", base: 0.02 },
  { mpn: "GRM188R71H104KA93D", sku: "490-1524-1-ND", manufacturer: "Murata", base: 0.06 },
  { mpn: "1N4148", sku: "1N4148FS-ND", manufacturer: "onsemi", base: 0.09 },
  { mpn: "IRLZ44N", sku: "IRLZ44NPBF-ND", manufacturer: "Infineon", base: 1.18 },
  { mpn: "MCP3008-I/P", sku: "MCP3008-I/P-ND", manufacturer: "Microchip", base: 3.75 },
  { mpn: "DS18B20", sku: "DS18B20+-ND", manufacturer: "Analog Devices", base: 4.28 },
  { mpn: "SN74HC595N", sku: "296-1600-5-ND", manufacturer: "Texas Instruments", base: 0.58 },
];

export interface PriceBreak {
  qty: number;
  usd: number;
}
export interface PriceRow {
  mpn: string;
  manufacturer: string;
  stock: number;
  currency: "USD";
  breaks: PriceBreak[];
}
export interface PriceSnapshot {
  tick: number;
  scrapedAt: string;
  source: string;
  rows: Record<string, PriceRow>;
}
export interface CatalogEntry {
  sku: string;
  manufacturer: string;
}

/**
 * A number in [0,1) from a string. Seeded by content rather than by the clock,
 * so two scrapes into a fresh store produce byte-identical rows and a test can
 * assert exact prices — while consecutive ticks still differ, which is the
 * property the corpus reads as live data rather than as a broken procedure.
 */
function seeded(...parts: Array<string | number>): number {
  const h = createHash("sha1").update(parts.join(":")).digest();
  return h.readUInt32BE(0) / 0xffff_ffff;
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** The next tick, derived from the store rather than from wall time. */
function nextTick(dir: string): number {
  try {
    const seen = readdirSync(join(dir, "prices"))
      .map((f) => /^tick-(\d+)\.json$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    return seen.length ? Math.max(...seen) + 1 : 1;
  } catch {
    return 1;
  }
}

/**
 * Run one scrape.
 *
 * Writes `prices/tick-N.json` as history and overwrites `prices/latest.json`,
 * which is the only file the lookup reads. History is never read by the tool and
 * exists so an operator can see that the numbers move.
 */
export function scrapeTick(root: string): PriceSnapshot {
  const dir = join(root, STORE);
  mkdirSync(join(dir, "prices"), { recursive: true });

  const tick = nextTick(dir);
  const rows: Record<string, PriceRow> = {};
  for (const p of PARTS) {
    // ±8% around the base, and a stock level that walks independently.
    const drift = (seeded(p.sku, tick, "price") - 0.5) * 0.16;
    const unit = Math.max(0.01, round(p.base * (1 + drift)));
    rows[p.sku] = {
      mpn: p.mpn,
      manufacturer: p.manufacturer,
      stock: Math.round(200 + seeded(p.sku, tick, "stock") * 9800),
      currency: "USD",
      breaks: [
        { qty: 1, usd: unit },
        { qty: 10, usd: round(unit * 0.95) },
        { qty: 100, usd: round(unit * 0.82) },
        { qty: 1000, usd: round(unit * 0.71) },
      ],
    };
  }

  const snapshot: PriceSnapshot = {
    tick,
    scrapedAt: new Date().toISOString(),
    source: "stub-scraper (no network; every figure is seeded from part+tick and is not a real price)",
    rows,
  };

  const catalog: Record<string, CatalogEntry> = {};
  for (const p of PARTS) catalog[p.mpn.toUpperCase()] = { sku: p.sku, manufacturer: p.manufacturer };

  writeFileSync(join(root, CATALOG), `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(join(dir, "prices", `tick-${String(tick).padStart(4, "0")}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(join(root, LATEST), `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

/** For the CLI, which wants to say what it found without re-reading the file. */
export function readSnapshot(root: string): PriceSnapshot {
  return JSON.parse(readFileSync(join(root, LATEST), "utf8")) as PriceSnapshot;
}

// ---- bred tool: digikey part price, from the local store ----
const digikeyPriceInput = z.object({
  part: z.string().min(1),
  qty: z.number().int().positive().optional(),
});

export const digikeyPriceTool: HardcodedTool = {
  toolId: "digikey-price",
  skills: ["sourcing", "reporting"],
  inputSchema: digikeyPriceInput as z.ZodType<Record<string, unknown>>,
  run(input, _readArtifact, data) {
    const { part, qty = 1 } = digikeyPriceInput.parse(input);

    // No store configured is a different failure from an empty one, and saying
    // which is the difference between an operator fixing the config and going
    // to look for missing data.
    if (!data) {
      throw new Error("digikey-price: no tool data root is configured (HIVE_TOOL_DATA_DIR).");
    }
    if (!data.exists(LATEST)) {
      throw new Error(
        "digikey-price: no local price store. This lookup never goes to the network to " +
          "answer a request — it reads what the schedule already fetched. Run `npm run scrape:digikey`.",
      );
    }

    const snapshot = data.readJson<PriceSnapshot>(LATEST);
    const catalog = data.readJson<Record<string, CatalogEntry>>(CATALOG);
    const key = part.trim().toUpperCase();
    const entry = catalog[key];
    const sku = entry?.sku ?? (snapshot.rows[part.trim()] ? part.trim() : undefined);
    const row = sku ? snapshot.rows[sku] : undefined;
    const asOf = `as of: ${snapshot.scrapedAt} (scrape tick ${snapshot.tick}, ${snapshot.source})`;

    // Not stocked is an ANSWER, not a malfunction, and the difference costs real
    // money: a thrown tier-4 error escalates, and the retry skips tool matching
    // — so throwing here would hand a correct negative to a model that will
    // cheerfully invent a price. The store is the authority on its own contents.
    if (!row || !sku) {
      return [
        `part: ${part} -> not in the local catalogue`,
        `catalogue holds ${Object.keys(catalog).length} part(s); this store does not cover it.`,
        asOf,
      ].join("\n");
    }

    // Largest break at or below the requested quantity; below the smallest, the
    // qty-1 price is the honest answer rather than an extrapolation.
    const applicable = row.breaks.filter((b) => b.qty <= qty);
    const chosen = applicable.length ? applicable[applicable.length - 1] : row.breaks[0];

    return [
      `part: ${row.mpn}  ->  sku ${sku} (${row.manufacturer})`,
      `unit price: $${chosen.usd.toFixed(4)} at qty ${chosen.qty}${chosen.qty > qty ? ` (asked for ${qty}; smallest break is ${chosen.qty})` : ""}`,
      `breaks: ${row.breaks.map((b) => `${b.qty} @ $${b.usd.toFixed(4)}`).join(" | ")}`,
      `stock: ${row.stock}`,
      asOf,
    ].join("\n");
  },
};
