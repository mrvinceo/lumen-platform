import { defineConfig } from "tsup";

// One small classic script for customers' sites: no modules, no dependencies.
export default defineConfig({
  entry: { widget: "src/widget.ts" },
  format: ["iife"],
  target: "es2020",
  minify: true,
  sourcemap: false,
  clean: true,
  outExtension: () => ({ js: ".js" }),
});
