import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The session cookie (`rid`) is httpOnly, so the browser must send it automatically.
// We keep the client same-origin with the Fastify server by proxying every API surface
// (REST + the `/ws` upgrade) to it during local dev. Production serves the built assets
// from the same origin as the API, so no proxy is needed there.
const API_ORIGIN = process.env.VITE_API_ORIGIN ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/healthz": API_ORIGIN,
      "/livez": API_ORIGIN,
      "/readyz": API_ORIGIN,
      "/auth": API_ORIGIN,
      "/me": API_ORIGIN,
      "/workspaces": API_ORIGIN,
      "/channels": API_ORIGIN,
      // Approval request/decision/audit routes are top-level (not under /workspaces) — #13/#18.
      "/approvals": API_ORIGIN,
      // WebSocket gateway — `ws: true` proxies the HTTP upgrade so the rid cookie rides along.
      "/ws": { target: API_ORIGIN, ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
