import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy API calls to the Fastify server during local dev.
    proxy: {
      "/healthz": "http://localhost:3000",
    },
  },
});
