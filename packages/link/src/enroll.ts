import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { boxToken, LINK_PATH } from "./protocol.js";

/** What a box remembers about its link: where to dial and how to prove who it is. */
export interface LinkCredentials {
  server: string;
  url: string;
  boxId: string;
  token: string;
}

export function credentialsPath(root: string): string {
  return join(root, "data", "link.json");
}

/**
 * Where this box should connect, from the environment first and the enrolled
 * file second. The environment form exists for the demo and for containers,
 * where a file written by an interactive enroll step does not fit.
 */
export function loadCredentials(root: string): LinkCredentials | undefined {
  const url = process.env.HIVE_LINK_URL;
  const token = process.env.HIVE_LINK_TOKEN;
  if (url && token) {
    const boxId = /^hbx_([A-Za-z0-9]+)_/.exec(token)?.[1] ?? "unknown";
    return { server: url.replace(/^ws/, "http").replace(LINK_PATH, ""), url, boxId, token };
  }
  const path = credentialsPath(root);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as LinkCredentials;
}

/**
 * Trade a one-time enrollment code (shown to the owner in iBuddys) for this
 * box's long-lived credential. The secret comes back exactly once; the cloud
 * keeps only its hash, so losing `data/link.json` means enrolling again.
 */
export async function enroll(opts: { server: string; code: string; name?: string; root: string }): Promise<LinkCredentials> {
  const server = opts.server.replace(/\/+$/, "");
  const res = await fetch(`${server}/api/hive-link/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: opts.code.trim(), name: opts.name ?? "Hive Box" }),
  });
  const data = (await res.json().catch(() => ({}))) as { boxId?: string; secret?: string; error?: string };
  if (!res.ok || !data.boxId || !data.secret) {
    throw new Error(`enrollment refused (HTTP ${res.status}): ${data.error ?? "no credential returned"}`);
  }
  const creds: LinkCredentials = {
    server,
    url: `${server.replace(/^http/, "ws")}${LINK_PATH}`,
    boxId: data.boxId,
    token: boxToken(data.boxId, data.secret),
  };
  const path = credentialsPath(opts.root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return creds;
}

/** `npm run link:enroll -- --server https://ibuddys.example --code HIVE-XXXX-XXXX` */
async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const server = get("--server");
  const code = get("--code");
  if (!server || !code) {
    console.error("usage: npm run link:enroll -- --server <https://ibuddys...> --code <HIVE-XXXX-XXXX> [--name <box name>]");
    process.exit(1);
  }
  const root = resolve(process.env.HIVE_ROOT ?? ".");
  const creds = await enroll({ server, code, name: get("--name"), root });
  console.log(`enrolled as box ${creds.boxId}; credential saved to ${credentialsPath(root)}`);
  console.log("start the Queen as usual; it connects to the link on its own.");
}

if (process.argv[1] && /enroll\.(ts|js|mjs)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`[link] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
