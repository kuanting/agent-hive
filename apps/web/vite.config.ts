import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// vite runs with cwd=apps/web, so point at the repo-root .env explicitly
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const queen = process.env.QUEEN_URL ?? "http://localhost:4100";

/**
 * The console's own key, injected here rather than in the app.
 *
 * Configuring HIVE_API_KEYS is what a shared hive requires, and it is also what
 * used to break this console the same day: `/status` returned 401 to a fetch that
 * sent no Authorization header, and the chat and session routes are gated now
 * too. So the proxy has to supply one.
 *
 * The proxy is not merely the tidiest place for it — it is the only one that
 * works. The Activity feed reads `/events` through `EventSource`, which cannot
 * send a custom header at all, so no amount of app-side code could authenticate
 * that route. Injecting server-side covers all four with one line, and the key
 * never reaches the browser.
 *
 * Named explicitly rather than defaulted to the first entry of HIVE_API_KEYS.
 * Picking a credential out of another variable is the thing the configuration
 * reference argues against for HIVE_BROKER: which one is in force should never
 * have to be inferred. An operator who has not set this gets a 401 whose message
 * names it (see api.ts) — which is the honest outcome, unlike a loopback bypass
 * on /status. That would work, and work invisibly, which is the problem: it
 * re-introduces locality-as-authorization for the one route the Queen
 * deliberately gates, and nobody would ever discover that their production keys
 * are bypassable from the Queen's own host.
 *
 * Dev-server only. A built console is served as static files and talks to
 * whatever fronts it in production.
 */
const consoleKey = process.env.HIVE_CONSOLE_KEY;
const withKey = () => ({
  target: queen,
  changeOrigin: true,
  ...(consoleKey ? { headers: { Authorization: `Bearer ${consoleKey}` } } : {}),
});

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/chat": withKey(),
      "/status": withKey(),
      "/sessions": withKey(),
      "/events": withKey(),
    },
  },
});
