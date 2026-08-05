import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";

test("root layout type-checks without generated Next route helpers", () => {
  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "--pretty", "false"], {
    encoding: "utf8",
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
}, 20_000);
