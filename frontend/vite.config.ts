import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard ships inside pi_hive, so it shows pi_hive's own version (package.json),
// read from the repo root so the UI never depends on anything outside this repo.
const HIVE_VERSION = JSON.parse(
  readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
).version;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(HIVE_VERSION),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.PI_HIVE_PORT || 8790}`,
        changeOrigin: true,
      },
    },
  },
});
