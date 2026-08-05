import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Design mockup bundle — inline-styled prototype HTML + its support.js runtime, explicitly
    // "not part of the design; ignore" per docs/design/redesign-2026-08/README.md. Never
    // application source.
    "docs/**",
    // Other agents' parallel git worktrees, when present under this checkout — never this
    // agent's to read, lint, or fix.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
