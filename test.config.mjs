import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const outfile = ".test-bundle.cjs";

try {
  await esbuild.build({
    entryPoints: ["tests/foundation.test.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile,
    logLevel: "warning"
  });
  const result = spawnSync(process.execPath, ["--test", outfile], {
    cwd: process.cwd(),
    stdio: "inherit"
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outfile, { force: true });
}
