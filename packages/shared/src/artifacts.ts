import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * Minimal artifact store: broker messages and prompts carry paths, not content.
 * PoC backend is a shared directory; production swaps in S3/MinIO behind the
 * same interface.
 */
export class ArtifactStore {
  readonly root: string;

  constructor(root = process.env.HIVE_ARTIFACTS ?? resolve("artifacts")) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  put(content: string | Buffer, name?: string): string {
    const id = name ?? `${randomUUID()}.txt`;
    const path = join(this.root, id);
    writeFileSync(path, content);
    return id;
  }

  get(ref: string): string {
    return readFileSync(join(this.root, ref), "utf8");
  }

  /** stable hash of task input for the Queen's result cache */
  static hashInput(...parts: string[]): string {
    return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
  }
}
