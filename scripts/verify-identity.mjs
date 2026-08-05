import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const banned = [
  new RegExp(["W", "est Blue Bell"].join(""), "i"),
  new RegExp(["westblue", "bell\\.com"].join(""), "i"),
  new RegExp(["\\b", "f", "football", "\\b"].join(""), "i"),
  new RegExp(["BB", "_Football"].join(""), "i"),
  new RegExp(["richey", "1406-prog"].join(""), "i"),
];

const trackedFiles = execFileSync("git", ["ls-files", "-z"])
  .toString("utf8")
  .split("\0")
  .filter((file) => file && !file.startsWith("docs/superpowers/"));

const violations = trackedFiles.flatMap((file) => {
  const contents = readFileSync(file).toString("utf8");
  return banned
    .filter((pattern) => pattern.test(`${file}\n${contents}`))
    .map((pattern) => `${file}: ${pattern}`);
});

if (violations.length > 0) {
  console.error("Forbidden source identity found:\n" + violations.join("\n"));
  process.exitCode = 1;
}
