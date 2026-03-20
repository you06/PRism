import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  // Inline @prism/shared; externalize only Node built-ins
  external: ["node:*"],
};

// CLI entry — the `prism` command
await build({
  ...shared,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
});

// Daemon entry — for `prism server` / programmatic use
await build({
  ...shared,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
});

console.log("Build complete.");
