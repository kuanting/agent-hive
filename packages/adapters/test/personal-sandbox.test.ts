import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listMailbox,
  listPersonalDir,
  readPersonalFile,
  safeResolve,
  SandboxError,
  searchMailbox,
  walkFiles,
} from "../src/index.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "personal-root-"));
  outside = mkdtempSync(join(tmpdir(), "personal-outside-"));
  mkdirSync(join(root, "documents"));
  writeFileSync(join(root, "documents", "note.md"), "meeting notes about the yield model");
  writeFileSync(join(outside, "secret.txt"), "should never be reachable");
  writeFileSync(
    join(root, "mailbox.json"),
    JSON.stringify({
      messages: [
        { id: "1", from: "a@x", subject: "Yield model status", body: "accuracy is 0.912" },
        { id: "2", from: "b@x", subject: "Lunch", body: "want to grab lunch?" },
      ],
    }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("safeResolve", () => {
  it("resolves a plain relative path inside the root", () => {
    expect(safeResolve(root, "documents/note.md")).toContain("note.md");
  });

  it("rejects ../ traversal", () => {
    expect(() => safeResolve(root, "../secret.txt")).toThrow(SandboxError);
  });

  it("rejects absolute paths", () => {
    expect(() => safeResolve(root, "/etc/passwd")).toThrow(SandboxError);
    expect(() => safeResolve(root, join(outside, "secret.txt"))).toThrow(SandboxError);
  });

  it("rejects an empty path", () => {
    expect(() => safeResolve(root, "")).toThrow(SandboxError);
  });

  it("rejects a symlink that escapes the root", () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    expect(() => safeResolve(root, "link.txt")).toThrow(SandboxError);
  });
});

describe("reads", () => {
  it("reads a file inside the sandbox", () => {
    expect(readPersonalFile(root, "documents/note.md")).toContain("yield model");
  });

  it("refuses to read outside the sandbox", () => {
    expect(() => readPersonalFile(root, "../../etc/hosts")).toThrow(SandboxError);
  });

  it("lists a directory", () => {
    const names = listPersonalDir(root).map((e) => e.name).sort();
    expect(names).toContain("documents");
    expect(names).toContain("mailbox.json");
  });

  it("walks files with relative paths", () => {
    const files = walkFiles(root);
    expect(files).toContain("mailbox.json");
    expect(files).toContain("documents/note.md");
  });
});

describe("mailbox", () => {
  it("lists all messages", () => {
    expect(listMailbox(root)).toHaveLength(2);
  });

  it("searches case-insensitively and ranks by term hits", () => {
    const hits = searchMailbox(root, "yield accuracy");
    expect(hits[0].subject).toBe("Yield model status");
  });

  it("returns an empty inbox for a missing or malformed file, never throwing", () => {
    writeFileSync(join(root, "mailbox.json"), "not json at all");
    expect(listMailbox(root)).toEqual([]);
    expect(searchMailbox(root, "anything")).toEqual([]);
  });
});
