import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const tauriDevHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: tauriDevHost || false,
    hmr: tauriDevHost ? { protocol: "ws", host: tauriDevHost, port: 5174 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022", sourcemap: false },
  test: { environment: "jsdom", include: ["tests/**/*.test.ts"] },
});
