// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    // The app imports the engine's browser-safe modules from ../flow/src.
    fs: { allow: [".."] },
    // Another page must not reach the API through this proxy: its Origin
    // stays as sent, so the server refuses it.
    cors: false,
    // No page may frame the app (see the server, which sends the same).
    headers: { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" },
    // `bun run start` serves the API; changeOrigin sends the Host header the
    // server accepts. A request from this app, whose Origin is the dev server's
    // own, gets the server's Origin so its cross-origin check passes.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4807",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            const origin = req.headers.origin;
            if (origin === `http://${req.headers.host}`) proxyReq.setHeader("origin", "http://127.0.0.1:4807");
          });
        },
      },
    },
  },
  preview: { host: "127.0.0.1" },
});
