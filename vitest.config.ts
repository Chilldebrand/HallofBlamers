import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "worker/**/*.test.ts", "migration/**/*.test.ts", "supabase/tests/**/*.test.ts", "web/tests/**/*.test.ts", "web/tests/**/*.test.tsx"],
    environment: "node",
  },
});
