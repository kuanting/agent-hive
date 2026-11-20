import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { queryTerms } from "../src/personal-agent/sandbox.js";
import { buildPersonalContext } from "../src/personal-agent/mini.js";

/**
 * Requests in Chinese have no spaces between words. Before CJK terms, a whole
 * request was one "word" that no document contained, so the personal bee was
 * handed no data and answered from nothing, in exactly the language the
 * iBuddy Office demo is given in.
 */
describe("queryTerms", () => {
  it("keeps English behaviour: words over two letters, minus stopwords", () => {
    expect(queryTerms("Summarize the quotes for Acme, please")).toEqual(["summarize", "quotes", "acme"]);
  });

  it("splits Chinese into overlapping two-character terms", () => {
    expect(queryTerms("整理客戶報價")).toEqual(["整理", "理客", "客戶", "戶報", "報價"]);
  });

  it("handles mixed text and drops common filler pairs", () => {
    const terms = queryTerms("請幫我整理 Acme 的報價");
    expect(terms).toContain("acme");
    expect(terms).toContain("報價");
    expect(terms).not.toContain("請幫");
    expect(terms).not.toContain("幫我");
  });

  it("finds a Chinese document for a Chinese request", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-cjk-"));
    writeFileSync(join(root, "quotes.md"), "# 本週客戶報價\n\n宏達機械：報價 12 萬，尚未回覆。");
    writeFileSync(join(root, "lunch.md"), "# 午餐\n\n便當店菜單");
    const context = buildPersonalContext(root, "整理本週客戶報價，列出未回覆的客戶");
    expect(context).toContain("quotes.md");
    expect(context).not.toContain("便當店");
  });
});
