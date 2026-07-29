import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// vite runs with cwd=apps/web, so point at the repo-root .env explicitly
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const queen = process.env.QUEEN_URL ?? "http://localhost:4100";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/chat": { target: queen, changeOrigin: true },
      "/status": { target: queen, changeOrigin: true },
      "/sessions": { target: queen, changeOrigin: true },
      "/events": { target: queen, changeOrigin: true },
    },
  },
});
