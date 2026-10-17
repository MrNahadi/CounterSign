import { defineConfig } from "drizzle-kit";

// Run from this folder through the root `npm run db:generate` script.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
