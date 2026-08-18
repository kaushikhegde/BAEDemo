import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import http from "node:http";
import { WebSocketServer, WebSocket as WSWebSocket } from "ws";
import { chat } from "./llm.js";
// The local binding stays `paperclip` on purpose: 33 call sites below, none
// of which needed to change when the backend did. Renaming it and swapping
// the backend in one pass would be two bugs wearing one coat.
import { orchestrator as paperclip } from "./orchestrator.js";
import type { RequirementParams } from "./types.js";
import { routeFile, uniqueName, requirementsDir, type Hint } from "./services/fileRouter.js";
import { WORKSPACE_PATH } from "./workspace.js";
import { ensureAtlassianTargets, provisioningConfigured } from "./services/atlassianProvision.js";
import { filterRunLog, type TranscriptEvent } from "./services/runTranscript.js";
import { writeTranscript } from "./services/transcriptWriter.js";
import { transcribeAudioFile } from "./services/geminiFiles.js";
import { MeetingSession } from "./services/geminiLive.js";
// The pipeline graph lives in scripts/ because the CLI, the renderer and this
// server all need the same answer to "what does this stage require". Importing
// it here rather than restating it is what stops the chatbot refusing a stage
// the CLI would happily run.
// @ts-expect-error — plain ESM with JSDoc types; no .d.ts and none warranted.
import * as pipeline from "../../scripts/pipeline.mjs";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Pull Confluence page + Jira issue URLs out of a set of comment bodies.
// Shared by /api/status (single run) and /api/history (all completed runs).
function extractLinks(bodies: string[]): { confluence: string[]; jira: string[] } {
  const confluenceRe = /https?:\/\/[\w.-]+\.atlassian\.net\/wiki\/[^\s)>\]"']+/g;
  const jiraRe = /https?:\/\/[\w.-]+\.atlassian\.net\/browse\/[A-Z]+-\d+/g;
  const confluence = new Set<string>();
  const jira = new Set<string>();
  for (const body of bodies) {
    for (const m of body.matchAll(confluenceRe)) confluence.add(m[0]);
    for (const m of body.matchAll(jiraRe)) jira.add(m[0]);
  }
  return { confluence: [...confluence], jira: [...jira].sort() };
}

// 1. Chat — proxy to Gemini. `target` (optional) is the current target picker
//    selection in the UI; we forward it so the LLM stops re-asking when the
//    user has already selected a project/feature.
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, target, uiContext } = req.body;
    const result = await chat(messages, target, uiContext);
    res.json(result);
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// 2. Trigger — create a Paperclip issue from a parameter bundle
app.post("/api/trigger", async (req, res) => {
  try {
    const overrides = (req.body ?? {}) as Partial<RequirementParams> & {
      feature_name?: string;
      project?: string;
      feature?: string;
    };
    const feature_name = overrides.feature_name || process.env.DEFAULT_FEATURE_NAME || "Untitled Feature";
    const project = overrides.project || "SADA";
    const feature = overrides.feature || "interim-benefit";
    // Default the Jira project + Confluence space keys to the PROJECT name, not a
    // fixed .env value — so picking "RTWSA" pushes to RTWSA, not SADA. The .env
    // DEFAULT_* keys (and the parent epic) only apply when they belong to THIS
    // project (the original SADA demo). The BA verifies these exist before pushing.
    const projectKey = deriveProjectKey(project);
    const envIsThisProject = (process.env.DEFAULT_JIRA_PROJECT_KEY || "").toUpperCase() === projectKey;
    const params: RequirementParams = {
      process_l3: overrides.process_l3 || process.env.DEFAULT_PROCESS_L3,
      process_l4: overrides.process_l4 || process.env.DEFAULT_PROCESS_L4,
      starting_story_number: overrides.starting_story_number || process.env.DEFAULT_STARTING_STORY_NUMBER,
      parent_epic_key: overrides.parent_epic_key || (envIsThisProject ? process.env.DEFAULT_PARENT_EPIC_KEY : ""),
      jira_project_key: overrides.jira_project_key || projectKey,
      confluence_space_key: overrides.confluence_space_key || projectKey,
      confluence_page_title: overrides.confluence_page_title || (envIsThisProject ? process.env.DEFAULT_CONFLUENCE_PAGE_TITLE : feature_name),
    };
    const ws = WORKSPACE_PATH;

    // Pre-flight: the BA needs at least one file in SOP and Transcripts.
    // Notes and UI are OPTIONAL (mirrors the BA's own validation) — UI screens are
    // a nice-to-have, not a gate. Block + tell the user exactly what's missing
    // rather than firing a run that the BA will just block.
    const reqRoot = path.join(ws, "projects", project, feature, "requirements");
    const countFiles = async (sub: string) => {
      try {
        const entries = await fs.readdir(path.join(reqRoot, sub), { withFileTypes: true });
        return entries.filter((e) => e.isFile() && !e.name.startsWith(".")).length;
      } catch { return 0; }
    };
    const required = ["SOP", "Transcripts"];
    const counts = await Promise.all(required.map(countFiles));
    const emptyFolders = required.filter((_, i) => counts[i] === 0);
    if (emptyFolders.length > 0) {
      return res.status(409).json({
        error: "missing_inputs",
        emptyFolders,
        message: `Can't generate requirements for ${project}/${feature} yet — these input folders are empty: ${emptyFolders.join(", ")}. Upload at least one file to each (use the attach button), then try again.`,
      });
    }

    // Clear stale BA outputs from a prior run. The BA's Phase 1 vs Phase 2 branch
    // logic keys off "no work-products yet" — leftover files in outputs/ confuse
    // the agent's decision and can send it into a re-detect loop. We wipe the
    // CONTENTS of outputs/ (not the folder itself, so the BA doesn't have to
    // recreate it). Pure files only — never touch subdirectories or the parent.
    // The downstream stages' approved artefacts live under solutions/ (a sibling
    // of outputs/), so this wipe can never destroy them.
    const outputsDir = path.join(ws, "projects", project, feature, "outputs");
    try {
      await fs.mkdir(outputsDir, { recursive: true });
      const stale = (await fs.readdir(outputsDir, { withFileTypes: true })).filter(
        (e) => e.isFile() && !e.name.startsWith("."),
      );
      await Promise.all(stale.map((e) => fs.rm(path.join(outputsDir, e.name), { force: true })));
      console.log(`[trigger] cleared ${stale.length} stale output(s) from ${outputsDir}`);
    } catch (e: any) {
      console.warn(`[trigger] couldn't clear outputs ${outputsDir}: ${e?.message ?? e}`);
    }

    const description = [
      `Generated by the Scyne chatbot. Please produce the Product Summary and Jira user stories.`,
      ``,
      `## Project + Feature`,
      `- Project: ${project}`,
      `- Feature: ${feature}`,
      ``,
      `## Parameters`,
      `- Process L3: ${params.process_l3}`,
      `- Process L4: ${params.process_l4}`,
      `- Starting story number: ${params.starting_story_number}`,
      `- Parent epic key: ${params.parent_epic_key || "(none — create stories without a parent epic)"}`,
      `- Jira project key: ${params.jira_project_key}`,
      `- Confluence space key: ${params.confluence_space_key}`,
      `- Confluence page title: ${params.confluence_page_title}`,
      ``,
      `## Inputs`,
      `Read every file in every subfolder of:`,
      `\`${ws}/projects/${project}/${feature}/requirements/\``,
      ``,
      `Subfolders: SOP/, Transcripts/, Notes/, UI/.`,
    ].join("\n");

    const owner = ownerFor("requirements");
    const issue = await paperclip.createIssue(
      `Generate requirements — ${feature_name} (${project}/${feature})`,
      description,
      owner.assignee,
    );
    res.json({ ...issue, worker: owner.worker, direct: owner.direct });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// One flow per top-level issue, classified by title prefix. This is the single
// source of truth for flow detection — /api/status (stage labels), /api/history
// (which runs to list), and anything else that needs to know which worker owns
// an issue derive from here, so a new stage is added in ONE place.
type Flow = {
  key: "requirements" | "data_model" | "solution_design" | "solution_architecture" | "test_cases" | "capability_map" | "personas" | "ui_mockups" | "ui" | "project_setup" | "revision";
  worker: string;
  generatingLabel: string;
  pushingLabel: string;
};
const FLOWS: { prefix: string; flow: Flow }[] = [
  // Order matters: classifyFlow takes the FIRST prefix that matches, so the
  // project-setup and revision prefixes are listed before the Generate ones.
  { prefix: "Set up project", flow: { key: "project_setup", worker: "Capabilities Process Architect", generatingLabel: "Building the project baseline", pushingLabel: "Finalising the baseline" } },
  // The one-pass replacement for "Set up project". The old prefix stays above so
  // issues created before this change still get a sensible stage label.
  { prefix: "Generate project baseline", flow: { key: "project_setup", worker: "Capabilities Process Architect", generatingLabel: "Building the project baseline", pushingLabel: "Publishing both pages" } },
  { prefix: "Revise", flow: { key: "revision", worker: "the owning specialist", generatingLabel: "Revising the artefact", pushingLabel: "Updating Confluence" } },
  { prefix: "Generate requirements", flow: { key: "requirements", worker: "BA", generatingLabel: "BA generating artifacts", pushingLabel: "Pushing to Atlassian" } },
  { prefix: "Generate data model", flow: { key: "data_model", worker: "Data Modeler", generatingLabel: "Data Modeler generating the impact analysis", pushingLabel: "Publishing to Confluence" } },
  { prefix: "Generate solution design", flow: { key: "solution_design", worker: "Architecture Lead", generatingLabel: "Architecture Lead designing the solution", pushingLabel: "Publishing to Confluence" } },
  // NOTE: "Generate solution design" and "Generate solution architecture" share
  // their first two words. classifyFlow uses startsWith on the FULL prefix, so
  // they resolve correctly — but never shorten either prefix to "Generate
  // solution", and keep both spelled out in the Delivery Lead's classifier too.
  { prefix: "Generate solution architecture", flow: { key: "solution_architecture", worker: "Solution Architect", generatingLabel: "Solution Architect designing the target architecture", pushingLabel: "Publishing to Confluence" } },
  { prefix: "Generate test cases", flow: { key: "test_cases", worker: "QA Architect", generatingLabel: "QA Architect designing the test pack", pushingLabel: "Publishing to Confluence" } },
  // The capability map publishes to its own Confluence page, so "pushing" here is
  // a real publish step rather than a local finalise pass.
  { prefix: "Generate capability map", flow: { key: "capability_map", worker: "Capabilities Process Architect", generatingLabel: "Capabilities Process Architect mapping capabilities + process", pushingLabel: "Publishing to Confluence" } },
  { prefix: "Generate personas", flow: { key: "personas", worker: "Service Designer", generatingLabel: "Service Designer identifying personas + mapping journeys", pushingLabel: "Publishing to Confluence" } },
  // "Generate UI mockups" (UX Designer → wireframes) and "Build UI" (Developer →
  // the companion app page) are different deliverables that both mention UI.
  // classifyFlow matches on the full prefix, so they resolve — but never shorten
  // either, and keep both spelled out in the Delivery Lead's classifier too.
  // Mockups publish nothing, so the "pushing" label covers the local finalise pass.
  { prefix: "Generate UI mockups", flow: { key: "ui_mockups", worker: "UX Designer", generatingLabel: "UX Designer designing the screens", pushingLabel: "Finalising the mockups" } },
  { prefix: "Build UI", flow: { key: "ui", worker: "Developer", generatingLabel: "Developer building the UI", pushingLabel: "Finalising the build" } },
];
function classifyFlow(title: string): Flow {
  return FLOWS.find((f) => title.startsWith(f.prefix))?.flow ?? FLOWS[0].flow;
}

// Jira project / Confluence space key derived from the project name — must stay
// byte-identical between the requirements stage (which provisions the space) and
// the downstream stages (which publish into it).
function deriveProjectKey(project: string): string {
  return String(project).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "SADA";
}

// Count the `.md` documents a stage can read for a feature: everything under
// projects/<p>/<f>/ except the generated trees (outputs/, solutions/, design/).
// For a standard feature that's requirements/{SOP,Transcripts,Notes}; a feature
// carrying its own reference document tree (e.g. companion/docs-md/*) counts too.
// Agents read markdown, so `md` is what actually counts — but `other` lets the
// refusal distinguish "this feature is empty" from "the sources are still
// .docx/.pdf and were never converted", which are different user actions.
const SKIP_DIRS = new Set(["outputs", "solutions", "design", "node_modules"]);
/**
 * Directories under projects/<project>/ that belong to the PROJECT, not to a
 * feature. Kept in step with PROJECT_OWN_DIRS in scripts/pipeline.mjs — the CLI
 * and the chatbot must agree on what a feature is.
 */
const PROJECT_OWN_DIRS = new Set(["solutions", "documents", "design", "original-files", "outputs"]);

async function countFeatureDocs(project: string, feature: string): Promise<{ md: number; other: number }> {
  const root = path.join(WORKSPACE_PATH, "projects", project, feature);
  let md = 0;
  let other = 0;
  async function walk(dir: string, depth: number) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        if (e.name.toLowerCase().endsWith(".md")) md++;
        else other++;
      }
    }
  }
  await walk(root, 0);
  return { md, other };
}

/**
 * Every readable document the PROJECT has: its own `documents/` tree plus every
 * feature's discovery documents. The project-level stages read all of it, so
 * the gate has to see all of it too — a project whose documents all live under
 * features must not be told it has none.
 */
async function countProjectDocs(project: string): Promise<{ md: number; other: number }> {
  const root = path.join(WORKSPACE_PATH, "projects", project);
  let total = { md: 0, other: 0 };
  const add = (d: { md: number; other: number }) => { total.md += d.md; total.other += d.other; };

  let entries: any[] = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return total; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (e.name === "documents") { add(await countFeatureDocs(project, "documents")); continue; }
    if (SKIP_DIRS.has(e.name) || e.name === "solutions" || e.name === "design" || e.name === "original-files") continue;
    add(await countFeatureDocs(project, e.name));
  }
  return total;
}

// 2b/2c/2d. The downstream stages (data model, solution design, capability map)
// share one trigger shape: validate target → run the stage's pre-flight (a
// prerequisite artefact on disk, or — when the stage has no prerequisite — that
// the feature has documents at all) → create a title-prefixed issue for the
// Delivery Lead to route. No Jira parameters; the Confluence space key is
// carried only by the stages that publish.
/**
 * Who should own this issue.
 *
 * Single-worker flows go STRAIGHT to their worker: the Delivery Lead's only
 * contribution to them was to create one child and exit, at 2-3 extra agent
 * wakes per flow, each re-reading its 10k-token instruction bundle. Its
 * input validation duplicated the 409 gate these endpoints already apply
 * before the issue is created at all.
 *
 * Under the orchestrator the assignee is decided by the workflow itself, so
 * this is now only about the human-readable `worker` label the chat replies
 * with. `agentId()` returns the key it is given, so the fallback branch below
 * is unreachable for any stage that declares an `agentKey` — it stays for a
 * stage that declares none.
 */
function ownerFor(stageKey: string): { assignee: string | undefined; worker: string; direct: boolean } {
  const def = (pipeline.STAGES as Record<string, any>)[stageKey];
  const id = def?.agentKey ? paperclip.agentId(def.agentKey) : null;
  if (!id) {
    if (def?.agentKey) {
      console.warn(`[dispatch] stage '${stageKey}' has no agentKey in pipeline.mjs — the workflow's own assignee still applies.`);
    }
    return { assignee: undefined, worker: def?.agent ?? "the owning specialist", direct: false };
  }
  return { assignee: id, worker: def.agent, direct: true };
}

function stageTrigger(stage: {
  logTag: string;
  // The pipeline-graph key for this stage. Resolves the owning worker so the
  // issue is assigned to it directly instead of routed via the Delivery Lead.
  stageKey: string;
  titlePrefix: string; // must match a FLOWS prefix + the Delivery Lead's classifier
  intro: string;
  // PROJECT stages (capability map, personas) describe the client organisation
  // and carry no feature: their gate reads every document the project has, and
  // their issue title and description name only the project.
  level?: "project" | "feature";
  // A stage either gates on a prerequisite file (data model, solution design) or
  // omits it entirely (capability map) and gates on "the feature has documents".
  // One path, or several of which ANY satisfies the gate. The alternatives
  // matter for the data model: `salesforce-data-model.md` is what the current
  // skill writes, `datamodel-impact.md` is what the retired one wrote, and a
  // feature carrying only the older artefact must still pass.
  gateFile?: string | string[]; // path(s) relative to projects/<p>/<f>/
  gateErrorCode: string;
  // `docs` is only populated for stages with no gateFile — it lets the message
  // say WHY the feature has nothing readable.
  gateMessage: (project: string, feature: string, docs?: { md: number; other: number }) => string;
  confluence?: boolean; // include the Confluence space key in the description
  inputs: (project: string, feature: string) => string[];
}) {
  const isProject = stage.level === "project";
  return async (req: express.Request, res: express.Response) => {
    try {
      const project = String(req.body?.project || "").trim();
      // A project stage ignores any feature the caller sends: the artefact
      // describes the client, not one slice of work.
      const feature = isProject ? "" : String(req.body?.feature || "").trim();
      if (!project || (!isProject && !feature)) {
        return res.status(400).json({
          error: "missing_target",
          message: isProject ? "project is required" : "project and feature are required",
        });
      }
      if (isProject) assertSafeProject(project); else assertSafeProjectFeature(project, feature);

      const gateRoot = isProject
        ? path.join(WORKSPACE_PATH, "projects", project)
        : path.join(WORKSPACE_PATH, "projects", project, feature);

      if (stage.gateFile) {
        const candidates = Array.isArray(stage.gateFile) ? stage.gateFile : [stage.gateFile];
        let satisfied = false;
        for (const c of candidates) {
          try {
            await fs.access(path.join(gateRoot, c));
            satisfied = true;
            break;
          } catch { /* try the next alternative */ }
        }
        if (!satisfied) {
          return res.status(409).json({ error: stage.gateErrorCode, message: stage.gateMessage(project, feature) });
        }
      } else {
        const docs = isProject ? await countProjectDocs(project) : await countFeatureDocs(project, feature);
        if (docs.md === 0) {
          return res.status(409).json({ error: stage.gateErrorCode, ...docs, message: stage.gateMessage(project, feature, docs) });
        }
      }
      // Display name defaults to the feature folder; space key to the project
      // name (same derivation as /api/trigger). Both overridable via the body
      // for runs whose requirements used custom values.
      const feature_name = String(req.body?.feature_name || "").trim() || feature;
      const confluence_space_key = String(req.body?.confluence_space_key || "").trim() || deriveProjectKey(project);
      // Only stages that publish carry Atlassian keys — /api/approve keys its
      // auto-provisioning off the "Confluence space key" line, so a local-only
      // stage must not emit one or approval would try to create a space.
      const description = [
        stage.intro,
        ``,
        isProject ? `## Project` : `## Project + Feature`,
        `- Project: ${project}`,
        ...(isProject ? [] : [
          `- Feature: ${feature}`,
          `- Feature name: ${feature_name}`,
        ]),
        ...(stage.confluence === false ? [] : [
          ``,
          `## Parameters`,
          `- Confluence space key: ${confluence_space_key}`,
        ]),
        ``,
        `## Inputs`,
        ...stage.inputs(project, feature),
      ].join("\n");
      const title = isProject
        ? `${stage.titlePrefix} — ${project}`
        : `${stage.titlePrefix} — ${feature_name} (${project}/${feature})`;
      const owner = ownerFor(stage.stageKey);
      const issue = await paperclip.createIssue(title, description, owner.assignee);
      res.json({ ...issue, worker: owner.worker, direct: owner.direct });
    } catch (e: any) {
      console.error(`[${stage.logTag}] failed:`, e);
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  };
}

app.post("/api/data-model/trigger", stageTrigger({
  logTag: "data-model/trigger",
  stageKey: "datamodel",
  titlePrefix: "Generate data model",
  intro: "Generated by the Scyne chatbot. Produce the Salesforce data model and publish it to Confluence.",
  gateFile: path.join("outputs", "product-summary.md"),
  gateErrorCode: "no_product_summary",
  gateMessage: (p, f) => `No product summary found for ${p}/${f}. Generate + approve the requirements first, then run the data model.`,
  inputs: (p, f) => [
    `Working folder: projects/${p}/${f}/solutions/DataModel/ — stage the inputs there, then run the skill.`,
    `- projects/${p}/${f}/outputs/product-summary.md (approved Product Summary; copy into solutions/DataModel/productsummary/)`,
    `- solutions/DataModel/datamodel-reference/ (PSS object catalogue; seed from the workspace-root datamodel-reference/ if empty)`,
    `- Skill: salesforce-data-modeler`,
    `- Output: solutions/DataModel/outputs/salesforce-data-model.md`,
  ],
}));

app.post("/api/solution-design/trigger", stageTrigger({
  logTag: "solution-design/trigger",
  stageKey: "design",
  titlePrefix: "Generate solution design",
  intro: "Generated by the Scyne chatbot. Produce the Salesforce Solution Design Document and publish it to Confluence.",
  gateFile: [
    path.join("solutions", "DataModel", "outputs", "salesforce-data-model.md"),
    path.join("solutions", "DataModel", "outputs", "datamodel-impact.md"),
  ],
  gateErrorCode: "no_data_model",
  gateMessage: (p, f) => `No data model found for ${p}/${f}. Generate + approve the data model first, then run the solution design.`,
  inputs: (p, f) => [
    `Working folder: projects/${p}/${f}/solutions/Design/ — stage the inputs there, then run the skill.`,
    `- projects/${p}/${f}/outputs/product-summary.md (approved Product Summary; copy into solutions/Design/productsummary/)`,
    `- Every .md in projects/${p}/${f}/solutions/DataModel/outputs/ (approved data model; copy into solutions/Design/DataModel/)`,
    `- Output: solutions/Design/outputs/solution-design.md`,
  ],
}));

// 2d. Solution architecture — the Solution Architect's SAD. Gated on the product
// summary only, NOT on the data model: the skill consumes a data model when one
// exists and records the dependency when it doesn't, so requiring one would block
// a stage that can still produce useful output. Distinct from /api/solution-design
// (Architecture Lead → solutions/Design/) in every respect: different agent,
// different skill, different folder, different Confluence page.
app.post("/api/solution-architecture/trigger", stageTrigger({
  logTag: "solution-architecture/trigger",
  stageKey: "architecture",
  titlePrefix: "Generate solution architecture",
  intro: "Generated by the Scyne chatbot. Produce the Salesforce Service Cloud Solution Architecture Document and publish it to Confluence.",
  gateFile: path.join("outputs", "product-summary.md"),
  gateErrorCode: "no_product_summary",
  gateMessage: (p, f) => `No product summary found for ${p}/${f}. Generate + approve the requirements first, then run the solution architecture.`,
  inputs: (p, f) => [
    `Working folder: projects/${p}/${f}/solutions/Architecture/ — stage the inputs there, then run the skill.`,
    `- projects/${p}/${f}/outputs/product-summary.md (approved Product Summary; copy into solutions/Architecture/productsummary/)`,
    `- projects/${p}/${f}/solutions/DataModel/outputs/ (optional — copy any .md into solutions/Architecture/DataModel/; do NOT block if absent)`,
    `- projects/${p}/${f}/requirements/Notes/ (optional — current-state architecture / landscape docs; copy into solutions/Architecture/landscape/)`,
    `- Output: solutions/Architecture/outputs/solution-architecture.md`,
  ],
}));

// 2e. Test cases — the QA Architect's pack. Gated on the product summary only;
// the data model and solution architecture are opportunistic enrichment.
app.post("/api/test-cases/trigger", stageTrigger({
  logTag: "test-cases/trigger",
  stageKey: "qa",
  titlePrefix: "Generate test cases",
  intro: "Generated by the Scyne chatbot. Produce the test pack (test cases, traceability matrix, coverage gap analysis) and publish it to Confluence.",
  gateFile: path.join("outputs", "product-summary.md"),
  gateErrorCode: "no_product_summary",
  gateMessage: (p, f) => `No product summary found for ${p}/${f}. Generate + approve the requirements first, then run the test cases.`,
  inputs: (p, f) => [
    `Working folder: projects/${p}/${f}/solutions/QA/ — stage the inputs there, then run the skill.`,
    `- projects/${p}/${f}/outputs/product-summary.md and outputs/stories.md (approved requirements; copy into solutions/QA/productsummary/)`,
    `- projects/${p}/${f}/solutions/DataModel/outputs/ (optional — copy any .md into solutions/QA/DataModel/; drives boundary + validation cases)`,
    `- projects/${p}/${f}/solutions/Architecture/outputs/ and solutions/Design/outputs/ (optional — copy any .md into solutions/QA/Architecture/; drives integration + failure cases)`,
    `- Output: solutions/QA/outputs/test-cases.md (plus test-cases.csv / test-cases.feature if produced)`,
  ],
}));

// 2f. Personas + journey map — no pipeline prerequisite (it reads the same
// discovery documents the BA reads), but unlike the capability map it DOES
// publish, so it carries the Confluence space key. Its personas.json /
// journey-map.json are a build contract for the companion app.
// 2f. Personas — a PROJECT stage. The people a client serves belong to the
// organisation, not to one slice of work, so the persona set is generated once
// and every feature reads it. Gated on the CAPABILITY MAP: journey stages align
// to its L1 lifecycle phases, which is why the wizard runs the two in sequence.
app.post("/api/personas/trigger", stageTrigger({
  logTag: "personas/trigger",
  stageKey: "personas",
  level: "project",
  titlePrefix: "Generate personas",
  intro: "Generated by the Scyne chatbot. Identify the personas this CLIENT serves, map each one's journey, and publish to Confluence. The personas.json / journey-map.json outputs are consumed by the companion app.",
  gateFile: path.join("solutions", "Capabilities", "outputs", "capability-map.json"),
  gateErrorCode: "no_capability_map",
  gateMessage: (p) =>
    `No capability map found for ${p}. Journey stages align to its L1 lifecycle phases, so generate + approve the capability map first, then run the personas.`,
  inputs: (p) => [
    `Working folder: projects/${p}/solutions/Experience/ — stage the inputs there, then run the skill.`,
    `- Stage with: node scripts/stage.mjs ${p} personas (converts to markdown and stages every input below)`,
    `- projects/${p}/documents/ (the project's own client-wide documents)`,
    `- every feature's requirements/{SOP,Transcripts,Notes}/ (copy into solutions/Experience/documents/<feature>/<category>/, skipping templates/)`,
    `- projects/${p}/solutions/Capabilities/outputs/ (REQUIRED — copy into solutions/Experience/capabilities/ to align journey stages to L1 phases)`,
    `- each feature's outputs/product-summary.md (optional — copy into solutions/Experience/productsummary/; do NOT block on it)`,
    `- Deduplicate by PERSON, not by feature: one Eligibility Officer across three features is ONE persona citing all three`,
    `- Outputs: solutions/Experience/outputs/{personas-journeys.md,personas.json,journey-map.json}`,
    `- Validate before raising the gate: node scripts/validate-experience.mjs ${p}`,
  ],
}));

// 2g. Capability map — a PROJECT stage with no prerequisite. It reads every
// document the client has (the project's own documents/ plus every feature's
// discovery documents), so it can run before requirements. It DOES publish, so
// it carries the Confluence space key and /api/approve provisions the space when
// the gate is approved. Confluence only — never Jira.
app.post("/api/capability-map/trigger", stageTrigger({
  logTag: "capability-map/trigger",
  stageKey: "capabilities",
  level: "project",
  titlePrefix: "Generate capability map",
  intro: "Generated by the Scyne chatbot. Produce the Business Capability Map and the L1/L2/L3 Process Model for this PROJECT, from every document the client has. On approval, publish to its own Confluence page — Confluence only, never Jira.",
  gateErrorCode: "no_documents",
  gateMessage: (p, _f, docs) =>
    docs && docs.other > 0
      ? `No readable documents for ${p}. There are ${docs.other} file(s) but none are markdown — the agents read .md. Re-upload the SOPs/transcripts through the chat (uploads are converted to markdown automatically), then try again.`
      : `No documents found for ${p}. Upload at least one SOP, transcript or note (or a reference document tree) before generating the capability map.`,
  inputs: (p) => [
    `Working folder: projects/${p}/solutions/Capabilities/ — stage the documents there, then run the skill.`,
    `- Stage with: node scripts/stage.mjs ${p} capabilities (converts to markdown and stages every document the project has)`,
    `- projects/${p}/documents/ (the project's own client-wide policy, legislation and standards)`,
    `- every feature's requirements/{SOP,Transcripts,Notes}/ and any other .md tree, except outputs/, solutions/ and design/`,
    `- Outputs: solutions/Capabilities/outputs/{capability-map.json,process-model.json,capability-process.md}`,
    `- Validate with: node scripts/render-capability-map.mjs ${p} --validate-only`,
    `- Then update the project's single page: node scripts/render-companion-app.mjs ${p}`,
    `- On approval, publish capability-process.md to a standalone Confluence page "${p} — Capability & Process Map" (Mermaid rendered to PNG), attaching both JSON files.`,
  ],
}));

// 2h. UI mockups — the UX Designer turns everything the feature has produced into
// a screen specification, rendered as themed HTML pages linked from the companion
// app's UI tab. It publishes nothing (confluence: false) — unlike the capability
// map, which does.
// Gated on documents rather than the product summary: the skill needs "the product
// summary OR the discovery documents", and a feature with documents but no
// requirements can still get grounded wireframes. In practice this runs late, once
// the personas, data model and test pack exist — they are what make the screens
// specific — but nothing here forces that order.
app.post("/api/ui-mockups/trigger", stageTrigger({
  logTag: "ui-mockups/trigger",
  stageKey: "ui",
  titlePrefix: "Generate UI mockups",
  intro: "Generated by the Scyne chatbot. Design the UI mockups (wireframes) for this feature — one JSON screen specification, rendered into themed HTML pages linked from the companion app's UI tab. Local artefacts only — nothing is published to Confluence or Jira.",
  gateErrorCode: "no_documents",
  gateMessage: (p, f, docs) =>
    docs && docs.other > 0
      ? `No readable documents for ${p}/${f}. There are ${docs.other} file(s) but none are markdown — the agents read .md. Re-upload the SOPs/transcripts through the chat (uploads are converted to markdown automatically), then try again.`
      : `No documents found for ${p}/${f}. Upload at least one SOP, transcript or note — or generate the requirements first — before designing the screens.`,
  confluence: false,
  inputs: (p, f) => [
    `Working folder: projects/${p}/${f}/solutions/UI/ — stage the inputs there, then run the skill.`,
    `- projects/${p}/description.md (the project definition — read it before any discovery document)`,
    `- projects/${p}/${f}/requirements/{SOP,Transcripts,Notes}/ (copy into solutions/UI/documents/<category>/; real field names and terminology)`,
    `- Stage with: node scripts/stage.mjs ${p} "${f}" ui (stages every input below, including the project's)`,
    `- projects/${p}/solutions/Experience/outputs/{personas.json,journey-map.json} (PROJECT-level; copy into solutions/UI/personas/; the journey steps decide the screen set)`,
    `- projects/${p}/solutions/Capabilities/outputs/*.json (PROJECT-level; copy into solutions/UI/capabilities/)`,
    `- projects/${p}/documents/ (PROJECT-level client-wide documents; copy into solutions/UI/project/documents/)`,
    `- projects/${p}/${f}/outputs/product-summary.md + outputs/stories.md + outputs/product-summaries/*.md (optional — copy into solutions/UI/productsummary/)`,
    `- projects/${p}/${f}/solutions/DataModel/outputs/ (optional, and usually ABSENT — this stage now runs BEFORE the data model; copy any .md into solutions/UI/DataModel/ when it exists)`,
    `- projects/${p}/${f}/solutions/Architecture/outputs/ and solutions/Design/outputs/ (optional — copy any .md into solutions/UI/Architecture/)`,
    `- projects/${p}/${f}/solutions/QA/outputs/ (optional, and usually ABSENT — this stage now runs BEFORE the test pack; the failure paths are the STATES each screen must show, so derive them from the acceptance criteria until it exists)`,
    `- projects/${p}/${f}/requirements/UI/ (client-supplied designs — AUTHORITATIVE when present; reflect them rather than inventing a layout)`,
    `- Output: solutions/UI/outputs/mockups.json (you author the JSON only — never hand-write HTML)`,
    `- Render with: node scripts/render-mockups.mjs ${p} "${f}" (non-zero exit names the offending screen/field — fix the JSON and re-run)`,
    `- Then update the project's single page so its UI tab picks the screens up: node scripts/render-companion-app.mjs ${p}`,
  ],
}));

// 2e. Serve the rendered capability map. The architect writes a self-contained
// page (inline CSS/JS, no network requests), so it can be handed straight to the
// browser — the chatbot links to it rather than iframing it.
// A PROJECT now has ONE page, progressively rendered from every stage's output
// across every feature. These routes are kept so existing links keep working —
// both the project form and the older project/feature form — but they redirect
// to the canonical companion-app URL rather than serving a second copy from a
// path where the page's relative links (mockups/…) would not resolve. The
// existence check stays, so a link followed before the page has been rendered
// still gets the explanatory 404 rather than a redirect loop.
async function redirectToCompanionApp(res: express.Response, project: string) {
  const file = path.join(WORKSPACE_PATH, "generated-apps", project, "index.html");
  try {
    await fs.access(file);
  } catch {
    return res.status(404).json({
      error: "not_generated",
      message: `No page for ${project} yet. Run: node scripts/render-companion-app.mjs ${project}`,
    });
  }
  res.redirect(302, `/api/companion-app/${encodeURIComponent(project)}/`);
}

app.get("/api/capability-map/:project", async (req, res) => {
  try {
    assertSafeProject(req.params.project);
    await redirectToCompanionApp(res, req.params.project);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/api/capability-map/:project/:feature", async (req, res) => {
  try {
    const { project, feature } = req.params;
    assertSafeProjectFeature(project, feature);
    await redirectToCompanionApp(res, project);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

// 3. Status — normalized progress view: tree + computed stage + activity timeline + extracted links + approvals
app.get("/api/status/:issueId", async (req, res) => {
  try {
    const id = req.params.issueId;
    const tree = await paperclip.getIssueTree(id);
    if (!tree) {
      // A session id from a previous database — every Paperclip-era id is one.
      // 404 with a stable code so the frontend can clear it and start over,
      // instead of retrying a dead id every three seconds forever.
      return res.status(404).json({
        error: "unknown_issue",
        message: "That workflow no longer exists. Starting a new session.",
      });
    }

    // Flatten all comments + approvals + work-products from parent + descendants
    const flatIssues: any[] = [];
    const flatComments: any[] = [];
    const flatApprovals: any[] = [];
    const workProductsByIssue: Record<string, any[]> = {};

    function walk(node: any) {
      flatIssues.push({
        id: node.id,
        identifier: node.identifier,
        title: node.title,
        status: node.status,
        assigneeAgentId: node.assigneeAgentId,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      });
      for (const c of node.comments ?? []) {
        flatComments.push({
          id: c.id,
          issueId: node.id,
          issueIdentifier: node.identifier,
          body: c.body ?? c.content ?? "",
          author: c.authorAgentName ?? c.authorUserName ?? c.authorAgentId ?? c.authorUserId ?? "system",
          createdAt: c.createdAt,
        });
      }
      for (const a of node.approvals ?? []) {
        const payload = (a.payload ?? {}) as Record<string, any>;
        flatApprovals.push({
          id: a.id,
          issueId: node.id,
          issueIdentifier: node.identifier,
          title: payload.title ?? a.title ?? "Approval requested",
          description: payload.summary ?? payload.description ?? payload.recommendedAction ?? a.description ?? "",
          status: a.status ?? null, // "pending" | "approved" | "rejected" | "revision_requested" | "cancelled"
          createdAt: a.createdAt,
          resolvedAt: a.decidedAt ?? a.resolvedAt ?? null,
          decisionNote: a.decisionNote ?? null,
        });
      }
      workProductsByIssue[node.id] = node.workProducts ?? [];
      for (const child of node.children ?? []) walk(child);
    }
    walk(tree);

    // Sort comments by createdAt ascending so they read like a timeline
    flatComments.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    // Extract Confluence + Jira URLs from all comments
    const links = extractLinks(flatComments.map((c) => String(c.body)));

    // Derive a coarse current "stage" from the state of the tree. The stage KEYS
    // stay stable across flows (the frontend StagePill maps keys → tones); only
    // the human-facing labels adapt to which worker owns this flow, parsed from
    // the parent issue title prefix.
    const parent = flatIssues[0];
    const children = flatIssues.slice(1);
    const flow = classifyFlow(String(parent?.title || ""));
    const anyApproved = flatApprovals.some((a) => a.status === "approved");
    const anyPending = flatApprovals.some((a) => !a.status || a.status === "pending");
    const allDone = flatIssues.length > 0 && flatIssues.every((i) => i.status === "done");
    let stage: { key: string; label: string };
    if (allDone) stage = { key: "done", label: "Complete" };
    else if (anyApproved && !allDone) stage = { key: "pushing", label: flow.pushingLabel };
    else if (anyPending) stage = { key: "awaiting_approval", label: "Awaiting your approval" };
    else if (children.some((c) => c.status === "in_progress" || c.status === "in_review")) stage = { key: "ba_generating", label: flow.generatingLabel };
    else if (children.length > 0) stage = { key: "delegated", label: `Delegated to ${flow.worker}` };
    // No children, and something is running. WHO owns the issue decides what to
    // say: a single-worker flow is assigned straight to its worker, so there is
    // no Delivery Lead in it and no children will ever appear; the orchestrated
    // flows (Set up project, Build UI) sit with the Delivery Lead until it
    // dispatches. Reading the assignee is the honest signal — the old code
    // assumed the Delivery Lead always owned the root and reported it triaging
    // for flows it never sees.
    else if (parent?.status === "in_progress" || parent?.status === "in_review") {
      stage = parent.assigneeAgentId === paperclip.deliveryLeadId()
        ? { key: "delivery_lead_triaging", label: "Delivery Lead triaging the request" }
        : { key: "ba_generating", label: flow.generatingLabel };
    }
    else stage = { key: "queued", label: "Queued" };

    // The workflow already knows its own target — every trigger writes it into
    // the root issue description ("- Project: X" from stageTrigger, "project: X"
    // from the UI build). Surfacing it lets the UI recover a target the user
    // never has to re-pick, which is what the approval preview needs to resolve
    // a project-level gate.
    const rootText = String((tree as any)?.description ?? "");
    const pick = (key: string) => {
      const m = rootText.match(new RegExp(`^\\s*[-*]?\\s*${key}\\s*:\\s*(.+)$`, "im"));
      // The UI-build description annotates its feature line with a parenthetical.
      return m ? m[1].replace(/\s{2,}\(.*$/, "").trim() || null : null;
    };
    const target = { project: pick("project"), feature: pick("feature") };

    res.json({
      tree,
      stage,
      target,
      flatIssues,
      activity: flatComments,
      approvals: flatApprovals,
      workProducts: workProductsByIssue,
      links,
    });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Walk the issue tree from `rootId` and find which issue owns the interaction.
// Used by approve/reject — Paperclip's interaction endpoints are nested under
// the issue, but the frontend only sends the root parentIssueId.
async function findInteractionIssueId(rootId: string, interactionId: string): Promise<string | null> {
  const tree = await paperclip.getIssueTree(rootId);
  function walk(node: any): string | null {
    if ((node.approvals ?? []).some((a: any) => a.id === interactionId)) return node.id;
    for (const c of node.children ?? []) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  }
  return walk(tree);
}

// 4. Approve — accept the underlying Paperclip interaction. If Atlassian provisioning
//    is configured, auto-create the Jira project + Confluence space (the MCP can't)
//    BEFORE resolving the gate, so the BA's Phase-2 push lands in targets that exist.
app.post("/api/approve/:approvalId", async (req, res) => {
  try {
    const approvalId = req.params.approvalId;
    const parentIssueId = String(req.body?.parentIssueId || "").trim();
    if (!parentIssueId) {
      return res.status(400).json({ error: "parentIssueId is required to locate the interaction" });
    }
    // Provision whatever Atlassian targets the flow declares in its description —
    // keyed on the DATA, not the issue title. The requirements flow carries both
    // a Jira project key and a Confluence space key (both ensured); the
    // Confluence-only downstream stages (data model, solution design) carry only
    // the space key (so just the space is ensured — this also heals the case
    // where the requirements gate was rejected and the space never got created);
    // the Build UI flow carries neither (skipped entirely).
    if (provisioningConfigured()) {
      try {
        const issue: any = await paperclip.getIssue(parentIssueId);
        const desc = String(issue?.description || "");
        const grab = (label: string) =>
          (desc.match(new RegExp(`-\\s*${label}:\\s*(.+)`)) || [])[1]?.trim() || "";
        const project = grab("Project");
        const jiraKey = grab("Jira project key");
        const confKey = grab("Confluence space key");
        const pageTitle = grab("Confluence page title");
        if (confKey) {
          const result = await ensureAtlassianTargets({
            jiraKey: jiraKey || undefined,
            jiraName: project || jiraKey,
            confluenceKey: confKey,
            confluenceName: pageTitle || project || confKey,
          });
          console.log("[approve] ensureAtlassianTargets:", JSON.stringify(result));
        }
      } catch (e: any) {
        // Don't resolve the gate if we couldn't prepare the targets — surface it.
        return res.status(502).json({ error: "provision_failed", message: e?.message ?? String(e) });
      }
    }
    const interactionIssueId = await findInteractionIssueId(parentIssueId, approvalId);
    if (!interactionIssueId) {
      return res.status(404).json({ error: "interaction_not_found", message: `Interaction ${approvalId} not found under issue ${parentIssueId}` });
    }
    const r = await paperclip.acceptInteraction(interactionIssueId, approvalId);
    // Paperclip's auto-wake-on-accept is unreliable in 2026.525 — we explicitly
    // wake the issue's assignee (typically the BA) so Phase 2 fires immediately,
    // without depending on heartbeat polling or queue drain.
    try {
      const issue: any = await paperclip.getIssue(interactionIssueId);
      const assignee = issue?.assigneeAgentId;
      if (assignee) {
        await paperclip.wakeAgent(assignee, `Interaction ${approvalId} accepted via Scyne chatbot.`);
      }
    } catch (wakeErr: any) {
      console.warn("[approve] wakeAgent after accept failed (non-fatal):", wakeErr?.message ?? wakeErr);
    }
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/api/reject/:approvalId", async (req, res) => {
  try {
    const approvalId = req.params.approvalId;
    const parentIssueId = String(req.body?.parentIssueId || "").trim();
    if (!parentIssueId) {
      return res.status(400).json({ error: "parentIssueId is required to locate the interaction" });
    }
    const interactionIssueId = await findInteractionIssueId(parentIssueId, approvalId);
    if (!interactionIssueId) {
      return res.status(404).json({ error: "interaction_not_found" });
    }
    const r = await paperclip.rejectInteraction(interactionIssueId, approvalId, req.body?.note);
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Request changes — the reviewer wasn't happy. Reject the interaction with the
// feedback (so it shows as resolved on Paperclip's side), drop the feedback as a
// comment so the BA reads it + it appears in the timeline, then re-fire the BA by
// flipping its issue back to `todo`. The BA's regenerate branch picks up the
// "Revision requested by reviewer:" comment marker, rewrites outputs, raises fresh.
app.post("/api/request-changes/:approvalId", async (req, res) => {
  try {
    const approvalId = req.params.approvalId;
    const issueId = String(req.body?.issueId || "").trim();
    const feedback = String(req.body?.feedback || "").trim();
    if (!issueId || !feedback) {
      return res.status(400).json({ error: "issueId and feedback are required" });
    }
    await paperclip.rejectInteraction(issueId, approvalId, feedback);
    await paperclip.addComment(issueId, `**Revision requested by reviewer:**\n\n${feedback}`);
    await paperclip.setIssueStatus(issueId, "todo");
    // Explicitly wake the assignee — auto-wake-on-status-change is unreliable in 2026.525.
    try {
      const issue: any = await paperclip.getIssue(issueId);
      const assignee = issue?.assigneeAgentId;
      if (assignee) {
        await paperclip.wakeAgent(assignee, `Revision requested by reviewer on ${approvalId}.`);
      }
    } catch (wakeErr: any) {
      console.warn("[request-changes] wakeAgent after re-fire failed (non-fatal):", wakeErr?.message ?? wakeErr);
    }
    res.json({ ok: true, approvalId, issueId });
  } catch (e: any) {
    console.error("[request-changes] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// History — completed pipeline runs (requirements, data model, solution design)
// across all sessions, with their Confluence + Jira links. Lists top-level
// "Generate …" issues and extracts links from each run's comment tree. Build UI
// runs stay excluded — they publish no Atlassian links.
const HISTORY_PREFIXES = FLOWS.filter((f) => f.flow.key !== "ui").map((f) => f.prefix);
app.get("/api/history", async (_req, res) => {
  try {
    const raw = await paperclip.listCompanyIssues();
    const all: any[] = Array.isArray(raw) ? raw : (raw.items || raw.issues || []);
    const runs = all.filter(
      (i) => !i.parentId && typeof i.title === "string" && HISTORY_PREFIXES.some((p) => i.title.startsWith(p)),
    );
    const entries = await Promise.all(
      runs.map(async (run) => {
        let bodies: string[] = [];
        try {
          const tree = await paperclip.getIssueTree(run.id);
          const collect = (node: any) => {
            for (const c of node.comments ?? []) bodies.push(String(c.body ?? c.content ?? ""));
            for (const ch of node.children ?? []) collect(ch);
          };
          collect(tree);
        } catch { /* skip unreadable run */ }
        return {
          id: run.id,
          identifier: run.identifier,
          title: run.title,
          status: run.status,
          completedAt: run.updatedAt ?? run.createdAt ?? null,
          links: extractLinks(bodies),
        };
      }),
    );
    // Newest first; surface completed/linked runs ahead of empty ones.
    entries.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
    res.json(entries);
  } catch (e: any) {
    console.error("[history] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Compact agent run-summary lines for the Activity panel: every run across the
// parent + its descendant issues, with agent name, status, duration and tool count.
const asArray = (raw: any): any[] => (Array.isArray(raw) ? raw : (raw?.items || raw?.runs || raw?.events || []));
app.get("/api/runs/:issueId", async (req, res) => {
  try {
    const rootId = req.params.issueId;
    // Collect parent + descendant issue ids (light recursive children walk).
    const ids: string[] = [];
    const seen = new Set<string>();
    const walk = async (id: string) => {
      if (seen.has(id)) return;
      seen.add(id); ids.push(id);
      const kids = await paperclip.listChildren(id);
      for (const k of asArray(kids)) if (k?.id) await walk(k.id);
    };
    await walk(rootId);

    // Agent id → friendly name.
    const agents = asArray(await paperclip.listAgents());
    const agentName = new Map<string, string>(agents.map((a: any) => [a.id, a.name]));

    // All runs across those issues. (Tool-call counts aren't emitted as run events
    // for the claude_local adapter — they live in the run log — so we keep this
    // light: agent + status + duration only, no per-run event fetches.)
    const runLists = await Promise.all(ids.map((id) => paperclip.listIssueRuns(id)));
    const rawRuns: any[] = runLists.flatMap(asArray);
    const runs = rawRuns.map((r: any) => {
      const started = r.startedAt ? new Date(r.startedAt).getTime() : null;
      const finished = r.finishedAt ? new Date(r.finishedAt).getTime() : null;
      const durationMs = started ? (finished ?? Date.now()) - started : null;
      return {
        runId: r.runId || r.id,
        agent: agentName.get(r.agentId) || "Agent",
        status: r.status,
        startedAt: r.startedAt ?? r.createdAt ?? null,
        durationMs,
      };
    });
    // Oldest first so they read like a timeline.
    runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    res.json(runs);
  } catch (e: any) {
    console.error("[runs] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Live Transcript: list every agent run across the issue tree, mark which is
// currently in-flight. The frontend dropdown uses this; "Auto" picks
// `activeRunId`. Mirrors /api/runs/:issueId but includes the run's `runId`
// (heartbeat-run id) which the transcript endpoint needs.
app.get("/api/runs/:issueId/agent-runs", async (req, res) => {
  try {
    const rootId = req.params.issueId;
    const ids: string[] = [];
    const seen = new Set<string>();
    const walk = async (id: string) => {
      if (seen.has(id)) return;
      seen.add(id); ids.push(id);
      const kids = await paperclip.listChildren(id);
      for (const k of asArray(kids)) if (k?.id) await walk(k.id);
    };
    await walk(rootId);

    const [agents, ...runLists] = await Promise.all([
      paperclip.listAgents(),
      ...ids.map((id) => paperclip.listIssueRuns(id).then((r) => ({ id, runs: asArray(r) }))),
    ]);
    const agentName = new Map<string, string>(asArray(agents).map((a: any) => [a.id, a.name]));

    // Also need the issue identifier (e.g. SCY-2) per id — fetch from the cached tree.
    const tree = await paperclip.getIssueTree(rootId);
    const idToIdent = new Map<string, string>();
    (function collect(n: any) {
      if (n?.id) idToIdent.set(n.id, n.identifier ?? n.id);
      for (const c of n.children ?? []) collect(c);
    })(tree);

    const flat: any[] = [];
    for (const list of runLists as any[]) {
      const issueId: string = list.id;
      for (const r of list.runs) {
        flat.push({
          runId: r.runId || r.id,
          agentId: r.agentId,
          agentName: agentName.get(r.agentId) || "Agent",
          issueId,
          issueIdentifier: idToIdent.get(issueId) || "?",
          status: r.status, // "running" | "succeeded" | "failed" | "cancelled" | etc.
          startedAt: r.startedAt ?? r.createdAt ?? null,
          finishedAt: r.finishedAt ?? null,
        });
      }
    }
    flat.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const activeRun = flat.find((r) => r.status === "running");
    res.json({ runs: flat, activeRunId: activeRun?.runId ?? null });
  } catch (e: any) {
    console.error("[agent-runs] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Live Transcript: tail one run's log, filter to client-safe events, scrub
// secrets, return {events, nextOffset, runStatus}. Frontend polls every 3s
// with the previous nextOffset and appends new events.
app.get("/api/runs/:runId/transcript", async (req, res) => {
  try {
    const runId = req.params.runId;
    const offset = Math.max(0, parseInt(String(req.query.offset || "0"), 10) || 0);
    const [log, run] = await Promise.all([
      paperclip.getRunLog(runId, offset),
      paperclip.getRun(runId),
    ]);
    const { events, consumed } = filterRunLog(log.content || "");
    // We trust Paperclip's nextOffset when it advances past what we consumed,
    // but never go BACKWARDS — if our consumed (bytes parsed cleanly) is less
    // than nextOffset, use ours so the partial trailing line is re-fetched.
    const reportedNext = typeof log.nextOffset === "number" ? log.nextOffset : offset + (log.content?.length || 0);
    const safeNextOffset = offset + consumed;
    res.json({
      events,
      nextOffset: Math.min(reportedNext, safeNextOffset || reportedNext),
      runStatus: run?.status ?? "unknown",
    });
  } catch (e: any) {
    console.error("[transcript] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});


// 5. List available projects + features by scanning the workspace
// ---------------------------------------------------------------------------
// Project definition — projects/<project>/description.md
//
// Written once per project, read by EVERY skill before any discovery document.
// It frames who the client organisation is, what it is regulated to do, and who
// its customers actually are. Stored at project level, not per feature.
// ---------------------------------------------------------------------------

const SAFE_PROJECT = /^[A-Za-z0-9._ &-]+$/;

app.get("/api/project-description/:project", async (req, res) => {
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { project } = req.params;
    if (!SAFE_PROJECT.test(project)) return res.status(400).json({ error: "bad_project" });
    const file = path.join(WORKSPACE_PATH, "projects", project, "description.md");
    try {
      const content = await fs.readFile(file, "utf8");
      res.json({ project, exists: true, content });
    } catch {
      res.json({ project, exists: false, content: "" });
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/api/project-description", async (req, res) => {
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { project, description } = req.body ?? {};
    if (!project || !SAFE_PROJECT.test(project)) return res.status(400).json({ error: "bad_project" });
    if (typeof description !== "string" || description.trim().length < 40) {
      return res.status(400).json({ error: "too_short", message: "A project definition needs at least a couple of sentences." });
    }
    const dir = path.join(WORKSPACE_PATH, "projects", project);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "description.md");

    // Preserve a hand-written heading if the author supplied one.
    const body = description.trim();
    const content = body.startsWith("#") ? body + "\n" : `# ${project} — Project Definition\n\n${body}\n`;
    await fs.writeFile(file, content, "utf8");
    console.log(`[project-description] wrote ${file} (${content.length} bytes)`);
    res.json({ ok: true, project, path: `projects/${project}/description.md`, bytes: content.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/api/features", async (_req, res) => {
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const ws = WORKSPACE_PATH;
    const projectsDir = path.join(ws, "projects");
    const result: Record<string, { name: string; counts: Record<string, number> }[]> = {};
    try {
      const projects = await fs.readdir(projectsDir, { withFileTypes: true });
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        const features = await fs.readdir(path.join(projectsDir, p.name), { withFileTypes: true });
        result[p.name] = [];
        for (const s of features) {
          if (!s.isDirectory()) continue;
          // A project directory holds features PLUS the project's own folders.
          // Only the former are features — without this, `solutions/`,
          // `documents/` and `design/` appear in the target picker as soon as a
          // project generates anything.
          if (PROJECT_OWN_DIRS.has(s.name.toLowerCase())) continue;
          const subPath = path.join(projectsDir, p.name, s.name);
          const subs = await fs.readdir(subPath, { withFileTypes: true });
          const counts: Record<string, number> = {};
          for (const sub of subs) {
            if (!sub.isDirectory()) continue;
            const files = await fs.readdir(path.join(subPath, sub.name));
            counts[sub.name] = files.length;
          }
          result[p.name].push({ name: s.name, counts });
        }
      }
    } catch (e) {
      // No projects/ dir yet — return empty
    }
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});


// 6. Artefacts — read the BA's generated outputs from disk so the UI can preview before approval
app.get("/api/artifacts", async (req, res) => {
  try {
    const project = String(req.query.project || "").trim();
    const feature = String(req.query.feature || "").trim();
    if (!project) {
      return res.status(400).json({ error: "missing_target", message: "project query param is required" });
    }
    // The capability map and personas are project-level, so a project-only call
    // is valid — it returns those two and nothing feature-scoped. That is what
    // the approval card needs when the gate belongs to a project stage.
    if (feature) assertSafeProjectFeature(project, feature); else assertSafeProject(project);

    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const ws = WORKSPACE_PATH;
    const projectRoot = path.join(ws, "projects", project);
    const featureRoot = feature ? path.join(projectRoot, feature) : null;
    // BA artefacts live in outputs/; the downstream stages each write into
    // their own solutions/<Stage>/outputs/ working folder.
    const read = async (...rel: string[]) => {
      if (!featureRoot) return null;
      try { return await fs.readFile(path.join(featureRoot, ...rel), "utf8"); } catch { return null; }
    };
    const readProject = async (...rel: string[]) => {
      try { return await fs.readFile(path.join(projectRoot, ...rel), "utf8"); } catch { return null; }
    };
    const [productSummary, storiesJson, storiesMd, gaps, dataModel, salesforceDataModel, solutionDesign, solutionArchitecture, testCases, capabilityMap, personas] = await Promise.all([
      read("outputs", "product-summary.md"),
      read("outputs", "stories.json"),
      read("outputs", "stories.md"),
      read("outputs", "gaps.md"),
      read("solutions", "DataModel", "outputs", "datamodel-impact.md"),
      read("solutions", "DataModel", "outputs", "salesforce-data-model.md"),
      read("solutions", "Design", "outputs", "solution-design.md"),
      read("solutions", "Architecture", "outputs", "solution-architecture.md"),
      read("solutions", "QA", "outputs", "test-cases.md"),
      readProject("solutions", "Capabilities", "outputs", "capability-process.md"),
      readProject("solutions", "Experience", "outputs", "personas-journeys.md"),
    ]);
    let stories: any[] = [];
    if (storiesJson) {
      try {
        const parsed = JSON.parse(storiesJson);
        stories = (Array.isArray(parsed) ? parsed : []).map((s: any) => ({
          summary: s?.fields?.summary ?? "",
          description: s?.fields?.description ?? "",
          labels: s?.fields?.labels ?? [],
          meta: s?._meta ?? {},
        }));
      } catch {}
    }
    // `dataModel` prefers the Data Modeler's impact analysis and falls back to
    // the salesforce-data-modeler skill's output, so the preview tab shows
    // whichever data-model deliverable the feature actually has.
    res.json({
      productSummary, stories, storiesMd, gaps,
      dataModel: dataModel ?? salesforceDataModel,
      solutionDesign, solutionArchitecture, testCases, capabilityMap, personas,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// --- Project + feature creation -------------------------------------------
//
// The wizard creates a PROJECT: name, what the client does, optionally their
// website. Features are added later from chat, because features arrive over
// weeks while the project is created once.

/** Directories a new project starts with. Empty is fine — every stage creates its own working folders. */
const PROJECT_SCAFFOLD = [
  "documents",
  "design/style-guides",
  "design/example-screens",
  "solutions/Capabilities/outputs",
  "solutions/Experience/outputs",
];

/** Directories a new feature starts with. */
const FEATURE_SCAFFOLD = [
  "requirements/SOP",
  "requirements/Transcripts",
  "requirements/Notes",
  "requirements/UI",
  "requirements/templates",
  "outputs",
];

app.post("/api/projects", async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    const description = String(req.body?.description || "").trim();
    const website = String(req.body?.website || "").trim();

    if (!project || !SAFE_PROJECT.test(project)) {
      return res.status(400).json({ error: "bad_project", message: "Use letters, numbers, spaces, and . _ & - only." });
    }
    const root = path.join(WORKSPACE_PATH, "projects", project);
    try {
      await fs.access(root);
      return res.status(409).json({ error: "exists", message: `A project called "${project}" already exists.` });
    } catch { /* good — it is new */ }

    for (const d of PROJECT_SCAFFOLD) await fs.mkdir(path.join(root, ...d.split("/")), { recursive: true });

    // The definition is optional at creation time but changes every skill's
    // output, so it is asked for in step 1 rather than chased later.
    let definitionWritten = false;
    if (description.length >= 40) {
      const content = description.startsWith("#")
        ? description + "\n"
        : `# ${project} — Project Definition\n\n${description}\n`;
      await fs.writeFile(path.join(root, "description.md"), content, "utf8");
      definitionWritten = true;
    }

    // Branding is a fetch, not an agent, so it runs inline. A failure is
    // reported and never fatal — the Scyne palette is a fine fallback.
    let brand: any = null;
    let brandError: string | null = null;
    if (website) {
      let parsed: URL | null = null;
      try { parsed = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`); } catch { /* reported below */ }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        brandError = `Not a usable URL: ${website}`;
      } else {
        const extract = await runHelper("extract-brand.mjs", [parsed.href, project, "--force"]);
        if (extract.ok) {
          try {
            const t = JSON.parse(await fs.readFile(path.join(root, "design", "style-guides", "theme.json"), "utf8"));
            brand = { ...t, logoSrc: undefined, hasLogo: Boolean(t.logoSrc) };
          } catch { /* written but unreadable — treat as no brand */ }
        } else {
          brandError = extract.stderr?.trim() || `extract-brand.mjs exited with ${extract.code}`;
        }
      }
    }

    console.log(`[projects] created ${project} (definition=${definitionWritten}, brand=${Boolean(brand)})`);
    res.json({ ok: true, project, definitionWritten, brand, brandError });
  } catch (e: any) {
    console.error("[projects] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/api/features", async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    const feature = String(req.body?.feature || "").trim();
    if (!project || !feature) {
      return res.status(400).json({ error: "missing_target", message: "project and feature are required" });
    }
    if (!SAFE_PROJECT.test(project) || !SAFE_PROJECT.test(feature)) {
      return res.status(400).json({ error: "bad_name", message: "Use letters, numbers, spaces, and . _ & - only." });
    }
    // `capabilities`, `personas` and `all` are project-stage keywords on the
    // CLI, and a feature by those names would be unreachable there.
    if (pipeline.RESERVED_FEATURE_NAMES.has(feature.toLowerCase()) || PROJECT_OWN_DIRS.has(feature.toLowerCase())) {
      return res.status(400).json({
        error: "reserved_name",
        message: `"${feature}" is reserved. Pick another name — it would clash with a project-level folder or CLI stage.`,
      });
    }
    const projectRoot = path.join(WORKSPACE_PATH, "projects", project);
    try { await fs.access(projectRoot); } catch {
      return res.status(404).json({ error: "no_project", message: `No project called "${project}".` });
    }
    const root = path.join(projectRoot, feature);
    try {
      await fs.access(root);
      return res.status(409).json({ error: "exists", message: `${project} already has a feature called "${feature}".` });
    } catch { /* good — it is new */ }

    for (const d of FEATURE_SCAFFOLD) await fs.mkdir(path.join(root, ...d.split("/")), { recursive: true });
    console.log(`[features] created ${project}/${feature}`);
    res.json({ ok: true, project, feature });
  } catch (e: any) {
    console.error("[features] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

/**
 * Deploy from the wizard: build the project baseline.
 *
 * ONE agent, ONE wake, ONE approval gate. The capability map still precedes the
 * personas — that dependency is real, because journey stages align to the L1
 * lifecycle phases — but it is now sequencing INSIDE a single run rather than
 * two agents handing off through the Delivery Lead.
 *
 * What that removes: a second agent wake re-reading a 10k-token instruction
 * bundle, a second human approval round-trip, a second companion-app render,
 * and — the real cost — re-reading the same discovery documents. Both working
 * folders stage the SAME source files, so the second agent was paying ~45k
 * input tokens to read what the first had already read.
 *
 * What it does NOT remove is the ~73k output tokens the two artefacts cost to
 * write. That is inherent, and it is most of the wall-clock.
 */
app.post("/api/project/bootstrap", async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    if (!project || !SAFE_PROJECT.test(project)) return res.status(400).json({ error: "bad_project" });
    const docs = await countProjectDocs(project);
    if (docs.md === 0) {
      return res.status(409).json({
        error: "no_documents",
        ...docs,
        message: docs.other > 0
          ? `${project} has ${docs.other} file(s) but none are markdown — the agents read .md. Re-upload through the chat so they are converted.`
          : `No documents for ${project} yet. Upload at least one policy, SOP or transcript first.`,
      });
    }
    const description = [
      "Generated by the Scyne chatbot. Build this project's baseline in ONE pass: the capability map, then the personas, then ONE approval gate.",
      ``,
      `## Project`,
      `- Project: ${project}`,
      ``,
      `## Parameters`,
      `- Confluence space key: ${deriveProjectKey(project)}`,
      ``,
      `## Sequence — one session, in order`,
      `1. node scripts/stage.mjs ${project} baseline`,
      `2. Run the \`capability-process-map\` skill`,
      `3. node scripts/render-capability-map.mjs ${project} --validate-only`,
      `4. node scripts/stage.mjs ${project} personas   (needs step 2's output on disk)`,
      `5. Run the \`persona-journey-map\` skill — do NOT re-read the discovery documents; they are already in context from step 2`,
      `6. node scripts/validate-experience.mjs ${project}`,
      `7. node scripts/render-companion-app.mjs ${project}   (ONCE — the page covers both)`,
      `8. Raise ONE approval gate covering both artefacts`,
      ``,
      `On approval, Phase 2 publishes BOTH Confluence pages:`,
      `- \`${project} — Capability & Process Map\``,
      `- \`${project} — Personas & Journey Map\``,
    ].join("\n");
    // Straight to the worker. The Delivery Lead's whole contribution to this
    // flow was sequencing two children, which the single run now does itself.
    const owner = paperclip.agentId("capArchitect") ?? undefined;
    // The orchestrator's `baseline` workflow names its own assignee; this is
    // passed for the chat's reply text only.
    const issue = await paperclip.createIssue(`Generate project baseline — ${project}`, description, owner);
    res.json(issue);
  } catch (e: any) {
    console.error("[project/bootstrap] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// --- Staleness, suggestions, revision --------------------------------------

/**
 * Artefacts generated before one of their inputs last changed.
 *
 * Computed from file mtimes against the shared pipeline graph — no manifest, no
 * bookkeeping to drift. mtime cannot tell a substantive revision from a re-run
 * that changed nothing, so this OVER-reports. That is the safe direction: the
 * user is offered a refresh they may decline, never silently handed a pack that
 * contradicts itself.
 */
app.get("/api/staleness/:project/:feature?", async (req, res) => {
  try {
    const { project } = req.params;
    // Express types an optional param as `"feature?"`, so read it off a loose
    // record rather than fighting the generated key name.
    const raw = (req.params as Record<string, string | undefined>).feature;
    const feature = raw ? String(raw) : undefined;
    if (feature) assertSafeProjectFeature(project, feature); else assertSafeProject(project);
    const stale = await pipeline.staleness(WORKSPACE_PATH, project, feature);
    res.json({ project, feature: feature ?? null, stale });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

/**
 * The chips above the composer.
 *
 * Every chip is `{label, message}` — clicking one sends `message` as an ordinary
 * chat turn, so a chip is indistinguishable from typing and needs no special
 * handling on the way back. Computed from the pipeline graph plus what is on
 * disk, so a chip is never offered for a stage whose prerequisite is unmet: a
 * click cannot produce a 409.
 */
app.get("/api/suggestions", async (req, res) => {
  try {
    const project = String(req.query.project || "").trim();
    const feature = String(req.query.feature || "").trim();
    const chips: { label: string; message: string }[] = [];
    const add = (label: string, message: string) => {
      if (chips.length < 4 && !chips.some((c) => c.label === label)) chips.push({ label, message });
    };

    if (!project) {
      add("Create a new project", "I'd like to create a new project.");
      add("Show me my projects", "What projects do we have?");
      return res.json({ chips });
    }
    assertSafeProject(project);

    const done = async (key: string, f?: string) => pipeline.stageIsDone(WORKSPACE_PATH, key, project, f);
    const ready = async (key: string, f?: string) =>
      (await pipeline.unmetRequirements(WORKSPACE_PATH, key, project, f)).length === 0;

    // Stale first: a contradictory pack is the most expensive thing to ship.
    const stale = await pipeline.staleness(WORKSPACE_PATH, project, feature || undefined);
    for (const s of stale.slice(0, 2)) {
      add(`Refresh the ${s.label}`, `Refresh the ${s.label}${feature ? ` for ${feature}` : ""} — it predates the ${s.supersededBy[0].label}.`);
    }

    // Project baseline.
    if (!(await done("capabilities"))) add("Generate capabilities & personas", `Set up ${project} — generate the capability map and personas.`);
    else if (!(await done("personas")) && (await ready("personas"))) add("Generate the personas", `Generate the personas for ${project}.`);

    const features: string[] = await pipeline.listFeatures(WORKSPACE_PATH, project);
    if (!feature) {
      if (features.length === 0) add("Add a feature", `Add a feature to ${project}.`);
      else add("Add a feature", `Add a feature to ${project}.`);
    } else {
      assertSafeProjectFeature(project, feature);
      // Feature stages, in pipeline order — the first not-done, ready one.
      for (const [key, def] of pipeline.ordered("feature") as [string, any][]) {
        if (def.optional) continue;
        if (await done(key, feature)) continue;
        if (!(await ready(key, feature))) continue;
        add(`Generate the ${def.label}`, `Generate the ${def.label} for ${project} / ${feature}.`);
        break;
      }
      // Revision is the other half of the chat's job, so it is always offered
      // once something exists to revise.
      for (const [key, def] of pipeline.ordered("feature") as [string, any][]) {
        if (await done(key, feature)) {
          add(`Change the ${def.label}`, `I want to change something in the ${def.label} for ${project} / ${feature}.`);
          break;
        }
      }
      add("Add a feature", `Add a feature to ${project}.`);
    }

    if (!(await done("app"))) add("Build the companion app", `Build the companion app for ${project}.`);
    else add("Open the companion app", `Show me the companion app for ${project}.`);

    res.json({ chips: chips.slice(0, 4) });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

/**
 * Revise an already-generated artefact.
 *
 * Full agent round-trip: the owning worker re-stages its inputs, reads its own
 * previous output, applies the instruction, and raises a fresh approval gate.
 * On approval it UPDATES the existing Confluence page rather than creating a
 * second one, using projects/<project>/.published.json for page identity.
 *
 * The instruction travels VERBATIM. A paraphrase here is how a revision ends up
 * doing the wrong thing.
 */
app.post("/api/revise", async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    const feature = String(req.body?.feature || "").trim();
    const artefact = String(req.body?.artefact || "").trim();
    const instruction = String(req.body?.instruction || "").trim();

    if (!project || !artefact || !instruction) {
      return res.status(400).json({ error: "missing_input", message: "project, artefact and instruction are required" });
    }
    const stageKey: string | null = pipeline.stageFor(artefact);
    if (!stageKey) {
      return res.status(400).json({
        error: "unknown_artefact",
        message: `I don't know an artefact called "${artefact}".`,
        valid: Object.keys(pipeline.ARTEFACT_ALIASES),
      });
    }
    const def = pipeline.STAGES[stageKey];
    const isProjectStage = def.level === "project";
    if (isProjectStage) assertSafeProject(project);
    else {
      if (!feature) return res.status(400).json({ error: "missing_target", message: `${def.label} is per feature — which feature?` });
      assertSafeProjectFeature(project, feature);
    }

    if (!(await pipeline.stageIsDone(WORKSPACE_PATH, stageKey, project, isProjectStage ? undefined : feature))) {
      return res.status(409).json({
        error: "not_generated",
        stage: stageKey,
        message: `There is no ${def.label.toLowerCase()} for ${project}${isProjectStage ? "" : ` / ${feature}`} yet — generate it first, then I can change it.`,
      });
    }

    const scope = isProjectStage ? project : `${project}/${feature}`;
    const title = `Revise ${def.titlePrefix.replace(/^Generate /, "")} — ${scope}`;
    const description = [
      `Generated by the Scyne chatbot. REVISE an existing artefact — do not regenerate it from scratch.`,
      ``,
      isProjectStage ? `## Project` : `## Project + Feature`,
      `- Project: ${project}`,
      ...(isProjectStage ? [] : [`- Feature: ${feature}`]),
      `- Artefact: ${stageKey}`,
      `- Owner: ${def.agent}`,
      ...(def.publishes ? [``, `## Parameters`, `- Confluence space key: ${deriveProjectKey(project)}`] : []),
      ``,
      `## instruction`,
      instruction,
      ``,
      `## How to run this`,
      `- Stage your inputs exactly as for a fresh run.`,
      `- Read your OWN previous output first and pass it to the skill as the previous version, so the skill enters its Revision mode.`,
      `- Preserve every section, decision and identifier the instruction does not touch. A regenerate-from-scratch produces a diff too large for the reviewer to check.`,
      `- Append a \`## Revision History\` entry recording what changed.`,
      ...(def.then ? [`- Re-run the validator: ${String(def.then).replace("<project>", project).replace("<feature>", `"${feature}"`)}`] : []),
      `- Re-render the project page: node scripts/render-companion-app.mjs ${project}`,
      ...(def.publishes ? [
        `- On approval, UPDATE the existing Confluence page: read projects/${project}/.published.json for the pageId and call updateConfluencePage. Only create a page if there is no entry, and write the entry back either way.`,
      ] : [`- Nothing is published for this artefact.`]),
    ].join("\n");

    const owner = ownerFor(stageKey);
    const issue = await paperclip.createIssue(title, description, owner.assignee);
    res.json({ ...issue, stage: stageKey, worker: owner.worker, direct: owner.direct, artefact: pipeline.artefactKey(stageKey, feature) });
  } catch (e: any) {
    console.error("[revise] failed:", e);
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

// --- Uploads & voice agent ------------------------------------------------

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

function assertSafeProjectFeature(project: string, feature: string) {
  if (!SAFE_NAME.test(project) || !SAFE_NAME.test(feature)) {
    const err: any = new Error("Invalid project or feature name");
    err.status = 400;
    throw err;
  }
}

function assertSafeProject(project: string) {
  if (!SAFE_NAME.test(project)) {
    const err: any = new Error("Invalid project name");
    err.status = 400;
    throw err;
  }
}

// 7. Upload a single file — auto-route into projects/<project>/<feature>/<subfolder>/.
//    Audio files (.mp3/.wav/.m4a/...) are transcribed via Gemini Files API and
//    written as transcript-upload-N.md inside transcripts/.
/**
 * Project-level document upload — the wizard's single dropzone.
 *
 * Lands in projects/<project>/documents/ and is converted to markdown straight
 * away, not at staging time: /api/project/bootstrap gates on the project having
 * at least one .md, so a client who uploaded only PDFs would otherwise be told
 * they have no documents. The original is MOVED to original-files/documents/,
 * never deleted.
 */
app.post("/api/upload/project", upload.single("file"), async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    if (!project) return res.status(400).json({ error: "missing_target", message: "project is required" });
    if (!SAFE_PROJECT.test(project)) return res.status(400).json({ error: "bad_project" });
    if (!req.file) return res.status(400).json({ error: "file is required (field name: 'file')" });

    const dir = path.join(WORKSPACE_PATH, "projects", project, "documents");
    await fs.mkdir(dir, { recursive: true });
    const savedName = await uniqueName(dir, req.file.originalname);
    await fs.writeFile(path.join(dir, savedName), req.file.buffer);

    const converted = await runHelper("convert-to-md.mjs", [project]);
    res.json({
      kind: "file",
      scope: "project",
      filename: savedName,
      converted: converted.ok,
      relativePath: path.relative(WORKSPACE_PATH, path.join(dir, savedName)),
    });
  } catch (e: any) {
    console.error("[upload/project] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    const feature = String(req.body?.feature || "").trim();
    const rawHint = String(req.body?.hint || "").trim();
    if (!project || !feature) return res.status(400).json({ error: "project and feature are required" });
    assertSafeProjectFeature(project, feature);
    if (!req.file) return res.status(400).json({ error: "file is required (field name: 'file')" });

    // Design uploads bypass the requirements router — they land directly under
    // projects/<p>/<f>/design/{style-guides|example-screens}/. The Developer reads
    // from there; the BA ignores design/ entirely.
    if (rawHint === "style-guide" || rawHint === "example-screen") {
      const sub = rawHint === "style-guide" ? "style-guides" : "example-screens";
      const targetDir = path.join(WORKSPACE_PATH, "projects", project, feature, "design", sub);
      await fs.mkdir(targetDir, { recursive: true });
      const savedName = await uniqueName(targetDir, req.file.originalname);
      await fs.writeFile(path.join(targetDir, savedName), req.file.buffer);
      return res.json({
        kind: "file",
        subfolder: `design/${sub}`,
        filename: savedName,
        relativePath: path.relative(WORKSPACE_PATH, path.join(targetDir, savedName)),
      });
    }

    const hint = (rawHint as Hint) || undefined;
    const route = routeFile(req.file.originalname, hint);

    // Ambiguous .docx/.pdf — caller must resupply with hint.
    if (route.ambiguous && !hint) {
      return res.status(409).json({
        error: "ambiguous_kind",
        message: `Couldn't infer where ${req.file.originalname} belongs. Hint with one of: sop, transcripts, notes.`,
        originalName: req.file.originalname,
      });
    }

    if (route.isAudio) {
      const transcribed = await transcribeAudioFile(
        await spillToTemp(req.file.buffer, req.file.originalname),
        req.file.mimetype || "audio/mpeg",
      );
      if (transcribed.entries.length === 0) {
        return res.status(422).json({ error: "no_transcript", message: "Gemini returned no transcript text", raw: transcribed.rawText });
      }
      const result = await writeTranscript({
        project,
        feature,
        workspace: WORKSPACE_PATH,
        source: "audio-upload",
        entries: transcribed.entries,
        originalFilename: req.file.originalname,
      });
      return res.json({
        kind: "transcript",
        subfolder: "transcripts",
        filename: result.filename,
        relativePath: result.relativePath,
        entryCount: transcribed.entries.length,
        modelUsed: transcribed.modelUsed,
      });
    }

    const targetDir = requirementsDir(WORKSPACE_PATH, project, feature, route.subfolder);
    await fs.mkdir(targetDir, { recursive: true });
    const savedName = await uniqueName(targetDir, route.savedName);
    await fs.writeFile(path.join(targetDir, savedName), req.file.buffer);
    return res.json({
      kind: "file",
      subfolder: route.subfolder,
      filename: savedName,
      relativePath: path.relative(WORKSPACE_PATH, path.join(targetDir, savedName)),
    });
  } catch (e: any) {
    console.error("[upload] failed:", e);
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

// 6b. Create a new project/feature — scaffolds the empty input folder structure
//     in the shared workspace volume. Files are uploaded afterwards via /api/upload.
app.post("/api/projects", async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    const feature = String(req.body?.feature || "").trim();
    if (!project || !feature) return res.status(400).json({ error: "project and feature are required" });
    assertSafeProjectFeature(project, feature);

    const base = path.join(WORKSPACE_PATH, "projects", project, feature);
    const dirs = [
      path.join(base, "requirements", "SOP"),
      path.join(base, "requirements", "Transcripts"),
      path.join(base, "requirements", "Notes"),
      path.join(base, "requirements", "UI"),
      path.join(base, "requirements", "templates"),
      path.join(base, "design", "style-guides"),
      path.join(base, "design", "example-screens"),
      path.join(base, "outputs"),
      // Downstream pipeline working folders (Data Modeler / Architecture Lead).
      // The agents also create these on demand, so older features work too.
      path.join(base, "solutions", "DataModel", "productsummary"),
      path.join(base, "solutions", "DataModel", "datamodel-reference"),
      path.join(base, "solutions", "DataModel", "outputs"),
      path.join(base, "solutions", "Design", "productsummary"),
      path.join(base, "solutions", "Design", "DataModel"),
      path.join(base, "solutions", "Design", "outputs"),
      // Capabilities Process Architect working folder.
      path.join(base, "solutions", "Capabilities", "documents"),
      path.join(base, "solutions", "Capabilities", "outputs"),
    ];
    for (const d of dirs) await fs.mkdir(d, { recursive: true });

    res.json({ ok: true, project, feature, relativePath: path.relative(WORKSPACE_PATH, base) });
  } catch (e: any) {
    console.error("[projects] create failed:", e);
    // A permission error here nearly always means the workspace root is wrong
    // (pointing outside this checkout) — say so instead of leaking a raw EACCES.
    if (["EACCES", "EPERM", "EROFS"].includes(e?.code)) {
      return res.status(500).json({
        error: "workspace_not_writable",
        message:
          `Can't create folders under ${WORKSPACE_PATH} (${e.code}). ` +
          `The server's workspace root is not writable — unset WORKSPACE_PATH in scyne-chatbot/.env ` +
          `to use this checkout, or point it at a directory you own.`,
      });
    }
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

// 7a. Trigger a UI build — creates a Delivery-Lead-assigned issue with the "Build UI — ..." title.
//     The Delivery Lead detects this intent, validates outputs/product-summary.md exists, then
//     dispatches the Developer directly (its direct report). When the Developer finishes, the
//     Delivery Lead is auto-woken (issue_children_completed) and dispatches the UX Auditor.
app.post("/api/ui-agent/trigger", async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    // The companion app is PROJECT-level: one page covering every feature. A
    // `feature` in the body is context (which feature prompted the build), not
    // scope, so it is recorded and otherwise ignored.
    const feature = String(req.body?.feature || "").trim();
    if (!project) return res.status(400).json({ error: "missing_target", message: "project is required" });
    if (feature) assertSafeProjectFeature(project, feature); else assertSafeProject(project);

    // Quick local check so we can fail fast with a clear error in the chat. The
    // page is progressive, so ANY artefact is enough — refusing until the
    // requirements exist would block a project that has only its capability map.
    const hasSomething = await (async () => {
      const candidates = [
        path.join("solutions", "Capabilities", "outputs", "capability-map.json"),
        path.join("solutions", "Experience", "outputs", "personas.json"),
      ];
      for (const c of candidates) {
        try { await fs.access(path.join(WORKSPACE_PATH, "projects", project, c)); return true; } catch { /* next */ }
      }
      const docs = await countProjectDocs(project);
      if (docs.md === 0) return false;
      // Documents alone are not an artefact — look for at least one feature output.
      let entries: any[] = [];
      try { entries = await fs.readdir(path.join(WORKSPACE_PATH, "projects", project), { withFileTypes: true }); } catch { return false; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        try {
          await fs.access(path.join(WORKSPACE_PATH, "projects", project, e.name, "outputs", "product-summary.md"));
          return true;
        } catch { /* next feature */ }
      }
      return false;
    })();
    if (!hasSomething) {
      return res.status(409).json({
        error: "no_artefacts",
        message: `Nothing generated for ${project} yet. Run the capability map, personas or requirements first — the page renders whatever exists.`,
      });
    }

    const title = `Build UI — ${project}`;
    const description = [
      `project: ${project}`,
      ...(feature ? [`feature: ${feature}   (context only — the page covers every feature)`] : []),
      `intent: build_ui`,
      ``,
      `Inputs (project level):`,
      `- projects/${project}/design/style-guides/`,
      `- projects/${project}/solutions/Capabilities/outputs/`,
      `- projects/${project}/solutions/Experience/outputs/`,
      ``,
      `Inputs (every feature under the project):`,
      `- projects/${project}/<feature>/outputs/`,
      `- projects/${project}/<feature>/solutions/{UI,DataModel,Architecture,QA,Design}/outputs/`,
      ``,
      `Render with: node scripts/render-companion-app.mjs ${project}`,
    ].join("\n");

    // Stays with the Delivery Lead ON PURPOSE. Unlike the single-worker flows,
    // this one orchestrates TWO sequential children — Developer, then UX Auditor
    // once the build completes — which is exactly the job the Delivery Lead is
    // for. Same reasoning for `Set up project`.
    const issue = await paperclip.createIssue(title, description);
    res.json(issue);
  } catch (e: any) {
    console.error("[ui-agent/trigger] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// 7a2. Serve the rendered companion app. It is one self-contained file, so it
// goes straight to the browser — the preview pane iframes this URL, and
// scripts/audit-a11y.mjs points axe/pa11y at it.
//
// The app is no longer a single file on its own: `render-mockups.mjs` writes a
// sibling `mockups/` directory, and the UI tab links into it RELATIVELY so the
// same links work when the pack is opened from disk. For a relative link to
// resolve over HTTP the app must be served from a directory URL, so the
// canonical URL carries a trailing slash and the bare form redirects to it.
// Without that, `mockups/scr-001.html` would resolve one segment too high and
// 404 — silently, in an iframe.
async function sendCompanionFile(res: express.Response, project: string, relPath: string) {
  const root = path.join(WORKSPACE_PATH, "generated-apps", project);
  const file = path.join(root, relPath);
  // Defence in depth: relPath is already whitelisted by each route's pattern.
  if (!file.startsWith(root + path.sep)) return res.status(400).json({ error: "bad_path" });
  let html: string;
  try {
    html = await fs.readFile(file, "utf8");
  } catch {
    return res.status(404).json({
      error: "not_generated",
      message: relPath === "index.html"
        ? `No companion app for ${project}. Run: node scripts/render-companion-app.mjs ${project}`
        : `${relPath} has not been rendered for ${project}. Run: node scripts/render-mockups.mjs ${project} "<feature>"`,
    });
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // The page embeds everything and is re-rendered on every run, so never let a
  // stale copy sit in the iframe after a regenerate.
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
}

app.get("/api/companion-app/:project", async (req, res) => {
  try {
    const { project } = req.params;
    assertSafeProject(project);
    // Express matches this route with or without the trailing slash. Only the
    // directory form makes the page's relative links resolve, so send the bare
    // form there rather than serving a page whose UI tab is quietly broken.
    if (!req.path.endsWith("/")) return res.redirect(302, req.baseUrl + req.path + "/");
    await sendCompanionFile(res, project, "index.html");
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// The mockup pages link back with `../../index.html`, which lands here.
app.get("/api/companion-app/:project/index.html", async (req, res) => {
  try {
    const { project } = req.params;
    assertSafeProject(project);
    await sendCompanionFile(res, project, "index.html");
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// The UI mockups: one directory per feature, one page per screen plus an index.
app.get("/api/companion-app/:project/mockups/:feature/:file", async (req, res) => {
  try {
    const { project, feature } = req.params;
    assertSafeProjectFeature(project, feature);
    const file = String(req.params.file);
    if (!/^[A-Za-z0-9._-]+\.html$/.test(file)) {
      return res.status(400).json({ error: "bad_file", message: "mockup pages are .html only" });
    }
    // The renderer slugs the feature into the directory name, so a feature with
    // spaces or capitals resolves here too.
    const dir = String(feature).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await sendCompanionFile(res, project, path.join("mockups", dir, file));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// 7b. Preview registry lookup for the iframe pane. Keyed by project — there is
// one companion app per project, covering every feature. The feature-scoped
// form is kept so an older client (or a saved link) still resolves.
async function readRegistryEntry(project: string) {
  const registryPath = path.join(WORKSPACE_PATH, "generated-apps", "registry.json");
  let registry: Record<string, any> = {};
  try {
    registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch {
    return { error: "no_registry" as const, entry: null };
  }
  const entry = registry[project];
  if (!entry) return { error: "no_entry" as const, entry: null };
  return { error: null, entry };
}

app.get("/api/preview/:project", async (req, res) => {
  try {
    const { project } = req.params;
    assertSafeProject(project);
    const { error, entry } = await readRegistryEntry(project);
    if (error) return res.status(404).json({ error });
    res.json(entry);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/api/preview/:project/:feature", async (req, res) => {
  try {
    const { project, feature } = req.params;
    assertSafeProjectFeature(project, feature);
    const { error, entry } = await readRegistryEntry(project);
    if (error) return res.status(404).json({ error });
    res.json(entry);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// 7d. Re-render the companion app. The companion app is a static file, so there
//     is no server to start or stop — "start" now means "re-render from the
//     current artefacts", which is what the user actually wants when they say
//     "refresh the UI". "stop" is accepted and reported as a no-op rather than
//     failing, so an older chat transcript saying "stop the UI" still behaves
//     sensibly. The React dev-server path lives in scripts/legacy-react-scaffold/.
async function runHelper(script: string, args: string[]): Promise<{ ok: boolean; entry: any; stdout: string; stderr: string; code: number | null }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("node", [path.join(WORKSPACE_PATH, "scripts", script), ...args], {
      cwd: WORKSPACE_PATH,
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      let entry: any = null;
      // Both scripts print the registry entry as JSON on stdout. Parse leniently —
      // if there's noise (npm install output etc), grab the last JSON object.
      const m = stdout.match(/\{[\s\S]*\}\s*$/);
      if (m) { try { entry = JSON.parse(m[0]); } catch {} }
      resolve({ ok: code === 0, entry, stdout, stderr, code });
    });
  });
}

app.post("/api/preview/:project/:feature/:action", async (req, res) => {
  try {
    const { project, feature, action } = req.params;
    assertSafeProjectFeature(project, feature);
    if (action !== "start" && action !== "stop") {
      return res.status(400).json({ error: "bad_action", message: "action must be start or stop" });
    }
    if (action === "stop") {
      return res.json({
        ok: true,
        action,
        noop: true,
        message: "The companion app is a static page — there is no dev server to stop.",
      });
    }
    const result = await runHelper("render-companion-app.mjs", [project]);
    if (!result.ok) {
      return res.status(500).json({
        error: "render_failed",
        message: result.stderr?.trim() || `render-companion-app.mjs exited with ${result.code}`,
      });
    }
    res.json({ ok: true, action, entry: result.entry });
  } catch (e: any) {
    console.error("[preview/action] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// 7b-bis. Brand extraction. The user pastes a client's URL in chat; this reads
//     that site and writes the companion app's theme from it. The fetch happens
//     server-side in scripts/extract-brand.mjs, never in the rendered page — the
//     companion app itself must stay at zero network requests, so the logo comes
//     back inlined as a data URI.
app.post("/api/brand/extract", async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    const url = String(req.body?.url || "").trim();
    if (!project || !url) {
      return res.status(400).json({ error: "missing_input", message: "project and url are required" });
    }
    // Branding is per project: one companion app, one palette. A `feature` in
    // the body is accepted and ignored so an older client keeps working.
    assertSafeProject(project);

    // Only http(s), and never a URL the script would have to resolve relative to
    // the server — this endpoint takes a target from chat input.
    let parsed: URL;
    try { parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch {
      return res.status(400).json({ error: "bad_url", message: `Not a URL: ${url}` });
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      return res.status(400).json({ error: "bad_url", message: "Only http(s) URLs can be read." });
    }

    const extract = await runHelper("extract-brand.mjs", [parsed.href, project, "--force"]);
    if (!extract.ok) {
      return res.status(502).json({
        error: "extract_failed",
        message: extract.stderr?.trim() || `extract-brand.mjs exited with ${extract.code}`,
      });
    }

    // Read back what was written rather than parsing stdout — the file is the
    // contract the renderer reads, so reporting it keeps the two from drifting.
    const styleDir = path.join(WORKSPACE_PATH, "projects", project, "design", "style-guides");
    const readJson = async (name: string) => {
      try { return JSON.parse(await fs.readFile(path.join(styleDir, name), "utf8")); } catch { return null; }
    };
    const theme = await readJson("theme.json");
    const source = await readJson("brand-source.json");

    // Re-render only if the project already has a companion app; a first render
    // belongs to the Build UI flow, not to a branding change.
    let rerendered = false;
    try {
      await fs.access(path.join(WORKSPACE_PATH, "generated-apps", project, "index.html"));
      rerendered = (await runHelper("render-companion-app.mjs", [project])).ok;
    } catch { /* no app built yet */ }

    res.json({
      ok: true,
      url: parsed.href,
      rerendered,
      theme: theme ? { ...theme, logoSrc: undefined, hasLogo: Boolean(theme.logoSrc) } : null,
      source,
    });
  } catch (e: any) {
    console.error("[brand/extract] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// 7c. Thin comment relay. The frontend reads the issue tree via /api/status/<parent>
//     and identifies the UI child issue (title starts with "Build UI"). It passes that
//     issueId here. We just post the comment — no agent-id filtering, no env vars.
app.post("/api/ui-agent/comment", async (req, res) => {
  try {
    const issueId = String(req.body?.issueId || "").trim();
    const body = String(req.body?.body || "").trim();
    if (!issueId || !body) {
      return res.status(400).json({ error: "issueId and body are required" });
    }
    await paperclip.addComment(issueId, body);
    res.json({ ok: true, issueId });
  } catch (e: any) {
    console.error("[ui-agent/comment] failed:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

async function spillToTemp(buffer: Buffer, name: string): Promise<string> {
  const os = await import("node:os");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scyne-upload-"));
  const p = path.join(dir, name.replace(/[^A-Za-z0-9._-]/g, "_") || "audio.bin");
  await fs.writeFile(p, buffer);
  return p;
}

// Serve the built React app from the same Express process (production / Docker).
// In local `npm run dev` there is no dist/ and Vite serves the frontend, so this
// block no-ops. The catch-all excludes /api and /ws so routes + the WS upgrade
// are untouched.
const STATIC_DIR = process.env.STATIC_DIR || path.resolve(process.cwd(), "dist");
if (fssync.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, "index.html"));
  });
  console.log(`[chatbot] serving static UI from ${STATIC_DIR}`);
}

const PORT = Number(process.env.PORT) || 4000;
const server = http.createServer(app);

// 8. WebSocket — live meeting recording.
//    Protocol (JSON messages over the same socket):
//      browser → server: { type: "start", project, feature }
//      browser → server: { type: "audio", data: <base64 16kHz mono PCM> }
//      browser → server: { type: "stop" }
//      server → browser: { type: "ready" }
//      server → browser: { type: "transcript_delta", speaker, text, timestampSec }
//      server → browser: { type: "transcript_done", speaker }
//      server → browser: { type: "saved", relativePath, filename, entryCount, durationSeconds }
//      server → browser: { type: "error", message }
const wss = new WebSocketServer({ server, path: "/ws/record" });

wss.on("connection", (ws: WSWebSocket) => {
  let session: MeetingSession | null = null;
  let project: string | null = null;
  let feature: string | null = null;
  let finalising = false;

  const send = (msg: any) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  ws.on("message", async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    try {
      if (msg.type === "start") {
        if (session) return;
        project = String(msg.project || "").trim();
        feature = String(msg.feature || "").trim();
        if (!project || !feature) {
          send({ type: "error", message: "project and feature are required" });
          return;
        }
        assertSafeProjectFeature(project, feature);
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          send({ type: "error", message: "GEMINI_API_KEY is not set on the server" });
          return;
        }
        session = new MeetingSession({
          apiKey,
          onEvent: (e) => send(e),
        });
        try {
          await session.start();
        } catch (err: any) {
          send({ type: "error", message: `Failed to open Gemini Live: ${err?.message ?? err}` });
          session = null;
        }
        return;
      }

      if (msg.type === "audio") {
        if (!session) return;
        if (typeof msg.data !== "string") return;
        session.sendAudio(msg.data);
        return;
      }

      if (msg.type === "stop") {
        if (!session || finalising) return;
        finalising = true;
        await finaliseSession();
        return;
      }
    } catch (err: any) {
      send({ type: "error", message: err?.message ?? String(err) });
    }
  });

  ws.on("close", async () => {
    if (session && !finalising) {
      finalising = true;
      try { await finaliseSession(); } catch { /* ignore */ }
    }
    if (session) {
      try { session.close(); } catch { /* ignore */ }
      session = null;
    }
  });

  async function finaliseSession() {
    if (!session || !project || !feature) return;
    const entries = session.getEntries();
    const duration = session.getDurationSeconds();
    session.close();
    if (entries.length === 0) {
      send({ type: "saved", relativePath: null, filename: null, entryCount: 0, durationSeconds: duration, empty: true });
      return;
    }
    try {
      const result = await writeTranscript({
        project,
        feature,
        workspace: WORKSPACE_PATH,
        source: "live-recording",
        entries,
        durationSeconds: duration,
      });
      send({
        type: "saved",
        relativePath: result.relativePath,
        filename: result.filename,
        entryCount: entries.length,
        durationSeconds: duration,
      });
    } catch (err: any) {
      send({ type: "error", message: `Failed to save transcript: ${err?.message ?? err}` });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Scyne chatbot API listening on http://127.0.0.1:${PORT}`);
  console.log(`Live recording WebSocket at ws://127.0.0.1:${PORT}/ws/record`);
});
