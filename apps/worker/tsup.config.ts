import { defineConfig } from "tsup";

// Workspace packages ship TypeScript source, so they are bundled in. Every npm package, including the
// dependencies of workspace packages, stays external and is installed by `pnpm deploy` (see Dockerfile).
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  noExternal: [/^@lumen\//],
  external: [/^(?!@lumen\/)[^./]/],
});
