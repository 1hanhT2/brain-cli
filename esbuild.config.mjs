import esbuild from "esbuild";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { normalizeTextAsset } from "./build-text.mjs";

const isProduction = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: isProduction ? false : "inline",
  treeShaking: true,
  loader: {
    ".md": "text",
    ".yaml": "text"
  },
  plugins: [{
    name: "normalize-bundled-text",
    setup(build) {
      build.onLoad({ filter: /\.(?:md|yaml)$/ }, async ({ path }) => ({
        contents: normalizeTextAsset(await readFile(path, "utf8")),
        loader: "text"
      }));
    }
  }],
  outfile: "main.js",
  minify: isProduction
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
