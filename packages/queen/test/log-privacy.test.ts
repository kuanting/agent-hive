import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The hive's confidentiality promise is enforced on the execution path: work
 * marked confidential is routed only to capabilities that keep it on the machine.
 * Narration is the side door. An AgentLog carrying the prompt would publish that
 * same content to the broker and on into every open browser tab — defeating the
 * guarantee from the direction nobody is watching, because a log line looks
 * harmless right up until it isn't.
 *
 * So the rule is: log identifiers and decisions, never content. This test is a
 * regression fence around it. It is a source scan rather than a behavioral test
 * on purpose — the risk is a future call site interpolating the wrong variable,
 * and that is a property of the code, not of any one run.
 */

const FILES = [
  "../../worker/src/index.ts",
  "../src/core.ts",
].map((rel) => ({ rel, src: readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8") }));

/** Expressions that carry user or model content rather than identifiers. */
const FORBIDDEN = [
  /\bspec\.input\b/,
  /\bspec\.title\b/,
  /\bmsg\.spec\.input\b/,
  /\.output\b/,
  /\bprompt\b/,
  /\bexec\.output\b/,
  /\bresult\.error\b/,
];

/**
 * Every argument list passed to a narration call, matched by counting parens so
 * multi-line calls are captured whole. Crude, and that is fine: it only has to
 * see the text, not understand it.
 */
function narrationCalls(src: string): string[] {
  const calls: string[] = [];
  for (const opener of ["log(", "this.say("]) {
    let from = 0;
    for (;;) {
      const start = src.indexOf(opener, from);
      if (start === -1) break;
      from = start + opener.length;
      // skip declarations like `function log(` or `const log = (`
      const before = src.slice(Math.max(0, start - 12), start);
      if (/\b(function|const|let|type)\s*$/.test(before)) continue;
      let depth = 1;
      let i = from;
      while (i < src.length && depth > 0) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        i++;
      }
      calls.push(src.slice(from, i - 1));
    }
  }
  return calls;
}

describe("narration never carries content", () => {
  for (const { rel, src } of FILES) {
    it(`${rel} logs identifiers, not prompts or outputs`, () => {
      const offenders = narrationCalls(src).filter((call) => FORBIDDEN.some((re) => re.test(call)));
      expect(offenders).toEqual([]);
    });
  }

  it("the scanner actually finds the calls it is meant to guard", () => {
    // Without this, a refactor that renamed the helper would make the test above
    // pass by finding nothing at all.
    const found = FILES.flatMap(({ src }) => narrationCalls(src));
    expect(found.length).toBeGreaterThan(10);
  });

  it("the scanner would catch a violation", () => {
    const bad = narrationCalls(`log("info", \`ran: \${spec.input}\`, msg.taskId);`);
    expect(bad.some((c) => FORBIDDEN.some((re) => re.test(c)))).toBe(true);
  });
});
