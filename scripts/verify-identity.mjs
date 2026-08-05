import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const banned = [
  new RegExp(["W", "est Blue Bell"].join(""), "i"),
  new RegExp(["westblue", "bell\\.com"].join(""), "i"),
  new RegExp(["\\b", "f", "football", "\\b"].join(""), "i"),
  new RegExp(["BB", "_Football"].join(""), "i"),
  new RegExp(["richey", "1406-prog"].join(""), "i"),
];

const files = execFileSync("git", ["ls-files", "-z"])
  .toString("utf8")
  .split("\0")
  .filter((file) => file && !file.startsWith("docs/superpowers/"));

const forbiddenTrackedPaths = new Set([
  "seed/franchises.json",
  "seed/managers.json",
  "seed/corrections/corrections.json",
]);
const trackedData = files.filter((file) => forbiddenTrackedPaths.has(file));
if (trackedData.length) throw new Error("Private league seed tracked: " + trackedData.join(", "));

const violations = files.flatMap((file) => {
  const contents = readFileSync(file).toString("utf8");
  return banned
    .filter((pattern) => pattern.test(`${file}\n${contents}`))
    .map((pattern) => `${file}: ${pattern}`);
});

if (violations.length > 0) {
  console.error("Forbidden source identity found:\n" + violations.join("\n"));
  process.exitCode = 1;
}
