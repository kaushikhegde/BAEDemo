// The consumer config for @scyne/orchestrator. This repo is the library's
// first consumer, proving the library/consumer boundary is real: everything
// here is workspace-specific data (the org chart, the workflow) compiled
// from `scripts/pipeline.mjs`, which stays the single source of truth for
// what a stage requires and produces. Nothing under packages/orchestrator/
// is touched to make this work.
//
// Prototype scope: ONE workflow, the `requirements` stage only. No publish
// step — publishing to Confluence during a prototype run would write to a
// real client space. Phase 2 of the spec adds it.

import { defineOrchestrator, createClaudeRunner } from "./packages/orchestrator/src/index.js";
import { STAGES } from "./scripts/pipeline.mjs";

const ORG = [
  { key: "ceo",          name: "CEO",               title: "Chief Executive",    icon: "crown" },
  { key: "pm",           name: "Delivery Lead",      title: "Delivery Lead",      icon: "rocket",        reportsTo: "ceo" },
  { key: "businessLead", name: "Business Lead",      title: "Business Lead",      icon: "lightbulb",     reportsTo: "pm" },
  { key: "archLead",     name: "Architecture Lead",  title: "Architecture Lead",  icon: "circuit-board", reportsTo: "pm" },
  { key: "ba",           name: "BA",                 title: "BA",                 icon: "search",
    reportsTo: "businessLead",
    adapter: "claude_local",
    model: "claude-sonnet-4-6",
    // If Sonnet 4.6 is overloaded mid-run the pipeline should degrade, not stop.
    fallbackModel: ["claude-sonnet-4-5-20250929"],
    bundlePath: "agent-instructions/ba.thin.md", mcpEnabled: true,
    // A ceiling, not a target. One requirements run has never been measured;
    // Task 11 records the real number and this gets set from evidence.
    budget: { maxTokens: 1_000_000, maxCostUsd: 10, maxDurationMs: 30 * 60_000 } },
];

// Prototype scope: the `requirements` stage only.
const stage = STAGES.requirements;

export default defineOrchestrator({
  workspace: process.cwd(),
  company: "Scyne",
  db: { driver: "pglite", dir: ".orchestrator/pgdata" },

  // The adapter registry. One entry today; another project registers its own here.
  adapters: { claude_local: createClaudeRunner() },

  defaults: { adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" },

  org: ORG,
  workflows: [{
    key: "requirements",
    label: stage.label,
    assignee: stage.agentKey,
    steps: [
      { type: "exec",   cmd: `node scripts/stage.mjs {project} "{feature}" requirements` },
      // Reading a full discovery pack and writing 11 sections is the expensive
      // step in this workflow — it is the one worth the reasoning budget.
      //
      // Explicit `prompt` here, rather than the engine's generic default: the
      // skill file (skills/requirement-generator/SKILL.md) contradicts itself
      // on the output path — line 12 says
      // `outputs/product-summaries/PS-<nnn>-<slug>.md`, lines 71 and 138 say
      // the singular `outputs/product-summary.md`. `pipeline.mjs`'s
      // `stage.produces` (what the `attach` step below checks for) uses the
      // singular form, and the skill file is a live production file this
      // config must not edit. Pinning the exact paths here is the fix, in
      // config rather than in the skill.
      { type: "agent",  phase: "generate", skill: stage.skill, effort: "high",
        prompt: `Run the requirements stage for {project} / {feature}.

Inputs are already staged at projects/{project}/{feature}/requirements/.
Invoke the skill: ${stage.skill}

Write your outputs to these EXACT paths — the singular filenames, not a
product-summaries/ subfolder:
  projects/{project}/{feature}/outputs/product-summary.md
  projects/{project}/{feature}/outputs/stories.json
  projects/{project}/{feature}/outputs/stories.md
  projects/{project}/{feature}/outputs/extraction.json
  projects/{project}/{feature}/outputs/gaps.md

Do not call any API, set any status, or raise any approval. Exit when the files are written.` },
      // `stage.produces` paths are relative to the STAGE'S OWN LEVEL ROOT
      // (scripts/pipeline.mjs's own header comment), which for a feature
      // stage is `projects/<project>/<feature>/` — not the workspace root.
      // Task 11's real run proved this the hard way: with the bare
      // `stage.produces` array, `attach` resolved against `config.workspace`
      // directly and looked for a nonexistent `<repo-root>/outputs/…`, so it
      // blocked the issue even though the agent had written both files to
      // the correct project/feature path.
      { type: "attach", files: stage.produces.map(f => `projects/{project}/{feature}/${f}`) },
      { type: "gate",   title: `Approve ${stage.label} — {project} / {feature}` },
    ],
  }],
});
