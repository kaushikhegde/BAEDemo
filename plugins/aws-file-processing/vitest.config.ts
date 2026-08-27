import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 120_000, // large-file fixtures and LocalStack cold start
    hookTimeout: 120_000,
  },
});
