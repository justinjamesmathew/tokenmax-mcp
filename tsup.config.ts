import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli-entry.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  shims: false,
  splitting: false,
});
