import { builtinModules } from "node:module";
import { defineConfig } from "tsdown";

const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

export default defineConfig({
  entry: ["./src/server.ts"],
  outDir: "./dist",
  format: "esm",
  platform: "node",
  target: "node22",
  clean: true,
  sourcemap: true,
  dts: false,
  deps: {
    alwaysBundle: [/.*/],
    neverBundle: nodeBuiltins,
  },
});
