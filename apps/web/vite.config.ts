import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const queen = process.env.QUEEN_URL ?? "http://localhost:4100";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/chat": { target: queen, changeOrigin: true },
      "/status": { target: queen, changeOrigin: true },
      "/sessions": { target: queen, changeOrigin: true },
    },
  },
});
