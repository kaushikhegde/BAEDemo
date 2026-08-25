import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

// Every integration test talks to the SAME real, shared Azurite instance —
// one job-queue, one jobs table, one set of containers. Vitest's default
// file-level parallelism races them: test/worker.int.test.ts is the first
// suite to CONSUME messages from job-queue (drainQueue, runOnce's own
// receives), while test/start-job.int.test.ts and test/mcp-server.int.test.ts
// concurrently PRODUCE to and count messages on that same queue — running
// them in parallel loses messages one file thought it owned. fileParallelism
// is off here so `npm run test:integration` (what a person or CI actually
// runs) is trustworthy without anyone having to remember a flag.
//
// `include` is set explicitly rather than left to a CLI positional filter:
// Vitest's `run [...filters]` args are testNamePattern-style substring
// matches against whatever `include` already discovered, not globs resolved
// against the filesystem — `vitest run 'test/*.int.test.ts'` matches
// nothing (no discovered path literally contains an asterisk), and the
// previous unquoted form only ever worked because the SHELL pre-expanded it
// to every filename before vitest saw it — which is exactly what defeated
// `-- <name>` as a per-file filter: every file was already named explicitly,
// so appending one more name narrowed nothing.
export default mergeConfig(base, defineConfig({
  test: {
    include: ["test/*.int.test.ts"],
    fileParallelism: false,
  },
}));
