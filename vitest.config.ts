import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*", { test: { name: "repo", include: ["tests/**/*.test.ts"] } }],
  },
});
