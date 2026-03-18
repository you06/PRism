import { mkdirSync, rmSync } from "node:fs";
import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(__dirname, "..");
const repoRoot = resolve(extensionDir, "..");
const distDir = resolve(extensionDir, "dist");

function resolveEsbuildBin() {
  const matches = globSync(
    resolve(
      repoRoot,
      "node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild",
    ),
  ).sort();

  const bin = matches.at(-1);
  if (!bin) {
    throw new Error("esbuild binary not found under node_modules/.pnpm");
  }
  return bin;
}

function build(entryPoint, outfile, format) {
  execFileSync(
    resolveEsbuildBin(),
    [
      entryPoint,
      "--bundle",
      "--platform=browser",
      `--format=${format}`,
      "--target=es2022",
      "--sourcemap",
      "--log-level=info",
      `--outfile=${outfile}`,
    ],
    {
      cwd: extensionDir,
      stdio: "inherit",
    },
  );
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

build("src/background.ts", "dist/background.js", "esm");
build("src/content.ts", "dist/content.js", "iife");
