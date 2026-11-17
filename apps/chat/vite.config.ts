import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built once and served by the API: index.html per bot at /w/:publicKey (iframe) and /b/:publicKey (full page),
// hashed assets under /chat/assets/.
export default defineConfig({
  base: "/chat/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", assetsDir: "assets", sourcemap: true },
});
