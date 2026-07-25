import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGuide } from "../src/planner/guide.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hive-guide-"));
  mkdirSync(join(root, "customers"), { recursive: true });
  return root;
}

describe("plan guide", () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });

  it("returns empty when no guide exists, rather than throwing", () => {
    expect(loadGuide(root, "aiotlab")).toBe("");
    expect(loadGuide(join(root, "nope"), "aiotlab")).toBe("");
  });

  it("layers the house guide before the customer overlay", () => {
    writeFileSync(join(root, "customers", "plan-guide.md"), "## House\nhouse rule");
    writeFileSync(join(root, "customers", "aiotlab.plan-guide.md"), "## Lab\nlab rule");

    const guide = loadGuide(root, "aiotlab");
    expect(guide.indexOf("house rule")).toBeLessThan(guide.indexOf("lab rule"));
  });

  it("loads only the house layer for a customer with no overlay", () => {
    writeFileSync(join(root, "customers", "plan-guide.md"), "## House\nhouse rule");
    expect(loadGuide(root, "demo-lab")).toContain("house rule");
    expect(loadGuide(root, "demo-lab")).not.toContain("lab rule");
  });

  it("picks up an edit without a restart (mtime cache, not a permanent one)", async () => {
    const path = join(root, "customers", "plan-guide.md");
    writeFileSync(path, "## A\nfirst");
    expect(loadGuide(root, "aiotlab")).toContain("first");

    await new Promise((r) => setTimeout(r, 12)); // let mtime advance
    writeFileSync(path, "## A\nsecond");
    expect(loadGuide(root, "aiotlab")).toContain("second");
  });

  it("drops whole trailing sections at the budget, never cutting mid-section", () => {
    const budget = Number(process.env.HIVE_GUIDE_BUDGET_CHARS ?? 1200);
    // Multi-line sections on purpose: a single-line section can only ever be
    // kept or dropped whole, so it cannot catch a truncator that resumes at the
    // next heading after cutting one section short.
    const section = (n: number) => `## Section ${n}\nalpha ${n}\nbeta ${n}\ngamma ${n}\ndelta ${n}`;
    const long = Array.from({ length: 30 }, (_, i) => section(i)).join("\n");
    writeFileSync(join(root, "customers", "plan-guide.md"), long);

    const guide = loadGuide(root, "aiotlab");
    expect(guide.length).toBeLessThanOrEqual(budget);

    const kept = guide.split(/\n(?=## )/).filter(Boolean);
    expect(kept.length).toBeGreaterThan(0);
    for (const part of kept) {
      const n = /## Section (\d+)/.exec(part)![1];
      // whole section or nothing — all four body lines must be present
      for (const line of ["alpha", "beta", "gamma", "delta"]) expect(part).toContain(`${line} ${n}`);
    }
    // and they are the *leading* sections, in order — not a cherry-pick of whatever fit
    expect(kept.map((p) => Number(/## Section (\d+)/.exec(p)![1]))).toEqual(kept.map((_, i) => i));
  });

  it("does not charge HTML authoring comments against the budget", () => {
    const comment = `<!--\n${"note ".repeat(200)}\n-->\n`;
    writeFileSync(join(root, "customers", "plan-guide.md"), `${comment}## Real\nkept content`);

    const guide = loadGuide(root, "aiotlab");
    expect(guide).not.toContain("<!--");
    expect(guide).toContain("kept content");
  });

  it("lets an overlay use headroom a short house guide leaves unused", () => {
    // Half the budget is a floor, not a ceiling. Capping the overlay at half
    // outright meant a tiny house guide left ~600 chars unspent while overlay
    // sections were dropped.
    writeFileSync(join(root, "customers", "plan-guide.md"), "## H\ntiny");
    const overlay = Array.from({ length: 6 }, (_, i) => `## O${i}\n${"o".repeat(130)}`).join("\n");
    writeFileSync(join(root, "customers", "aiotlab.plan-guide.md"), overlay);

    const guide = loadGuide(root, "aiotlab");
    expect((guide.match(/^## O\d/gm) ?? []).length).toBe(6); // all of them
    expect(guide.length).toBeLessThanOrEqual(Number(process.env.HIVE_GUIDE_BUDGET_CHARS ?? 1200));
  });

  it("guarantees the customer overlay room even behind a long house guide", () => {
    const houseSection = (n: number) => `## House ${n}\n${"h".repeat(150)}`;
    writeFileSync(
      join(root, "customers", "plan-guide.md"),
      Array.from({ length: 20 }, (_, i) => houseSection(i)).join("\n"),
    );
    writeFileSync(join(root, "customers", "aiotlab.plan-guide.md"), "## Lab\nlab-specific rule");

    // Trimming the joined text would drop the overlay first, since it comes last.
    const guide = loadGuide(root, "aiotlab");
    expect(guide).toContain("lab-specific rule");
    expect(guide.length).toBeLessThanOrEqual(Number(process.env.HIVE_GUIDE_BUDGET_CHARS ?? 1200));
  });

  it("ships seeded guides that fit the budget without losing a section", () => {
    // Guards against the real files quietly outgrowing the budget: a dropped
    // "## Tools" section would silently cost tokens on every future turn.
    const repoRoot = join(import.meta.dirname, "..", "..", "..");
    const guide = loadGuide(repoRoot, "aiotlab");
    for (const heading of ["## Tools", "## Decomposition", "## Skills", "## Conventions", "## Tools here", "## Confidential"]) {
      expect(guide).toContain(heading);
    }
  });
});
