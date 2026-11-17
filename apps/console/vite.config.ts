import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The console talks to the API on the same origin. In development Vite proxies /api to the API server,
// using PORT from the repo-root .env so it follows whatever port the API runs on.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  const apiPort = env.PORT || "3000";
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: false } },
    },
    build: { outDir: "dist", sourcemap: true },
  };
});
