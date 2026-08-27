import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

// Same reasoning as vitest.integration.config.ts: the acceptance suite also
// runs against real, shared infrastructure (LocalStack plus the live
// orchestrator/worker containers), so it gets the same explicit `include`
// and sequential file execution rather than Vitest's parallel default.
export default mergeConfig(base, defineConfig({
  test: {
    include: ["test/*.acc.test.ts"],
    fileParallelism: false,
  },
}));
