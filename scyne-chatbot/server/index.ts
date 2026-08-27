// FIRST: loads the ONE .env, at the workspace root, before any module
// below reads process.env at load time. See env.ts for why it is not
// `dotenv/config` (that resolved against cwd, which is scyne-chatbot/).
import "./env.js";
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { WebSocketServer, WebSocket as WSWebSocket } from "ws";
import { chat } from "./llm.js";
import * as store from "./store.js";
// The local binding stays `paperclip` on purpose: 33 call sites below, none
// of which needed to change when the backend did. Renaming it and swapping
// the backend in one pass would be two bugs wearing one coat.
import { orchestrator as paperclip } from "./orchestrator.js";
import type { RequirementParams } from "./types.js";
import { routeFile, uniqueName, requirementsDir, type Hint } from "./services/fileRouter.js";
import { WORKSPACE_PATH } from "./workspace.js";
import { slugProjectName, isNewProjectName, decideCreate } from "./names.js";
import {
  listDocuments, deleteDocument, resolveDocument, readDocument, excerptOf,
  type DocumentEntry,
} from "./services/documents.js";
import { verifyAdoTarget, adoConfigured } from "./services/adoVerify.js";
import { verifyAtlassianTarget, atlassianConfigured } from "./services/atlassianVerify.js";

/**
 * Where this installation publishes. Mirrors the constant of the same name in
 * orchestrator.workflows.ts, which compiles the publish prompts — the two have
 * to agree or a project would be SET UP for one system and PUBLISHED to the
 * other. Both read the same environment variable rather than one importing the
 * other, because this file must not pull in the workflow compiler.
 */
const PUBLISH_TARGET = (process.env.PUBLISH_TARGET ?? "atlassian") as "atlassian" | "ado";
import { ensureAdoProject } from "./services/adoProject.js";
import { publishedLinks, mergeLinks } from "./publishedLinks.js";
// filterRunLog is the orchestrator package's own decoder — imported directly
// rather than kept as a second local copy. This chatbot previously carried a
// stale, Claude-vocabulary-only fork (services/runTranscript.ts) that had
// already drifted from the real one: the same fix (decoding a Codex
// transcript instead of rendering it empty) had already landed twice
// upstream, in packages/orchestrator/src/http/router.ts and
// packages/orchestrator/src/cli.ts, because nobody grepped for the sibling
// copy. One decoder, one place to fix it, is the whole point.
import { filterRunLog } from "../../packages/orchestrator/src/index.js";
import { writeTranscript } from "./services/transcriptWriter.js";
import { transcribeAudioFile } from "./services/geminiFiles.js";
import { MeetingSession } from "./services/geminiLive.js";
// The pipeline graph lives in scripts/ because the CLI, the renderer and this
// server all need the same answer to "what does this stage require". Importing
// it here rather than restating it is what stops the chatbot refusing a stage
// the CLI would happily run.
// Typed by server/pipeline.d.ts — ambient, because pipeline.mjs stays plain
// JavaScript on purpose (four consumers, one definition of the stage graph).
import * as pipeline from "../../scripts/pipeline.mjs";
// The converter's own list, imported rather than restated: what counts as a
// document here has to be exactly what step 0 of every stage can convert.
import { READABLE_AFTER_CONVERSION } from "../../scripts/convert-to-md.mjs";
// A document's extraction state, computed from disk. Presence is no longer
// readiness — see `extractionGate` below for why the gates read this instead
// of `countProjectDocs`/`countFeatureDocs` for the capability-map path.
import { projectState } from "../../scripts/extract-state.mjs";
import { planRetry } from "./services/extractRetry.js";
import {
  carryAuth, requireSession, login, logout, whoami,
  tokenFor, setSessionCookie, clearSessionCookie,
} from "./auth.js";

const app = express();
// `credentials: true` and an explicit origin, not the bare default: the
// browser will not send an httpOnly cookie cross-origin under a wildcard
// origin, and Vite serves the app on 5173 while this listens on 4000.
app.use(cors({
  origin: (process.env.CHATBOT_ORIGIN || "http://127.0.0.1:5173,http://localhost:5173").split(","),
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

// Every request carries its caller's credential into server/orchestrator.ts,
// so a run started from chat is attributed to the person who started it.
// Mounted before the routes, including the unauthenticated ones — carrying a
// null token is correct and lets each route decide for itself.
app.use(carryAuth);

// ---- identity ---------------------------------------------------------------
//
// The chatbot holds no user table. It forwards credentials to the
// orchestrator, which owns identity for the whole install, and keeps the
// session in an httpOnly cookie so a token is never readable from JavaScript.

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) { res.status(400).json({ error: "email and password are required" }); return; }
  const result = await login(String(email), String(password));
  // One message for an unknown address and a wrong password alike —
  // distinguishing them turns this form into a directory of who has an account.
  if (!result) { res.status(401).json({ error: "invalid email or password" }); return; }
  setSessionCookie(res, result.token);
  const me = await whoami(result.token);
  res.json(me ?? { ...result.user, company: null, isSuperadmin: false });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = tokenFor(req);
  if (token) await logout(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/whoami", async (req, res) => {
  const token = tokenFor(req);
  const me = token ? await whoami(token) : null;
  if (!me) {
    // A cookie the orchestrator no longer honours is worse than no cookie: it
    // makes the app look logged in and then fail every action. Clear it.
    clearSessionCookie(res);
    res.status(401).json({ error: "not_authenticated" });
    return;
  }
  res.json(me);
});

// Everything else under /api needs a session. Registered AFTER the auth routes
// so they stay reachable, and before every other route so none can be added
// later that quietly escapes it.
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth/")) { next(); return; }
  requireSession(req, res, next);
});

// Pull wiki page + work item URLs out of a set of comment bodies.
// Shared by /api/status (single run) and /api/history (all completed runs).
function extractLinks(bodies: string[]): { wiki: string[]; workItems: string[] } {
  // The keys name what they hold: an Azure DevOps wiki page and its work items.
  // They were `confluence`/`jira` until the destination change had settled —
  // see the note on `publishedLinks`, and the transcript migration in App.tsx,
  // which is the one consumer that survives a deploy holding the old shape.
  const wikiRe = /https?:\/\/dev\.azure\.com\/[^\s)>\]"']*_wiki\/[^\s)>\]"']+/g;
  const workItemRe = /https?:\/\/dev\.azure\.com\/[^\s)>\]"']*_workitems\/edit\/\d+/g;
  const wiki = new Set<string>();
  const workItems = new Set<string>();
  for (const body of bodies) {
    for (const m of body.matchAll(wikiRe)) wiki.add(m[0]);
    for (const m of body.matchAll(workItemRe)) workItems.add(m[0]);
  }
  return { wiki: [...wiki], workItems: [...workItems].sort() };
}

// 1. Chat — proxy to Gemini. `target` (optional) is the current target picker
//    selection in the UI; we forward it so the LLM stops re-asking when the
//    user has already selected a project/feature.
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, target, uiContext, conversationId } = req.body;
    const result = await chat(messages, target, uiContext, tokenFor(req));

    // Record the turn AFTER the model has answered, and never let the record
    // fail the answer. The conversation tables have existed unused since the
    // platform migration — the transcript lived in one browser's localStorage,
    // so it was per-device, invisible to `scyne chat history`, and gone with
    // the site data. Same best-effort contract as the document rows: the
    // outcome is reported in a field, not thrown.
    const recorded = await store.recordChatTurn(tokenFor(req), {
      conversationId: typeof conversationId === "string" ? conversationId : null,
      project: target?.project ?? null,
      feature: target?.feature ?? null,
      userMessage: Array.isArray(messages) ? messages[messages.length - 1]?.content ?? null : null,
      assistantMessage: (result as { content?: unknown })?.content ?? result,
    });
    if (recorded.state === "failed") {
      console.warn("[chat] the conversation was not recorded:", recorded.reason);
    }

    res.json({ ...result, conversationId: recorded.conversationId ?? conversationId ?? null });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// 1b. The project's chat — read it back, or forget it.
//
// A chat belongs to a project. The transcript used to live only in one
// browser's localStorage, so switching project kept the same thread and a
// second device saw nothing at all. These two put the database behind it.
//
// Both are best-effort in the same sense the recording is: a chat that cannot
// be loaded opens empty rather than failing, because the alternative is a
// person who cannot talk to the assistant at all.
app.get("/api/conversations", async (req, res) => {
  const project = String(req.query.project ?? "").trim();
  if (!project) return res.status(400).json({ error: "project_required" });
  const chat = await store.loadProjectChat(tokenFor(req), project);
  res.json(chat ?? { conversationId: null, messages: [] });
});

app.delete("/api/conversations", async (req, res) => {
  const project = String(req.query.project ?? "").trim();
  if (!project) return res.status(400).json({ error: "project_required" });
  const result = await store.clearProjectChat(tokenFor(req), project);
  if (result.state === "failed") {
    return res.status(502).json({ error: "clear_failed", message: result.reason });
  }
  res.json({ ok: true, cleared: result.cleared ?? 0, skipped: result.reason });
});

// 2. Trigger — create a Paperclip issue from a parameter bundle
app.post("/api/trigger", async (req, res) => {
  try {
    const overrides = (req.body ?? {}) as Partial<RequirementParams> & {
      feature_name?: string;
      project?: string;
      feature?: string;
    };
    const project = overrides.project || "SADA";
    const feature = overrides.feature || "interim-benefit";
    // The display name in the issue TITLE, and the same derivation the generic
    // stage route uses — the feature FOLDER name when the caller does not name
    // one. It used to fall back to a DEFAULT_FEATURE_NAME env var instead,
    // which no other route read: with it set to a SADA-era label, triggering
    // requirements for RTWSA/Appeals without an explicit name produced
    // `Generate requirements — Review & Verify Evidence (RTWSA/Appeals)` — a
    // title naming a different client's feature, on the one stage that
    // publishes a wiki page and creates the backlog. The LLM tool schema calls
    // the field "Override the default feature name", so omitting it is the
    // normal case, not an edge one.
    const feature_name = overrides.feature_name || feature;
    // The Azure DevOps target is ONE organisation and ONE project for the whole
    // install, unlike the Atlassian arrangement this replaced, where the space
    // key was derived per Scyne project. A wiki page path carries the project
    // and feature instead, so a single ADO project holds every client's work
    // without collision — and there is nothing to derive from a name.
    const params: RequirementParams = {
      process_l3: overrides.process_l3 || process.env.DEFAULT_PROCESS_L3,
      process_l4: overrides.process_l4 || process.env.DEFAULT_PROCESS_L4,
      starting_story_number: overrides.starting_story_number || process.env.DEFAULT_STARTING_STORY_NUMBER,
      ado_parent_epic_id: overrides.ado_parent_epic_id || process.env.ADO_PARENT_EPIC_ID || "",
      ado_org: overrides.ado_org || process.env.ADO_ORG,
      ado_project: overrides.ado_project || "",
      ado_wiki: overrides.ado_wiki || process.env.ADO_WIKI || "",
      // Both come from the project's own `adoTarget` in .published.json when
      // they are not passed. There is no installation-wide default any more:
      // an Agile project has `User Story`, the pre-existing shared project
      // runs Basic and has `Issue`, and guessing between them fails every
      // story at once — after the gate was approved.
      ado_work_item_type: overrides.ado_work_item_type || "",
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
      `Generated by the Scyne chatbot. Please produce the Product Summary and the work items.`,
      ``,
      `## Project + Feature`,
      `- Project: ${project}`,
      `- Feature: ${feature}`,
      ``,
      `## Parameters`,
      // The `(...)` form is this file's convention for "not set", and
      // parseParams drops any value shaped that way — so an unset default
      // becomes an absent param rather than the literal string "undefined"
      // stored in issues.params. These three are commented out in .env
      // because nothing downstream reads them; they are still carried when
      // someone sets one.
      `- Process L3: ${params.process_l3 || "(not set)"}`,
      `- Process L4: ${params.process_l4 || "(not set)"}`,
      `- Starting story number: ${params.starting_story_number || "(not set)"}`,
      `- ADO parent epic id: ${params.ado_parent_epic_id || "(none — create work items without a parent)"}`,
      `- ADO org: ${params.ado_org}`,
      `- ADO project: ${params.ado_project}`,
      `- ADO wiki: ${params.ado_wiki || "(the project's only wiki)"}`,
      `- ADO work item type: ${params.ado_work_item_type}`,
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
  { prefix: "Revise", flow: { key: "revision", worker: "the owning specialist", generatingLabel: "Revising the artefact", pushingLabel: "Updating the wiki" } },
  { prefix: "Generate requirements", flow: { key: "requirements", worker: "BA", generatingLabel: "BA generating artifacts", pushingLabel: "Publishing the page and work items" } },
  { prefix: "Generate data model", flow: { key: "data_model", worker: "Data Modeler", generatingLabel: "Data Modeler generating the impact analysis", pushingLabel: "Publishing to the wiki" } },
  { prefix: "Generate solution design", flow: { key: "solution_design", worker: "Architecture Lead", generatingLabel: "Architecture Lead designing the solution", pushingLabel: "Publishing to the wiki" } },
  // NOTE: "Generate solution design" and "Generate solution architecture" share
  // their first two words. classifyFlow uses startsWith on the FULL prefix, so
  // they resolve correctly — but never shorten either prefix to "Generate
  // solution", and keep both spelled out in the Delivery Lead's classifier too.
  { prefix: "Generate solution architecture", flow: { key: "solution_architecture", worker: "Solution Architect", generatingLabel: "Solution Architect designing the target architecture", pushingLabel: "Publishing to the wiki" } },
  { prefix: "Generate test cases", flow: { key: "test_cases", worker: "QA Architect", generatingLabel: "QA Architect designing the test pack", pushingLabel: "Publishing to the wiki" } },
  // The capability map publishes to its own wiki page, so "pushing" here is
  // a real publish step rather than a local finalise pass.
  { prefix: "Generate capability map", flow: { key: "capability_map", worker: "Capabilities Process Architect", generatingLabel: "Capabilities Process Architect mapping capabilities + process", pushingLabel: "Publishing to the wiki" } },
  { prefix: "Generate personas", flow: { key: "personas", worker: "Service Designer", generatingLabel: "Service Designer identifying personas + mapping journeys", pushingLabel: "Publishing to the wiki" } },
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

// Count the `.md` documents a stage can read for a feature: everything under
// projects/<p>/<f>/ except the generated trees (outputs/, solutions/, design/).
// For a standard feature that's requirements/{SOP,Transcripts,Notes}; a feature
// carrying its own reference document tree (e.g. companion/docs-md/*) counts too.
// Agents read markdown, so `md` is what actually counts — but `other` lets the
// refusal distinguish "this feature is empty" from "the sources are still
// .docx/.pdf and were never converted", which are different user actions.
/**
 * What a stage will find, split by what has to happen to it first.
 *
 * `readable` — `md` plus `convertible` — is what every gate asks about, and
 * for a while none of them did: they tested `md === 0` and refused a project
 * holding nothing but `.docx`. But `stage.mjs` runs the converter as its FIRST
 * step, so a `.docx` IS a document to every stage — and refusing the run is
 * exactly what stopped it reaching the converter that would have made it
 * readable. Two `.docx` uploaded to a new project produced
 * "There are 2 file(s) but none are markdown" on every retry, with no retry
 * that could ever have changed it.
 *
 * `other` stays separate because a `.png` is genuinely not a document the BA
 * can read, and telling somebody their screens count as discovery material
 * would be a different wrong answer.
 */
interface DocCount { md: number; convertible: number; other: number; readable: number }

// `original-files` is the ARCHIVE — every file in it is a source the converter
// already replaced with a markdown sibling that this walk counts separately.
// Without it, `countFeatureDocs` counted each converted document twice and, far
// worse, went on reporting documents for a feature whose `requirements/` had
// been emptied. `countProjectDocs` skipped it explicitly and this did not, so
// the two answered differently about the same tree.
const SKIP_DIRS = new Set(["outputs", "solutions", "design", "node_modules", "original-files"]);
/**
 * Directories under projects/<project>/ that belong to the PROJECT, not to a
 * feature. Kept in step with PROJECT_OWN_DIRS in scripts/pipeline.mjs — the CLI
 * and the chatbot must agree on what a feature is.
 */
const PROJECT_OWN_DIRS = new Set(["solutions", "documents", "design", "original-files", "outputs"]);

async function countFeatureDocs(project: string, feature: string): Promise<DocCount> {
  const root = path.join(WORKSPACE_PATH, "projects", project, feature);
  let md = 0;
  let convertible = 0;
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
        const ext = path.extname(e.name).toLowerCase();
        if (ext === ".md" || ext === ".markdown") md++;
        else if (READABLE_AFTER_CONVERSION.has(ext)) convertible++;
        else other++;
      }
    }
  }
  await walk(root, 0);
  return { md, convertible, other, readable: md + convertible };
}

/**
 * Every readable document the PROJECT has: its own `documents/` tree plus every
 * feature's discovery documents. The project-level stages read all of it, so
 * the gate has to see all of it too — a project whose documents all live under
 * features must not be told it has none.
 */
async function countProjectDocs(project: string): Promise<DocCount> {
  const root = path.join(WORKSPACE_PATH, "projects", project);
  const total: DocCount = { md: 0, convertible: 0, other: 0, readable: 0 };
  const add = (d: DocCount) => {
    total.md += d.md; total.convertible += d.convertible;
    total.other += d.other; total.readable += d.readable;
  };

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
// Delivery Lead to route. The Azure DevOps target is resolved per project from
// .published.json, so no publishing keys travel in the description.
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
  publishes?: boolean; // include the Azure DevOps target in the description
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
      } else if (isProject) {
        // The capability map is the one project-level stage gated on
        // documents rather than a prerequisite file, and it is also the one
        // stage that hard-requires the extracts (`STAGES.capabilities.requires`
        // in scripts/pipeline.mjs). Presence on disk is no longer enough — a
        // document that has not been extracted contributes nothing to the map,
        // so starting anyway produces a capability map with a silent hole.
        const gate = await extractionGate(project);
        if (gate.code) {
          return res.status(409).json({
            error: gate.code,
            message: gate.code === "no_documents"
              ? stage.gateMessage(project, feature)
              : `${gate.st.ready} of ${gate.st.documents.length} documents are ready. ` +
                `Waiting on: ${gate.st.documents.filter(d => d.state !== "ready")
                  .slice(0, 5).map(d => `${d.docId} (${d.state})`).join(", ")}`,
            extraction: {
              ready: gate.st.ready, missing: gate.st.missing,
              failed: gate.st.failed, extracting: gate.st.extracting,
            },
          });
        }
      } else {
        const docs = await countFeatureDocs(project, feature);
        // `readable`, not `md`: the workflow's FIRST step converts, so a
        // `.docx` is a document. Testing `md` refused the run and therefore
        // refused the conversion, which is the only thing that could have
        // changed the answer.
        //
        // Feature-level document gates (UI mockups) stay presence-based:
        // only the capability map hard-requires extracts, so a feature stage
        // gated on raw documents must not wait on an extraction pass it does
        // not consume.
        if (docs.readable === 0) {
          return res.status(409).json({ error: stage.gateErrorCode, ...docs, message: stage.gateMessage(project, feature, docs) });
        }
      }
      // Display name defaults to the feature folder; space key to the project
      // name (same derivation as /api/trigger). Both overridable via the body
      // for runs whose requirements used custom values.
      const feature_name = String(req.body?.feature_name || "").trim() || feature;
      const ado_org = String(req.body?.ado_org || "").trim() || process.env.ADO_ORG || "";
      const ado_project = String(req.body?.ado_project || "").trim();
      const ado_wiki = String(req.body?.ado_wiki || "").trim() || process.env.ADO_WIKI || "";
      // /api/approve VERIFIES the Azure DevOps target and never creates it, so
      // there are no provisioning keys to emit here. The target is resolved per
      // project from .published.json when the publish step runs.
      const description = [
        stage.intro,
        ``,
        isProject ? `## Project` : `## Project + Feature`,
        `- Project: ${project}`,
        ...(isProject ? [] : [
          `- Feature: ${feature}`,
          `- Feature name: ${feature_name}`,
        ]),
        ...(stage.publishes === false ? [] : [
          ``,
          `## Parameters`,
          `- ADO org: ${ado_org}`,
          `- ADO project: ${ado_project}`,
          `- ADO wiki: ${ado_wiki || "(the project's only wiki)"}`,
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
  intro: "Generated by the Scyne chatbot. Produce the Salesforce data model and publish it to the wiki.",
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
  intro: "Generated by the Scyne chatbot. Produce the Salesforce Solution Design Document and publish it to the wiki.",
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
// different skill, different folder, different wiki page.
app.post("/api/solution-architecture/trigger", stageTrigger({
  logTag: "solution-architecture/trigger",
  stageKey: "architecture",
  titlePrefix: "Generate solution architecture",
  intro: "Generated by the Scyne chatbot. Produce the Salesforce Service Cloud Solution Architecture Document and publish it to the wiki.",
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
  intro: "Generated by the Scyne chatbot. Produce the test pack (test cases, traceability matrix, coverage gap analysis) and publish it to the wiki.",
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
// publish, to its own wiki page. Its personas.json / journey-map.json are a
// build contract for the companion app.
// 2f. Personas — a PROJECT stage. The people a client serves belong to the
// organisation, not to one slice of work, so the persona set is generated once
// and every feature reads it. Gated on the CAPABILITY MAP: journey stages align
// to its L1 lifecycle phases, which is why the wizard runs the two in sequence.
app.post("/api/personas/trigger", stageTrigger({
  logTag: "personas/trigger",
  stageKey: "personas",
  level: "project",
  titlePrefix: "Generate personas",
  intro: "Generated by the Scyne chatbot. Identify the personas this CLIENT serves, map each one's journey, and publish to the wiki. The personas.json / journey-map.json outputs are consumed by the companion app.",
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
// it publishes to its own wiki page on approval — a page only, never work
// items.
app.post("/api/capability-map/trigger", stageTrigger({
  logTag: "capability-map/trigger",
  stageKey: "capabilities",
  level: "project",
  titlePrefix: "Generate capability map",
  intro: "Generated by the Scyne chatbot. Produce the Business Capability Map and the L1/L2/L3 Process Model for this PROJECT, from every document the client has. On approval, publish to its own wiki page — a page only, never work items.",
  gateErrorCode: "no_documents",
  gateMessage: (p, _f, docs) =>
    docs && docs.other > 0
      ? `No documents for ${p}. There are ${docs.other} file(s), but none is a document the agents can read — images and audio do not count as discovery material. Upload an SOP, transcript or note (.md, .docx, .pdf, .txt all work — they are converted on the way in).`
      : `No documents found for ${p}. Upload at least one SOP, transcript or note (or a reference document tree) before generating the capability map.`,
  inputs: (p) => [
    `Working folder: projects/${p}/solutions/Capabilities/ — stage the documents there, then run the skill.`,
    `- Stage with: node scripts/stage.mjs ${p} capabilities (converts to markdown and stages every document the project has)`,
    `- projects/${p}/documents/ (the project's own client-wide policy, legislation and standards)`,
    `- every feature's requirements/{SOP,Transcripts,Notes}/ and any other .md tree, except outputs/, solutions/ and design/`,
    `- Outputs: solutions/Capabilities/outputs/{capability-map.json,process-model.json,capability-process.md}`,
    `- Validate with: node scripts/render-capability-map.mjs ${p} --validate-only`,
    `- Then update the project's single page: node scripts/render-companion-app.mjs ${p}`,
    `- On approval, publish capability-process.md to its own wiki page "${p} — Capability & Process Map". The wiki renders \`\`\`mermaid fences itself, so nothing needs converting to an image.`,
  ],
}));

// 2h. UI mockups — the UX Designer turns everything the feature has produced into
// a screen specification, rendered as themed HTML pages linked from the companion
// app's UI tab. It publishes nothing (publishes: false) — unlike the capability
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
  intro: "Generated by the Scyne chatbot. Design the UI mockups (wireframes) for this feature — one JSON screen specification, rendered into themed HTML pages linked from the companion app's UI tab. Local artefacts only — nothing is published to the wiki and no work items are created.",
  gateErrorCode: "no_documents",
  gateMessage: (p, f, docs) =>
    docs && docs.other > 0
      ? `No documents for ${p}/${f}. There are ${docs.other} file(s), but none is a document the agents can read — the screens in requirements/UI/ are designs, not discovery material. Upload an SOP, transcript or note (.md, .docx, .pdf, .txt all work — they are converted on the way in).`
      : `No documents found for ${p}/${f}. Upload at least one SOP, transcript or note — or generate the requirements first — before designing the screens.`,
  publishes: false,
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

    // Agent id -> display name, so a comment written BY an agent is attributed
    // to a person's role rather than to a uuid. One call, reused for the whole
    // tree; a failure degrades to showing the id, never to failing the request.
    const agentNames: Record<string, string> = {};
    for (const a of await paperclip.listAgents().catch(() => [] as any[])) {
      if (a?.id) agentNames[a.id] = a.name ?? a.key ?? a.id;
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
        // The orchestrator returns SQL rows verbatim — `author_user`,
        // `author_agent_id`, `created_at`. These camelCase names are
        // Paperclip's and were never updated when the backend changed, so
        // every comment resolved to "system" with an undefined timestamp:
        // the author was wrong AND the sort below had nothing to sort on.
        // Both shapes are read so a Paperclip-era payload still works.
        const agentId = c.author_agent_id ?? c.authorAgentId ?? null;
        flatComments.push({
          id: c.id,
          issueId: node.id,
          issueIdentifier: node.identifier,
          body: c.body ?? c.content ?? "",
          author: c.authorAgentName ?? c.authorUserName
            ?? (agentId ? agentNames[agentId] ?? agentId : null)
            ?? c.author_user ?? c.authorUserId ?? "system",
          createdAt: c.created_at ?? c.createdAt ?? null,
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

    // Extract wiki page + work item URLs from all comments. This is only HALF the
    // answer and used to be all of it — see `commentLinks` merged with the
    // disk-derived set below.
    const commentLinks = extractLinks(flatComments.map((c) => String(c.body)));

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
    // `params` is what the ENGINE was actually given, so it beats re-reading
    // the prose we wrote for a human. The description parse stays as the
    // fallback: the UI-build flow and anything created before params were
    // recorded have only the text.
    const rootParams = ((tree as any)?.params ?? {}) as Record<string, unknown>;
    // A blank param is an ABSENT one. `?? pick(...)` alone would take an empty
    // string as an answer and stop reading the description.
    const fromParams = (key: string) => {
      const v = rootParams[key];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    };
    const target = {
      project: fromParams("project") ?? pick("project"),
      feature: fromParams("feature") ?? pick("feature"),
    };

    // The other half of the links, and the half that was missing entirely.
    //
    // Nothing writes a published URL into a comment — the engine narrates a
    // step's label and an agent's duration, deliberately, and the publish
    // agent's URL goes to its own stdout and nowhere else. So `extractLinks`
    // over the comments found nothing on a run that had published perfectly,
    // and the chat announced nothing after an approval. These come from the
    // records `verify-published.mjs` refuses to let an issue past without, so
    // they exist for every run that reached `done` — including ones that
    // finished before this code did.
    //
    // Merged rather than replacing: a URL genuinely written into a comment (a
    // person pasting one, a future step that posts one) should still show.
    const diskLinks = await publishedLinks(WORKSPACE_PATH, {
      project: String(target.project ?? ""),
      feature: target.feature,
      workflowKey: String((tree as any)?.workflow_key ?? ""),
    }).catch(() => ({ wiki: [], workItems: [] }));

    const links = mergeLinks(commentLinks, diskLinks);

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
  // Same null /api/status already guards for: a root the database no longer
  // has, which a browser keeps polling from localStorage after a reset.
  // "Not found" is the honest answer; throwing on the APPROVE path is the
  // worst place to do it, because the user is mid-decision.
  if (!tree) return null;
  function walk(node: any): string | null {
    if (!node) return null;
    if ((node.approvals ?? []).some((a: any) => a.id === interactionId)) return node.id;
    for (const c of node.children ?? []) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  }
  return walk(tree);
}

// 4. Approve — accept the underlying interaction. VERIFY the Azure DevOps target
//    (project, wiki, token scopes) BEFORE resolving the gate, so the publish step
//    lands somewhere that exists. It verifies and never creates.
app.post("/api/approve/:approvalId", async (req, res) => {
  try {
    const approvalId = req.params.approvalId;
    const parentIssueId = String(req.body?.parentIssueId || "").trim();
    if (!parentIssueId) {
      return res.status(400).json({ error: "parentIssueId is required to locate the interaction" });
    }
    // Confirm the Azure DevOps target BEFORE resolving the gate, keyed on the
    // DATA in the issue description rather than on its title. A flow that
    // declares no ADO org is not a publishing flow (the UI build, for one) and
    // is skipped entirely.
    //
    // VERIFY, never create — see services/adoVerify.ts. Creating an ADO project
    // is a long-running asynchronous operation and a half-created one is worse
    // to hand a client than a clear refusal.
    //
    // Two back ends, and WHICH ONE is a property of the PROJECT rather than of
    // this request: the target is recorded in `.published.json` and every
    // publishing script reads it from there, so keying this check off anything
    // else could verify a system the publish is not going to use — and pass.
    if (atlassianConfigured()) {
      try {
        const issue: any = await paperclip.getIssue(parentIssueId);
        const desc = String(issue?.description || "");
        const scyneProject =
          (desc.match(/-\s*Project:\s*(.+)/) || [])[1]?.trim() || "";
        if (scyneProject) {
          const publishedFile = path.join(
            WORKSPACE_PATH, "projects", scyneProject, ".published.json");
          let published: any = null;
          try { published = JSON.parse(await fs.readFile(publishedFile, "utf8")); } catch { /* not published yet */ }
          const target = published?.atlassianTarget;
          // Only a project that actually publishes to Atlassian is checked
          // here. One carrying an `adoTarget` falls through to the Azure block
          // below, which is what keeps a project on the system it has already
          // delivered into.
          if (target?.space) {
            const result = await verifyAtlassianTarget({
              space: String(target.space),
              jiraProject: target.jiraProject ? String(target.jiraProject) : undefined,
              issueType: target.issueType ? String(target.issueType) : undefined,
              // Only the requirements flow creates issues; the rest publish a
              // page only, and failing them on a Jira project they never touch
              // would block an approval for no reason.
              needsIssues: /requirement/i.test(String(issue?.title || "")),
            });
            console.log("[approve] verifyAtlassianTarget:",
              JSON.stringify({ ok: result.ok, summary: result.summary }));
            if (!result.ok) {
              return res.status(502).json({
                error: "atlassian_target_unavailable",
                message:
                  `Approving would publish to Confluence, and the target is not ready:\n  ${result.summary}\n\n` +
                  `Nothing has been approved. Fix the target and approve again — it is far cheaper ` +
                  `to discover this now than after the publish step has built a document.`,
                checks: result.checks,
              });
            }
          }
        }
      } catch (e: any) {
        return res.status(502).json({ error: "atlassian_verify_failed", message: e?.message ?? String(e) });
      }
    }
    if (adoConfigured()) {
      try {
        const issue: any = await paperclip.getIssue(parentIssueId);
        const desc = String(issue?.description || "");
        const grab = (label: string) =>
          (desc.match(new RegExp(`-\\s*${label}:\\s*(.+)`)) || [])[1]?.trim() || "";
        const org = grab("ADO org") || process.env.ADO_ORG || "";
        const project = grab("ADO project") || "";
        const wikiRaw = grab("ADO wiki");
        const wiki = wikiRaw.startsWith("(") ? "" : wikiRaw;
        if (org && project) {
          const typeRaw = grab("ADO work item type");
          const result = await verifyAdoTarget({
            org, project, wiki: wiki || undefined,
            workItemType: typeRaw && !typeRaw.startsWith("(") ? typeRaw : undefined,
            // Only the requirements flow pushes work items; the rest publish a
            // page only, and failing them on a work-item scope they never use
            // would block an approval for no reason.
            needsWorkItems: Boolean(grab("ADO parent epic id")) || /requirement/i.test(String(issue?.title || "")),
          });
          console.log("[approve] verifyAdoTarget:", JSON.stringify({ ok: result.ok, summary: result.summary }));
          if (!result.ok) {
            return res.status(502).json({
              error: "ado_target_unavailable",
              message:
                `Approving would publish to Azure DevOps, and the target is not ready:\n  ${result.summary}\n\n` +
                `Nothing has been approved. Fix the target and approve again — it is far cheaper ` +
                `to discover this now than after the publish step has built a document.`,
              checks: result.checks,
            });
          }
        }
      } catch (e: any) {
        return res.status(502).json({ error: "ado_verify_failed", message: e?.message ?? String(e) });
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
// across all sessions, with their wiki page + work item links. Lists top-level
// "Generate …" issues and extracts links from each run's comment tree. Build UI
// runs stay excluded — they publish nothing.
const HISTORY_PREFIXES = FLOWS.filter((f) => f.flow.key !== "ui").map((f) => f.prefix);
// ---- stopping a run ---------------------------------------------------------
//
// The chatbot is where most runs are started, so it is where most of them need
// stopping. The orchestrator owns the semantics; these routes only forward,
// carrying the signed-in user's credential so the audit trail names a person.

app.post("/api/issues/:issueId/pause", async (req, res) => {
  try {
    const force = Boolean((req.body ?? {}).force);
    res.json(await paperclip.pauseIssue(req.params.issueId, force));
  } catch (err: any) {
    res.status(502).json({ error: "pause_failed", message: String(err?.message ?? err) });
  }
});

app.post("/api/issues/:issueId/cancel", async (req, res) => {
  try {
    res.json(await paperclip.cancelIssue(req.params.issueId));
  } catch (err: any) {
    res.status(502).json({ error: "cancel_failed", message: String(err?.message ?? err) });
  }
});

app.post("/api/issues/:issueId/resume", async (req, res) => {
  try {
    res.json(await paperclip.resumeIssue(req.params.issueId));
  } catch (err: any) {
    // A cancelled issue answers 409 upstream, which is a legible refusal
    // rather than a fault — pass the reason through rather than flattening
    // every failure into "something went wrong".
    res.status(502).json({ error: "resume_failed", message: String(err?.message ?? err) });
  }
});

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
        // The same two halves as /api/status: comments carry no published URL,
        // so a history built from them alone listed every completed run with an
        // empty links column. See server/publishedLinks.ts.
        let disk = { wiki: [] as string[], workItems: [] as string[] };
        try {
          const tree = await paperclip.getIssueTree(run.id);
          const collect = (node: any) => {
            if (!node) return;   // a deleted root returns null, not a tree
            for (const c of node.comments ?? []) bodies.push(String(c.body ?? c.content ?? ""));
            for (const ch of node.children ?? []) collect(ch);
          };
          collect(tree);
          const params = (tree?.params ?? {}) as Record<string, string>;
          disk = await publishedLinks(WORKSPACE_PATH, {
            project: String(params.project ?? ""),
            feature: params.feature ?? null,
            workflowKey: String(tree?.workflow_key ?? ""),
          });
        } catch { /* skip unreadable run */ }
        return {
          id: run.id,
          identifier: run.identifier,
          title: run.title,
          status: run.status,
          completedAt: run.updatedAt ?? run.createdAt ?? null,
          links: mergeLinks(extractLinks(bodies), disk),
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
    // `n?.children`, not `n.children`. getIssueTree returns NULL for a root
    // that no longer exists — deliberately, because a browser keeps
    // `scyne_parent_issue_id` in localStorage and goes on polling an issue that
    // a database reset removed. The first line already guarded for that; this
    // one did not, so every poll after a reset threw
    // "Cannot read properties of null (reading 'children')" and the panel 500ed
    // until someone cleared their storage.
    (function collect(n: any) {
      if (n?.id) idToIdent.set(n.id, n.identifier ?? n.id);
      for (const c of n?.children ?? []) collect(c);
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
    // Pass the run's own adapter, or a Codex run decodes through the
    // Claude-only default and renders empty — see the import comment above.
    const { events, consumed } = filterRunLog(log.content || "", run?.adapter);
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

// What a NEW project may be called, and what a typed name becomes, live in
// `./names.ts` — one rule the wizard, this route and the CLI all share. There
// used to be a copy here that the wizard did not use, which is how the Next
// button came to light up on a name this route was about to refuse.

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

    // The file is what every SKILL reads; the row is what the ASSISTANT reads
    // to decide whether to ask for a definition. Writing only the file left it
    // asking for one the project already had, on every turn. See
    // store.saveDescription.
    const db = await store.saveDescription(tokenFor(req), project, body);
    if (!db.ok) console.warn(`[project-description] ${project}: not saved to the database — ${db.reason}`);

    res.json({
      ok: true, project, path: `projects/${project}/description.md`, bytes: content.length,
      // Reported rather than swallowed: a caller that says "saved" when only
      // half of it was is how this went unnoticed in the first place.
      savedToDatabase: db.ok, databaseError: db.ok ? undefined : db.reason,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/api/features", async (req, res) => {
  // The DATABASE, over the orchestrator's API — not a walk of projects/ on
  // disk. The two disagree the moment a reset clears one and leaves the other,
  // and this endpoint feeds the target picker: a feature listed here that the
  // orchestrator has never heard of is one every trigger would refuse.
  try {
    res.json(await store.available(tokenFor(req)));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});


// ─── Ops: issues, spend, actions ─────────────────────────────────────────────
//
// The three reads that make this app a client rather than only a launcher.
// Each forwards the CALLER's token, so what a person sees here is exactly what
// they would see from `scyne` or the console — the authorisation lives in the
// orchestrator and is not re-implemented, widened or cached here.

/**
 * Render one ops read, preserving the upstream status.
 *
 * A 403 is NOT collapsed into an empty list. Spend and the organisation-wide
 * audit are admin-only upstream, and an empty table shown to a member reads as
 * "nothing has been spent" — a confident wrong answer where "you are not
 * allowed to see this" is the true one.
 */
function sendOps(res: any, r: { ok: boolean; status: number; data: unknown }): void {
  if (r.ok) { res.json(r.data); return; }
  const error =
    r.status === 403 ? "forbidden" :
    r.status === 401 ? "not_authenticated" :
    r.status === 503 ? "orchestrator_unreachable" : "upstream_error";
  const message =
    r.status === 403 ? "Your role cannot see this. An administrator can." :
    r.status === 503 ? "The orchestrator is not reachable — start it with `npm run dev`." :
    `The orchestrator answered ${r.status}.`;
  res.status(r.status).json({ error, message });
}

app.get("/api/issues", async (req, res) => {
  try {
    sendOps(res, await store.listIssues(tokenFor(req), {
      ...(req.query.project ? { project: String(req.query.project) } : {}),
      ...(req.query.feature ? { feature: String(req.query.feature) } : {}),
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      // `?open` with no value is still "open" — a bare flag in a query string
      // arrives as the empty string, which is falsy and would silently do
      // nothing.
      ...(req.query.open !== undefined && String(req.query.open) !== "false" ? { open: true } : {}),
    }));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/api/spend", async (req, res) => {
  try {
    const query: Record<string, string> = { by: String(req.query.by || "project") };
    for (const k of ["project", "feature", "user", "since", "until"]) {
      if (req.query[k]) query[k] = String(req.query[k]);
    }
    sendOps(res, await store.spend(tokenFor(req), query));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/api/actions", async (req, res) => {
  try {
    sendOps(res, await store.actions(tokenFor(req), Number(req.query.limit ?? 100)));
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
    const requested = String(req.body?.project || "").trim();
    // Slugged rather than refused. The rule is unchanged — that name becomes
    // the Azure DevOps project, the wiki path segment and the folder every
    // agent resolves against — but a person types "SA Power Networks" and the
    // wizard shows them what it will be created as before they commit. One
    // name results, so there is no display-name-to-slug mapping to keep in step.
    const project = slugProjectName(requested);
    const description = String(req.body?.description || "").trim();
    const website = String(req.body?.website || "").trim();

    if (!isNewProjectName(project)) {
      return res.status(400).json({
        error: "bad_project",
        requestedName: requested,
        message: "Use letters, numbers, spaces and . _ & - only (not starting or ending with a dot).",
      });
    }
    const root = path.join(WORKSPACE_PATH, "projects", project);

    // The DATABASE decides whether this project exists. It did not use to: this
    // route called `fs.access` on a folder and then read `.published.json` out
    // of it, which made a directory the system of record for a fact the
    // database owns — and `core/materialise.ts` is explicit that "the store is
    // the system of record now". The two disagree the moment they can: pointing
    // DATABASE_URL at a fresh server left seven project folders on disk, so
    // this route refused to create a project the database had never heard of,
    // naming an Azure DevOps target it could not see.
    //
    // Everything below still WRITES to disk — six skills read
    // `projects/<p>/description.md` by path, the renderer reads
    // `design/style-guides/theme.json`, and the publish scripts read
    // `.published.json`. Those files are derived from the row now, not the
    // other way round. Nothing here DECIDES anything by reading disk.
    const token = tokenFor(req);
    if (!token) {
      // This used to half-succeed: `store.createProject` returned `skipped`,
      // the tree was written anyway, and the caller got `ok: true` for a
      // project no API could see. With the row as the record there is nothing
      // to half-succeed at.
      return res.status(401).json({
        error: "not_authenticated",
        message: "Sign in before creating a project — the project row is the record, and writing it needs your session.",
      });
    }

    let row = (await store.listProjects(token)).find(p => p.name === project) ?? null;

    // The rule itself lives in names.ts, next to the slug it depends on, and is
    // tested there. A project whose Azure DevOps setup failed is INCOMPLETE,
    // not taken: refusing it would strand it, because this route is the only
    // way to create the target and it is the thing being refused.
    const decision = decideCreate({ existing: row, requested, project });
    if (decision === "exists") {
      return res.status(409).json({
        error: "exists", project, requestedName: requested,
        message: requested === project
          ? `A project called "${project}" already exists.`
          : `"${requested}" becomes "${project}", and a project by that name already exists.`,
      });
    }
    if (decision === "slug_collision") {
      return res.status(409).json({
        error: "slug_collision", project, requestedName: requested,
        message: `"${requested}" becomes "${project}", which already exists but is incomplete. ` +
          `If that is the project you meant, enter "${project}" exactly to finish setting it up.`,
      });
    }
    if (decision === "complete") {
      console.log(`[projects] ${project} exists but has no Azure DevOps target — completing it`);
    }

    // The row, FIRST and FATALLY.
    //
    // It used to be written last and best-effort, on the reasoning that "a
    // project with a tree and no row is incomplete, not broken". That was true
    // only while the tree was the record. Now the row IS the project: a create
    // that leaves none has created nothing, the next create cannot see what
    // this one did, and every symptom lands somewhere else — the definition
    // silently fails to save, /spend files the runs under the anonymous row,
    // and /projects/{id}/documents has no id to reach.
    //
    // So a database failure stops here, before an Azure DevOps project is
    // created for a Scyne project that does not exist. The reverse order is
    // what leaves rubbish in a client's ADO organisation.
    const db = await store.createProject(token, { name: project, description, website });
    if (!db.project) {
      // Two different failures, and the fix for each is different.
      //
      // `exists` with no visible row means the name is held somewhere this
      // caller cannot see — project names are unique across the whole install
      // (`projectNameTaken` is deliberately not scoped to one organisation,
      // because the folder tree is flat), so another organisation's project
      // can refuse a name that is absent from every listing you can read.
      // Answering `db_unavailable` for that would send someone to check a
      // database that is working perfectly.
      if (db.state === "exists") {
        return res.status(409).json({
          error: "name_taken", project, requestedName: requested,
          message: db.reason ?? `The name "${project}" is already held.`,
        });
      }
      console.error(`[projects] ${project}: not recorded in the database — ${db.reason}`);
      return res.status(502).json({
        error: "db_unavailable", project, requestedName: requested,
        message: `The project row could not be written, so nothing was created: ${db.reason ?? "unknown error"}`,
      });
    }
    row = db.project;

    // Scaffold directories, kept. They hold nothing, but several readers walk
    // them before writing (and blob has no concept of an empty directory, so a
    // restored project comes back without them). Cheap insurance, and not a
    // record of anything.
    for (const d of PROJECT_SCAFFOLD) await fs.mkdir(path.join(root, ...d.split("/")), { recursive: true });

    // The definition is optional at creation time but changes every skill's
    // output, so it is asked for in step 1 rather than chased later.
    //
    // `projects.description` above is the record. This file is the DERIVED
    // copy, and it stays because six skills read `projects/<p>/description.md`
    // by that exact path (requirement-generator, capability-process-map,
    // persona-journey-map, salesforce-data-modeler, solution-design-document
    // and requirements-test-case-generator all name it in their SKILL.md).
    let definitionWritten = false;
    if (description.length >= 40) {
      const content = description.startsWith("#")
        ? description + "\n"
        : `# ${project} — Project Definition\n\n${description}\n`;
      await fs.writeFile(path.join(root, "description.md"), content, "utf8");
      definitionWritten = true;
    }

    // The Azure DevOps target, resolved once and recorded — in the COLUMN,
    // `projects.ado_target`, which is what this route reads back above to tell
    // "already taken" from "incomplete, finish it". It used to live in
    // `.published.json` and nowhere else, which is the bug this whole change
    // exists to remove.
    //
    // `.published.json` is still written, because the publish scripts and the
    // agents read it BY PATH inside the materialised tree
    // (`ado-publish.mjs`, `ado-workitems.mjs --published-json`,
    // `resolvePagePath` in scripts/lib/ado.mjs). It is derived from the column
    // now. Note that only `adoTarget` moves: the per-artefact `ado.<artefact>`
    // page paths that live beside it are written by AGENTS mid-run and
    // harvested back, so a column mirroring those would be stale from the
    // first publish onwards.
    //
    // A failure here is NOT fatal: the row, the definition and the branding
    // are real and worth keeping. It returns with `adoError` set and a null
    // target, leaving the project INCOMPLETE rather than broken — re-posting
    // this route completes it.
    //
    // WHICH target depends on PUBLISH_TARGET. Atlassian records a space and a
    // Jira project and creates NEITHER — `verify, never create` is the rule
    // that governs the whole Atlassian path (see services/atlassianVerify.ts),
    // and it starts here: a space conjured into a client's site by a project
    // wizard is a decision about where their documents live being made by a
    // form. The names are DERIVED from the project name rather than asked for,
    // so the common case needs no extra field, and an operator who wants
    // different ones edits `.published.json` before the first publish.
    let atlassianTarget: any = null;
    let atlassianError: string | null = null;
    if (PUBLISH_TARGET === "atlassian") {
      const site = process.env.ATLASSIAN_SITE_URL ?? null;
      // A Confluence space key and a Jira project key are both uppercase
      // alphanumeric. Derived, not invented: the same slug the project already
      // is, with the characters those keys cannot carry removed.
      const key = project.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10)
        || "SCYNE";
      atlassianTarget = { site, space: key, jiraProject: key };
      const wrote = await store.updateProject(token, row.id, { atlassianTarget } as any);
      if (wrote.state === "failed") {
        atlassianError = `The Atlassian target was not recorded on the project row: ${wrote.reason}`;
        console.error(`[projects] ${project}: atlassian_target not persisted — ${wrote.reason}`);
      }
      const publishedFile = path.join(root, ".published.json");
      let current: any = {};
      try { current = JSON.parse(await fs.readFile(publishedFile, "utf8")); } catch { /* first write */ }
      current.atlassianTarget = atlassianTarget;
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(publishedFile, JSON.stringify(current, null, 2) + "\n", "utf8");
      if (!site) {
        atlassianError =
          "ATLASSIAN_SITE_URL is not set, so publishing will refuse until it is. " +
          "The project itself is fine.";
      }
    }

    let adoTarget: any = null;
    let adoError: string | null = null;
    if (PUBLISH_TARGET === "ado" && process.env.ADO_ORG) {
      const ensured = await ensureAdoProject({ org: process.env.ADO_ORG, project });
      if (ensured.ok) {
        const wrote = await store.updateProject(token, row.id, { adoTarget: ensured.target as any });
        if (wrote.state === "failed") {
          // Reported, not swallowed, and not fatal: the ADO project genuinely
          // exists now. What is lost is this route's ability to recognise that
          // on a re-post, which is a state a person can act on once told.
          adoError = `Azure DevOps is set up, but the target was not recorded on the project row: ${wrote.reason}`;
          console.error(`[projects] ${project}: ado_target not persisted — ${wrote.reason}`);
        }
        const publishedFile = path.join(root, ".published.json");
        let current: any = {};
        try { current = JSON.parse(await fs.readFile(publishedFile, "utf8")); } catch { /* first write */ }
        current.adoTarget = ensured.target;
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(publishedFile, JSON.stringify(current, null, 2) + "\n", "utf8");
        adoTarget = ensured.target;
      } else {
        adoError = ensured.error;
        console.error(`[projects] ${project}: Azure DevOps setup failed — ${ensured.error}`);
      }
    } else if (PUBLISH_TARGET === "ado") {
      adoError = "ADO_ORG is not set, so no Azure DevOps project was created.";
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
            // `projects.theme` has been a supported jsonb column since
            // 002_platform, read and patchable through the platform API, and
            // NOTHING has ever written it: every project in the database
            // carried the default `{}` while its real palette sat in a file.
            // Same class of bug as ado_target, same one-line fix.
            const themed = await store.updateProject(token, row.id, { theme: t });
            if (themed.state === "failed") {
              console.error(`[projects] ${project}: theme not persisted — ${themed.reason}`);
            }
          } catch { /* written but unreadable — treat as no brand */ }
        } else {
          brandError = extract.stderr?.trim() || `extract-brand.mjs exited with ${extract.code}`;
        }
      }
    }

    if (db.reason) console.log(`[projects] ${project}: database — ${db.state} (${db.reason})`);

    console.log(`[projects] created ${project} (definition=${definitionWritten}, brand=${Boolean(brand)}, ` +
      `publishTarget=${PUBLISH_TARGET}, ado=${Boolean(adoTarget)}, atlassian=${Boolean(atlassianTarget)}, db=${db.state})`);
    res.json({
      ok: true, project, requestedName: requested,
      // Only when it differs — a caller should not have to compare two strings
      // to decide whether there is anything to tell the person.
      slugged: requested !== project ? { from: requested, to: project } : null,
      definitionWritten, brand, brandError, adoTarget, adoError,
      atlassianTarget, atlassianError,
      db, projectId: row.id,
      // Always null on a success now, and kept only so existing callers keep
      // reading a field that exists. A database failure cannot reach this
      // point: it is fatal above and answers `502 db_unavailable`, because a
      // create that leaves no row has created nothing.
      dbError: null,
    });
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
    // The DATABASE decides, exactly as it does for a project. This route had
    // the same defect: `fs.access` on `projects/<p>` answered "does this
    // project exist" and `fs.access` on `projects/<p>/<f>` answered "is this
    // feature taken", so both questions were being put to a directory. Left
    // alone it would fail the other way round from the project route — a
    // folder tree surviving a DATABASE_URL change would let a feature be
    // "created" under a project that exists nowhere the API can see.
    const token = tokenFor(req);
    if (!token) {
      return res.status(401).json({
        error: "not_authenticated",
        message: "Sign in before creating a feature — the feature row is the record, and writing it needs your session.",
      });
    }

    const db = await store.createFeature(token, { project, feature });
    if (db.state === "failed") {
      console.error(`[features] ${project}/${feature}: not recorded in the database — ${db.reason}`);
      // `createFeature` reports a missing PROJECT distinctly, because the fix
      // is a different one — create the project, not the feature.
      const noProject = /is not in the database yet/.test(db.reason ?? "");
      return res.status(noProject ? 404 : 502).json({
        error: noProject ? "no_project" : "db_unavailable", project, feature,
        message: noProject
          ? `No project called "${project}" in the database. If its folder is on disk, \`npm run sync:docs -- --apply\` records it.`
          : `The feature row could not be written, so nothing was created: ${db.reason}`,
      });
    }
    if (db.state === "exists") {
      return res.status(409).json({ error: "exists", message: `${project} already has a feature called "${feature}".` });
    }

    // The working tree, derived. `stage.mjs` and the upload routes write into
    // these, and blob has no concept of an empty directory — so a project
    // restored from blob comes back without them.
    const root = path.join(WORKSPACE_PATH, "projects", project, feature);
    for (const d of FEATURE_SCAFFOLD) await fs.mkdir(path.join(root, ...d.split("/")), { recursive: true });

    console.log(`[features] created ${project}/${feature} (db=${db.state})`);
    res.json({
      ok: true, project, feature, db,
      // Always null now: a database failure is fatal above and answers 502.
      dbError: null,
    });
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
    const gate = await extractionGate(project);
    if (gate.code) {
      return res.status(409).json({
        error: gate.code,
        message: gate.code === "no_documents"
          ? `No documents for ${project} yet. Upload at least one policy, SOP or transcript first.`
          : `${gate.st.ready} of ${gate.st.documents.length} documents are ready. ` +
            `Waiting on: ${gate.st.documents.filter(d => d.state !== "ready")
              .slice(0, 5).map(d => `${d.docId} (${d.state})`).join(", ")}`,
        extraction: {
          ready: gate.st.ready, missing: gate.st.missing,
          failed: gate.st.failed, extracting: gate.st.extracting,
        },
      });
    }
    const description = [
      "Generated by the Scyne chatbot. Build this project's baseline in ONE pass: the capability map, then the personas, then ONE approval gate.",
      ``,
      `## Project`,
      `- Project: ${project}`,
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
      `On approval, Phase 2 publishes BOTH wiki pages:`,
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
 * On approval it UPDATES the existing wiki page rather than creating a
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
        `- On approval, UPDATE the existing wiki page: read projects/${project}/.published.json for the ado.<artefact> record and republish to its recorded wikiPath. Only create a page if there is no entry, and write the entry back either way.`,
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

/**
 * Republish an artefact that already exists — no regeneration, no instruction.
 *
 * "Can you publish the user stories again" used to reach `/api/revise`,
 * because `revise_artefact` was the only tool that mentioned an artefact that
 * already exists. A request to push a finished document therefore started a
 * full agent regeneration and offered a diff nobody had asked for.
 *
 * Deliberately shaped like `/api/revise` minus the instruction: same artefact
 * resolution, same level rules, same `not_generated` gate. The absence of an
 * instruction IS the difference between the two, so it is not a field here.
 */
app.post("/api/republish", async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    const feature = String(req.body?.feature || "").trim();
    const artefact = String(req.body?.artefact || "").trim();

    if (!project || !artefact) {
      return res.status(400).json({ error: "missing_input", message: "project and artefact are required" });
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

    // Nothing to republish for a stage that never published. The UI mockups
    // and the companion app are local artefacts — re-rendering them is a
    // re-run, not a publish, and saying so is more use than a 500 later.
    if (!def.publishes) {
      return res.status(400).json({
        error: "not_publishable",
        stage: stageKey,
        message: `The ${def.label.toLowerCase()} is not published anywhere — it is a local artefact. Re-run the stage to rebuild it.`,
      });
    }

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
        message: `There is no ${def.label.toLowerCase()} for ${project}${isProjectStage ? "" : ` / ${feature}`} yet — generate it first, then I can publish it.`,
      });
    }

    const scope = isProjectStage ? project : `${project}/${feature}`;
    const title = `Republish ${def.titlePrefix.replace(/^Generate /, "")} — ${scope}`;
    const description = [
      `Generated by the Scyne chatbot. REPUBLISH an existing artefact — do not regenerate or revise it.`,
      ``,
      isProjectStage ? `## Project` : `## Project + Feature`,
      `- Project: ${project}`,
      ...(isProjectStage ? [] : [`- Feature: ${feature}`]),
      `- Artefact: ${stageKey}`,
      `- Owner: ${def.agent}`,
      ``,
      `## Parameters`,
      `- ADO org: ${process.env.ADO_ORG || ""}`,
      ``,
      `## What this is`,
      `The ${def.label.toLowerCase()} already exists and is not being changed.`,
      `Publish it as it stands to the page it already has.`,
    ].join("\n");

    const owner = ownerFor(stageKey);
    const issue = await paperclip.createIssue(title, description, owner.assignee);
    res.json({ ...issue, stage: stageKey, worker: owner.worker, direct: owner.direct, artefact: pipeline.artefactKey(stageKey, feature) });
  } catch (e: any) {
    console.error("[republish] failed:", e);
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

// --- Uploads & voice agent ------------------------------------------------

/**
 * One rule for what a project or feature may be called.
 *
 * There used to be two, and they disagreed. `SAFE_PROJECT` (line 1102, and
 * `pipeline.SAFE_NAME`) allows spaces and `&`; this one did not. So
 * `POST /api/features` would happily create "Review & Verify Evidence" — the
 * value DEFAULT_FEATURE_NAME then carried in .env, no less — and then all
 * sixteen routes guarded
 * by the assertions below refused every request touching it, uploads and the
 * web attach button included, with "Invalid project or feature name".
 *
 * The character class now matches the rest of the pipeline. The segment check
 * is NEW and applies to both: `..` and `.` satisfy every one of these regexes,
 * which meant a crafted name could climb out of `projects/` on any route that
 * joins one into a path. A name is a single directory segment, so anything
 * that is not one is refused regardless of its characters.
 */
const SAFE_NAME = /^[A-Za-z0-9._ &-]+$/;

function isSafeSegment(name: string): boolean {
  if (!name || !SAFE_NAME.test(name)) return false;
  // A leading dot is either traversal or a hidden directory; neither is a
  // project. Trailing dots and spaces are refused because some filesystems
  // silently strip them, so two different names would resolve to one folder.
  if (name.startsWith(".") || /[. ]$/.test(name)) return false;
  return true;
}

// The plugin-local sync CLI, invoked as a subprocess. NOT `node` — sync.mjs
// imports the TypeScript sync engine and the plugin has no build step, so
// bare `node` dies with ERR_MODULE_NOT_FOUND. NOT `npx tsx` either — on a
// machine with tsx not cached, npx DOWNLOADS it, which has no place inside a
// route that runs on every upload. This repo's own precedent is the
// plugin-local binary (see plugins/aws-file-processing/scripts/stack.sh).
const SYNC_TSX = path.join(WORKSPACE_PATH, "plugins/aws-file-processing/node_modules/.bin/tsx");
const SYNC_CLI = path.join(WORKSPACE_PATH, "plugins/aws-file-processing/scripts/sync.mjs");

/**
 * Push this project's tree to blob after an upload.
 *
 * Fire-and-forget and non-fatal: the document is already on disk and already
 * in the database by the time this runs, and a sync failure must not turn a
 * successful upload into a 500. Failures are logged, exactly as `adoError` is
 * reported rather than thrown.
 */
function syncProjectToBlob(project: string): void {
  const cwd = path.join(WORKSPACE_PATH, "plugins/aws-file-processing");
  execFile(SYNC_TSX, [SYNC_CLI, project, "--up", "--root", WORKSPACE_PATH],
    { cwd },
    (err, stdout) => {
      if (err) console.warn(`[sync] ${project}: ${String(err.message).split("\n")[0]}`);
      else console.log(`[sync] ${project}: ${stdout.trim()}`);
    });
}

/**
 * Start extraction for one project, without waiting.
 *
 * Extraction is what makes a document USABLE, not merely stored — so it
 * starts the moment a document arrives rather than when a stage runs. Fire-
 * and-forget because a 300 MB PDF is not something to hold an HTTP request
 * open for; the caller polls `/api/extract-status/:project`.
 *
 * A spawn failure is reported and never fatal, exactly as `adoError` and
 * `dbError` are: the file and its row are real regardless, and
 * `extract-documents.mjs` is idempotent, so the stage's own `extract` step
 * will pick up anything missed here.
 */
function startExtraction(
  project: string, feature?: string, extra: string[] = [],
): { started: boolean; error: string | null } {
  try {
    const args = [path.join(WORKSPACE_PATH, "scripts", "extract-documents.mjs"), project, "--root", WORKSPACE_PATH];
    if (feature) args.push("--feature", feature);
    args.push(...extra);
    const child = spawn("node", args, {
      cwd: WORKSPACE_PATH, detached: true, stdio: "ignore",
    });
    child.on("error", (e) => console.warn(`[extract] ${project}: spawn failed — ${e.message}`));
    child.unref();
    return { started: true, error: null };
  } catch (e: any) {
    console.warn(`[extract] ${project}: could not start extraction — ${e?.message ?? e}`);
    return { started: false, error: e?.message ?? String(e) };
  }
}

/**
 * Presence is no longer readiness. A document on disk but unextracted
 * contributes nothing to a run, so a stage that starts anyway produces a
 * document with a silent hole in it. `no_documents` and `documents_not_ready`
 * stay separate refusals because their fixes are different: upload something,
 * versus wait or investigate.
 */
async function extractionGate(project: string): Promise<
  { code: "no_documents" | "documents_not_ready"; st: Awaited<ReturnType<typeof projectState>> } |
  { code: null; st: Awaited<ReturnType<typeof projectState>> }
> {
  const st = await projectState(WORKSPACE_PATH, project);
  if (st.documents.length === 0) return { code: "no_documents", st };
  if (st.ready < st.documents.length) return { code: "documents_not_ready", st };
  return { code: null, st };
}

app.get("/api/extract-status/:project", async (req, res) => {
  try {
    const project = String(req.params.project);
    if (!SAFE_PROJECT.test(project)) return res.status(400).json({ error: "bad_project" });
    res.json(await projectState(WORKSPACE_PATH, project));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

/**
 * Retry extraction for a project, or for one document in it.
 *
 * Extraction starts by itself on every upload, so this is the exception rather
 * than the normal path: a document that FAILED, or one wedged at `extracting`
 * because the pass holding its claim was killed. There was no way to ask for
 * either — the only retry was resuming the whole issue, which re-runs the step
 * for every document and cannot be aimed at the one that broke.
 *
 * Fire-and-forget, exactly as `startExtraction` is and for the same reason: a
 * fifty-document project is not something to hold an HTTP request open for. The
 * response carries what it is ABOUT to retry and why each one failed, so a
 * caller who has just been told "extraction failed" learns which document and
 * what went wrong in the same round trip, then polls
 * `/api/extract-status/:project`.
 */
app.post("/api/extract-retry/:project", async (req, res) => {
  try {
    const project = String(req.params.project);
    if (!SAFE_PROJECT.test(project)) return res.status(400).json({ error: "bad_project" });

    const doc = req.body?.doc ? String(req.body.doc).trim() : undefined;
    const force = Boolean(req.body?.force);

    const st = await projectState(WORKSPACE_PATH, project);
    const plan = planRetry(st.documents, { doc, force });
    if (!plan.ok) {
      // A name that resolves to nothing is the caller's mistake; the other three
      // are states of the project, which is the same split the stage gates draw
      // between `bad_project` and `no_documents`.
      return res.status(plan.error === "no_such_document" ? 400 : 409).json(plan);
    }

    const extraction = startExtraction(project, undefined, plan.args);
    if (!extraction.started) {
      return res.status(500).json({
        error: "extraction_not_started", message: extraction.error,
        retrying: plan.retrying,
      });
    }
    console.log(`[extract] ${project}: retrying ${plan.retrying.length} document(s)` +
      `${doc ? ` (${doc})` : ""}${force ? " with --force" : ""}`);
    res.json({ ok: true, project, started: true, retrying: plan.retrying });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

/**
 * No size limit.
 *
 * There was one — 100 MB, in `multer.memoryStorage()` — because content
 * travelled through this process's memory and then base64 through a JSON body
 * to reach the database. Three ceilings sat behind it: 100 MB here, ~384 MB
 * from V8's cap on a base64 string, and 1 GB from Postgres `bytea`. Bytes go
 * to object storage now, addressed by their own hash, so all three are gone
 * rather than raised — raising them would only have moved the failure, since
 * two of the three were never ours to move.
 */
const upload = multer({ storage: multer.memoryStorage() });

function nameError(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function assertSafeProjectFeature(project: string, feature: string) {
  if (!isSafeSegment(project) || !isSafeSegment(feature)) {
    throw nameError(
      `Invalid project or feature name. Use letters, numbers, spaces and . _ & - ` +
      `(not starting with a dot).`);
  }
}

function assertSafeProject(project: string) {
  if (!isSafeSegment(project)) {
    throw nameError(
      `Invalid project name. Use letters, numbers, spaces and . _ & - ` +
      `(not starting with a dot).`);
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
/**
 * What the agents will actually read, after `convert-to-md.mjs` has run.
 *
 * The converter REPLACES the source with its markdown and archives the
 * original, so the name that was written is usually gone by the time we reply:
 * `foo.docx` → `foo.md`, or `foo.docx.md` when a foreign `foo.md` was already
 * there (resolveTarget in convert-to-md.mjs).
 *
 * The trigger is that the SOURCE has disappeared, not that the converter exited
 * 0 — it exits 0 for a `.png` too, which it skips by design. Going by the exit
 * code, a screen uploaded beside an unrelated `foo.md` would be reported as
 * having been converted into someone else's document. Checking the
 * disambiguated form first is the same guard, one level down.
 */
async function afterConversion(dir: string, savedName: string): Promise<string> {
  const stillThere = await fs.access(path.join(dir, savedName)).then(() => true, () => false);
  if (stillThere) return savedName;
  const stem = savedName.slice(0, savedName.length - path.extname(savedName).length);
  for (const candidate of [`${savedName}.md`, `${stem}.md`]) {
    try {
      await fs.access(path.join(dir, candidate));
      return candidate;
    } catch { /* not that one */ }
  }
  return savedName;
}

// 6b. Documents — what a person can see, replace and remove.
//
// DISK is authoritative here and the database row is reconciled alongside it,
// in that order, because disk is what every stage reads: the 409 gates count
// `.md` under `projects/<p>/`, `stage.mjs` copies from the folder tree, and
// every skill reads its working folder. A delete that retired only the row
// would report success and change nothing a single agent does.

/** Both levels, plus what is now out of date because of them. */
app.get("/api/documents", async (req, res) => {
  try {
    const project = String(req.query.project || "").trim();
    const feature = String(req.query.feature || "").trim();
    if (!project) return res.status(400).json({ error: "missing_target", message: "project is required" });
    if (feature) assertSafeProjectFeature(project, feature); else assertSafeProject(project);

    const docs = await listDocuments(WORKSPACE_PATH, project, feature || null);
    // Returned from the SAME call, so the tab cannot render a document list and
    // a staleness banner that disagree about what is on disk.
    const stale = await pipeline.staleness(WORKSPACE_PATH, project, feature || undefined);

    // OPT-IN, because it costs one file read per markdown document and only the
    // grid has anywhere to put the result. The chat assistant's list_documents
    // and `scyne doc list` ask for names and sizes, and must not start paying
    // for text nobody will read.
    if (req.query.excerpts === "true") {
      const attach = async (entry: DocumentEntry): Promise<DocumentEntry> => {
        if (entry.kind !== "markdown") return entry;
        const read = await readDocument(WORKSPACE_PATH, project, entry.feature, entry.path)
          .catch(() => null);
        return read ? { ...entry, excerpt: excerptOf(read.content, EXCERPT_CHARS) } : entry;
      };
      docs.project = await Promise.all(docs.project.map(attach));
      docs.feature = await Promise.all(docs.feature.map(attach));
    }

    // Which of these the DATABASE also knows about.
    //
    // Two stores, and only one of them is what the agents read. Disk wins for
    // "what exists" — every stage counts `.md` there — but `scyne doc list`,
    // the console and every platform route read rows, so a document with no row
    // is invisible to all of them. Measured on this installation before the
    // sync existed: 20 documents on disk, 2 rows. Saying so here is what stops
    // that from being silent again.
    const rows = await store.documentRowsFor(tokenFor(req), project);
    const known = new Set(rows.paths.map((r) => `${r.feature ?? ""}::${r.path}`));
    const mark = (d: DocumentEntry): DocumentEntry =>
      ({ ...d, inDb: known.has(`${d.feature ?? ""}::${d.path}`) });
    docs.project = docs.project.map(mark);
    docs.feature = docs.feature.map(mark);
    const notInDb = [...docs.project, ...docs.feature].filter((d) => !d.inDb).length;

    res.json({
      project, feature: feature || null,
      documents: docs,
      counts: { project: docs.project.length, feature: docs.feature.length },
      // `projectInDb: false` is a different problem from a missing document row
      // and has a different fix — there is no project to attach anything to.
      db: { projectInDb: rows.projectInDb, notInDb },
      stale,
    });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

/** How much of a document a grid card can show. */
const EXCERPT_CHARS = 420;

/**
 * One document's text, for the preview.
 *
 * Nothing else served this. `/api/artifacts` reads the GENERATED artefacts —
 * `outputs/` and `solutions/` — and the orchestrator's document route is keyed
 * by a database id rather than a path on disk, so neither could show a client
 * the SOP that a stage is actually reading.
 */
app.get("/api/documents/content", async (req, res) => {
  try {
    const project = String(req.query.project || "").trim();
    const feature = String(req.query.feature || "").trim();
    const docPath = String(req.query.path || "").trim();
    if (!project || !docPath) {
      return res.status(400).json({ error: "missing_target", message: "project and path are required" });
    }
    if (feature) assertSafeProjectFeature(project, feature); else assertSafeProject(project);

    let doc;
    try {
      doc = await readDocument(WORKSPACE_PATH, project, feature || null, docPath);
    } catch (e: any) {
      // A path outside `documents/`, a climb out of the project, or a binary
      // file. All three are the caller asking for the wrong thing, not a fault.
      return res.status(400).json({ error: "bad_path", message: e?.message ?? String(e) });
    }
    if (!doc) return res.status(404).json({ error: "no_document", message: `No document at ${docPath}.` });

    res.json({ project, feature: feature || null, ...doc });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

/**
 * Remove one document.
 *
 * Takes the archived original with it. `convert-to-md.mjs` MOVES a source into
 * `original-files/` rather than deleting it, so removing only the markdown
 * leaves the thing that produced it — and the next conversion pass puts the
 * document straight back, long after the person who deleted it stopped looking.
 */
app.delete("/api/documents", async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    const feature = String(req.body?.feature || "").trim();
    const docPath = String(req.body?.path || "").trim();
    if (!project || !docPath) {
      return res.status(400).json({ error: "missing_target", message: "project and path are required" });
    }
    if (feature) assertSafeProjectFeature(project, feature); else assertSafeProject(project);

    let result;
    try {
      result = await deleteDocument(WORKSPACE_PATH, project, feature || null, docPath);
    } catch (e: any) {
      // A path outside `documents/` is somebody pointing a delete at a
      // generated artefact, not a server fault.
      return res.status(400).json({ error: "bad_path", message: e?.message ?? String(e) });
    }
    if (!result.found) {
      return res.status(404).json({ error: "no_document", message: `No document at ${docPath}.` });
    }

    const db = await store.deleteDocumentRow(tokenFor(req), { project, feature: feature || null, path: docPath });
    if (db.state === "failed") {
      console.warn(`[documents] ${project}: row not retired for ${docPath} — ${db.reason}`);
    }

    // Recomputed AFTER the delete: removing an input is exactly as much a
    // change as replacing one, and the caller decides what to re-run from this.
    const stale = await pipeline.staleness(WORKSPACE_PATH, project, feature || undefined);
    console.log(`[documents] deleted ${project}${feature ? "/" + feature : ""}/${docPath} (db=${db.state})`);
    res.json({ ok: true, removed: result.removed, db, stale });
  } catch (e: any) {
    console.error("[documents] delete failed:", e);
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

/**
 * Replace one document with a new file.
 *
 * The old is removed FIRST — including its archived original — so the
 * replacement keeps its own name instead of landing beside the thing it was
 * meant to supersede as `handling (1).md`. Two documents where the client
 * expected one is the worse failure: both get staged, and the pack quietly
 * cites a superseded policy.
 */
app.put("/api/documents", upload.single("file"), async (req, res) => {
  try {
    const project = String(req.body?.project || "").trim();
    const feature = String(req.body?.feature || "").trim();
    const docPath = String(req.body?.path || "").trim();
    if (!project || !docPath) {
      return res.status(400).json({ error: "missing_target", message: "project and path are required" });
    }
    if (feature) assertSafeProjectFeature(project, feature); else assertSafeProject(project);
    if (!req.file) return res.status(400).json({ error: "file is required (field name: 'file')" });

    let target: string;
    try {
      target = resolveDocument(WORKSPACE_PATH, project, feature || null, docPath);
    } catch (e: any) {
      return res.status(400).json({ error: "bad_path", message: e?.message ?? String(e) });
    }
    const dir = path.dirname(target);
    const existed = await fs.access(target).then(() => true, () => false);
    if (!existed) {
      // Replace means replace. Creating one here would make a mistyped path
      // look like a successful edit of a document nobody can find afterwards.
      return res.status(404).json({ error: "no_document", message: `No document at ${docPath} to replace.` });
    }

    await deleteDocument(WORKSPACE_PATH, project, feature || null, docPath);

    await fs.mkdir(dir, { recursive: true });
    const savedName = await uniqueName(dir, req.file.originalname);
    await fs.writeFile(path.join(dir, savedName), req.file.buffer);

    // Converted HERE, as both upload routes do and for the same reason: every
    // stage's 409 gate counts `.md`, and staging runs after that gate.
    const conversion = await runHelper("convert-to-md.mjs", feature ? [project, feature] : [project]);
    if (!conversion.ok) {
      console.warn(
        `[documents] convert-to-md exited ${conversion.code} for ${project}${feature ? "/" + feature : ""}:`,
        conversion.stderr.trim().slice(-400));
    }
    const readableName = await afterConversion(dir, savedName);
    const levelRoot = feature
      ? path.join(WORKSPACE_PATH, "projects", project, feature)
      : path.join(WORKSPACE_PATH, "projects", project);
    const newPath = path.relative(levelRoot, path.join(dir, readableName));

    const db = await store.createDocumentRow(tokenFor(req), {
      project, feature: feature || null, path: newPath,
      content: await fs.readFile(path.join(dir, readableName)).catch(() => req.file!.buffer),
    });
    if (db.state === "failed") {
      console.warn(`[documents] ${project}: row not written for ${newPath} — ${db.reason}`);
    }

    // A REPLACEMENT needs extraction as much as a first upload does, and this
    // route was the one place that did not start it.
    //
    // Extracts are keyed by the source document's CONTENT HASH, so replacing a
    // document does not invalidate anything — it asks for an extract that has
    // never existed, while the old one becomes an orphan nothing points at. The
    // project therefore drops straight back to `documents_not_ready` and STAYS
    // there: every stage that hard-requires extraction refuses, and nothing on
    // this path was ever going to fix it. That is the "why is this manual"
    // case — uploads were automatic all along, replacements silently were not.
    const extraction = startExtraction(project, feature || undefined);
    if (!extraction.started) {
      console.warn(`[documents] ${project}: replacement not extracted — ${extraction.error}`);
    }

    const stale = await pipeline.staleness(WORKSPACE_PATH, project, feature || undefined);
    console.log(`[documents] replaced ${project}${feature ? "/" + feature : ""}/${docPath} with ${newPath} (db=${db.state}, extracting=${extraction.started})`);
    res.json({
      ok: true, replaced: docPath, path: newPath, filename: readableName,
      converted: readableName !== savedName, db, stale,
      // Same shape the upload routes answer with, so a caller does not have to
      // know which door it came in by.
      extraction,
    });
  } catch (e: any) {
    console.error("[documents] replace failed:", e);
    res.status(e?.status ?? 500).json({ error: e?.message ?? String(e) });
  }
});

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

    const conversion = await runHelper("convert-to-md.mjs", [project]);
    if (!conversion.ok) {
      console.warn(
        `[upload/project] convert-to-md exited ${conversion.code} for ${project}:`,
        conversion.stderr.trim().slice(-400));
    }
    const readableName = await afterConversion(dir, savedName);

    // The DATABASE half, which this route never wrote. `/docs`, the document
    // counts in the assistant's prompt and the versioned history behind a
    // replacement all read rows — so a document uploaded here reached every
    // agent and was invisible to every person. Best-effort: the file is on
    // disk, which is what the stages read.
    const db = await store.createDocumentRow(tokenFor(req), {
      project, path: path.join("documents", readableName),
      content: await fs.readFile(path.join(dir, readableName)).catch(() => req.file!.buffer),
    });
    if (db.state === "failed") {
      console.warn(`[upload/project] ${project}: row not written for ${readableName} — ${db.reason}`);
    }

    // Not awaited: the response must not wait on a blob round-trip. The
    // document is already on disk and already in the database above, so
    // whatever this does or does not do, the upload has already succeeded.
    syncProjectToBlob(project);

    // Extraction is what makes this document usable, not merely stored — it
    // starts the moment it arrives, not when a stage runs. Also fire-and-
    // forget, and after the sync call for the same reason: the document is
    // already real on disk either way.
    const extraction = startExtraction(project);

    res.json({
      kind: "file",
      scope: "project",
      filename: readableName,
      path: path.join("documents", readableName),
      db,
      // Was THIS file converted — not "did the converter exit 0", which it also
      // does for a directory of markdown it had nothing to do.
      converted: readableName !== savedName,
      relativePath: path.relative(WORKSPACE_PATH, path.join(dir, readableName)),
      extraction: { started: extraction.started, error: extraction.error, state: "extracting" },
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
      syncProjectToBlob(project);
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
      // A transcribed recording is a DOCUMENT — it lands in Transcripts/ as
      // markdown and the BA reads it as the primary source of stories. It was
      // the one upload path with no row at all, so a meeting recorded in the
      // browser never appeared in `/docs` or in the assistant's counts.
      const transcriptRoot = path.join(WORKSPACE_PATH, "projects", project, feature);
      const transcriptPath = path.relative(transcriptRoot, path.join(WORKSPACE_PATH, result.relativePath));
      const transcriptDb = await store.createDocumentRow(tokenFor(req), {
        project, feature, path: transcriptPath,
        content: Buffer.from(await fs.readFile(path.join(WORKSPACE_PATH, result.relativePath), "utf8"), "utf8"),
      });
      if (transcriptDb.state === "failed") {
        console.warn(`[upload] ${project}/${feature}: row not written for ${transcriptPath} — ${transcriptDb.reason}`);
      }

      syncProjectToBlob(project);

      // Same discipline as the other two upload paths: a transcript is a
      // document, and starts extraction the moment it lands.
      const transcriptExtraction = startExtraction(project, feature);

      return res.json({
        kind: "transcript",
        subfolder: "transcripts",
        filename: result.filename,
        relativePath: result.relativePath,
        path: transcriptPath,
        db: transcriptDb,
        entryCount: transcribed.entries.length,
        modelUsed: transcribed.modelUsed,
        extraction: { started: transcriptExtraction.started, error: transcriptExtraction.error, state: "extracting" },
      });
    }

    const targetDir = requirementsDir(WORKSPACE_PATH, project, feature, route.subfolder);
    await fs.mkdir(targetDir, { recursive: true });
    const savedName = await uniqueName(targetDir, route.savedName);
    await fs.writeFile(path.join(targetDir, savedName), req.file.buffer);

    // Convert to markdown HERE, not at staging time — exactly as
    // /api/upload/project does, and for the same reason.
    //
    // Every stage's 409 gate counts `.md` under projects/<p>/ (countFeatureDocs
    // and countProjectDocs, which reads it per feature). `stage.mjs` runs the
    // converter as its step 0, which is AFTER that gate — so a feature-level
    // `.docx` was refused with `no_documents` on every retry and never reached
    // the converter that would have made it readable. Uploading three .docx and
    // being told the project has no documents is exactly this, and no number of
    // retries could have cleared it.
    //
    // Images (requirements/UI) and audio are skipped by the converter itself,
    // and the source is MOVED to original-files/requirements/, never deleted.
    const conversion = await runHelper("convert-to-md.mjs", [project, feature]);
    if (!conversion.ok) {
      // Not fatal: the file is on disk, and `stage.mjs` runs the same converter
      // again at staging time. But a stage gate counts `.md`, so a conversion
      // that keeps failing is precisely why an upload that reported success is
      // then refused with `no_documents` — log it where someone can see it.
      console.warn(
        `[upload] convert-to-md exited ${conversion.code} for ${project}/${feature}:`,
        conversion.stderr.trim().slice(-400));
    }

    const readableName = await afterConversion(targetDir, savedName);

    // Same missing half as the project route above.
    const featureRoot = path.join(WORKSPACE_PATH, "projects", project, feature);
    const relPath = path.relative(featureRoot, path.join(targetDir, readableName));
    const db = await store.createDocumentRow(tokenFor(req), {
      project, feature, path: relPath,
      content: await fs.readFile(path.join(targetDir, readableName)).catch(() => req.file!.buffer),
    });
    if (db.state === "failed") {
      console.warn(`[upload] ${project}/${feature}: row not written for ${relPath} — ${db.reason}`);
    }

    // Not awaited: the response must not wait on a blob round-trip. The
    // document is already on disk and already in the database above, so
    // whatever this does or does not do, the upload has already succeeded.
    syncProjectToBlob(project);

    // Extraction is what makes this document usable, not merely stored — it
    // starts the moment it arrives, not when a stage runs. Also fire-and-
    // forget, and after the sync call for the same reason: the document is
    // already real on disk either way.
    const extraction = startExtraction(project, feature);

    return res.json({
      kind: "file",
      subfolder: route.subfolder,
      filename: readableName,
      path: relPath,
      extraction: { started: extraction.started, error: extraction.error, state: "extracting" },
      db,
      converted: readableName !== savedName,
      relativePath: path.relative(WORKSPACE_PATH, path.join(targetDir, readableName)),
    });
  } catch (e: any) {
    console.error("[upload] failed:", e);
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
      if (docs.readable === 0) return false;
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
/**
 * One file of a project's companion app, from the STORE.
 *
 * It used to be `fs.readFile` against `generated-apps/<project>/`. Once a step
 * works in a scratch tree that is discarded when the step ends, that directory
 * is not there afterwards — the rendered page lives in the store, harvested at
 * PROJECT level under its work-root-relative path, which is the shape
 * `attribute()` gives it.
 */
async function sendCompanionFile(
  res: express.Response, project: string, relPath: string, token: string | null,
) {
  // Normalised to forward slashes: `path.join` gives backslashes on Windows,
  // and a stored path is always POSIX.
  const docPath = `generated-apps/${project}/${relPath.split(path.sep).join("/")}`;
  const html = await store.readDocumentByPath(token, project, docPath);
  if (html === null) {
    return res.status(404).json({
      error: "not_generated",
      message: relPath === "index.html"
        ? `No companion app for ${project} yet — run the app stage to build it.`
        : `${relPath} is not part of ${project}'s companion app.`,
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
    await sendCompanionFile(res, project, "index.html", tokenFor(req));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// The mockup pages link back with `../../index.html`, which lands here.
app.get("/api/companion-app/:project/index.html", async (req, res) => {
  try {
    const { project } = req.params;
    assertSafeProject(project);
    await sendCompanionFile(res, project, "index.html", tokenFor(req));
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
    await sendCompanionFile(res, project, path.join("mockups", dir, file), tokenFor(req));
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

// CHATBOT_PORT, not PORT: one shared root .env now feeds every process in
// the stack, and `PORT` is a name half the Node world reads. A value meant
// for this server would otherwise be picked up by anything else started
// from that file. `PORT` is still honoured as a fallback, because Docker
// and most PaaS hosts inject it and neither is ours to change.
const PORT = Number(process.env.CHATBOT_PORT || process.env.PORT) || 4000;
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

/**
 * Multer's own refusals, as JSON that says what happened.
 *
 * Multer still refuses a file sent under the wrong field name, and Express's
 * default for that is an HTML error page with status 500 — a caller error
 * wearing the costume of a server fault. There is no size branch any more:
 * there is no size limit for it to report.
 *
 * Registered AFTER every route, which is what makes it an Express error handler
 * rather than middleware — the four-argument signature is the whole
 * distinction, so the unused `_next` must stay.
 */
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({
      error: "unexpected_field",
      message: `Send the file as the form field "file".`,
    });
  }
  console.error("[api] unhandled:", err);
  res.status(err?.status ?? 500).json({ error: err?.message ?? String(err) });
});

server.listen(PORT, () => {
  console.log(`Scyne chatbot API listening on http://127.0.0.1:${PORT}`);
  console.log(`Live recording WebSocket at ws://127.0.0.1:${PORT}/ws/record`);
});
