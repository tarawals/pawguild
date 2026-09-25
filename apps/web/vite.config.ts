import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 explicitly. Otherwise, on machines where "localhost" resolves to IPv6 (common on
    // macOS/Windows), Vite listens only on ::1 and http://127.0.0.1:5173 refuses to connect.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
