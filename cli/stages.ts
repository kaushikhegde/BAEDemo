// The stage catalogue, read from the server rather than from the repository.
//
// This replaces `import * as pipeline from "../scripts/pipeline.mjs"` — the
// single line that tied the CLI to a checkout of this repository. Everything
// else in cli/ is `node:` builtins and global `fetch`, so cutting it is what
// lets the CLI ship on its own (see scripts/build-cli.mjs).
//
// Reading it from `GET /config` is not merely a packaging convenience, it is
// more correct. "What can I run" is a fact about the SERVER being asked, and a
// CLI carrying its own copy would answer for the version it was published at:
// it would refuse a stage the server had gained since, which is precisely the
// failure you least want in a tool distributed separately from the engine it
// drives. The same argument CLAUDE.md makes for pipeline.mjs having four
// consumers rather than four copies, extended across the network.
//
// `level` is DERIVED from the parameters a workflow interpolates rather than
// declared: a workflow that reads `{feature}` runs per feature. The engine
// computes that list by scanning each workflow's own templates, so it cannot
// disagree with what the steps actually read.

import type { Client } from "./client.ts";

export interface Stage {
  key: string;
  label: string;
  level: "project" | "feature";
  /** Every variable this workflow interpolates, in first-appearance order. */
  params: string[];
  /** Set on `revise-<stage>`: the stage this is another mode of. */
  variantOf: string | null;
}

/** The subset of `GET /config` this module reads. */
interface ConfigResponse {
  workflows?: Array<{
    key: string;
    label?: string;
    params?: string[];
    variantOf?: string | null;
  }>;
}

export async function fetchStages(client: Client): Promise<Record<string, Stage>> {
  const cfg = await client.get<ConfigResponse>("/config");
  const stages: Record<string, Stage> = {};
  for (const w of cfg.workflows ?? []) {
    if (!w?.key) continue;
    const params = Array.isArray(w.params) ? w.params : [];
    stages[w.key] = {
      key: w.key,
      label: w.label || w.key,
      level: params.includes("feature") ? "feature" : "project",
      params,
      variantOf: w.variantOf ?? null,
    };
  }
  return stages;
}

/**
 * The parameters a caller has to supply, i.e. everything but the two the CLI
 * resolves itself from flags and the pinned target.
 */
export const callerParams = (s: Stage): string[] =>
  s.params.filter(n => n !== "project" && n !== "feature");
