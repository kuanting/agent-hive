import "@hive/shared/env"; // must stay first: loads .env before env-reading modules initialize
import { loadWorkerConfig } from "./config.js";
import { runWorker } from "./run.js";

/** `npm run worker -- <worker.yaml>`: one bee, configured from a file, until it is told to stop. */
async function main() {
  const configPath = process.argv[2] ?? process.env.WORKER_CONFIG;
  if (!configPath) {
    console.error("usage: npm run worker -- <worker-config.yaml>");
    process.exit(1);
  }
  await runWorker(loadWorkerConfig(configPath));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
