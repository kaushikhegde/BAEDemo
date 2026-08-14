// The pipeline, as data.
//
// This file is the single source of truth for: which stages exist, what level
// each runs at, what it produces, what it hard-requires, and what it reads
// opportunistically. Four things consume it and they MUST agree, or a stage the
// CLI thinks is ready is one the chatbot refuses:
//
//   scripts/stage.mjs                    staging + the readiness grid
//   scripts/render-companion-app.mjs     which tabs to render
//   scyne-chatbot/server/index.ts        pre-flight checks, staleness, chips
//   scripts/migrate-to-project-level.mjs what to move where
//
// Two levels. PROJECT stages describe the client organisation and run once per
// project; FEATURE stages describe one slice of work and run once per feature.
//
// Path conventions, which are the easy thing to get wrong:
//   produces[]              relative to the stage's OWN level root
//   requires[] / enriches[] carry an explicit `scope`, because a feature stage
//                           routinely depends on a project artefact
//   producesInWorkspace[]   relative to the workspace root (only `app`)

import fs from "node:fs/promises";
import path from "node:path";

export const LEVEL = { PROJECT: "project", FEATURE: "feature" };

// `agentKey` on each stage is the bootstrap spec key, which is also how
// .bootstrap/ids.json keys its `org` map. That lets the chatbot assign a
// single-worker flow STRAIGHT to its worker instead of routing it through the
// Delivery Lead — which cost 2-3 extra agent wakes per flow, each re-reading
// the Delivery Lead's 10k-token instructions to do nothing but create one child.

// Folders under a feature (or project) that are OUTPUT, not source material.
// Never staged as discovery documents, never converted to markdown.
export const NOT_SOURCE = new Set([
  "outputs", "solutions", "design", "original-files", "documents", "node_modules", ".git",
]);

export const SAFE_NAME = /^[A-Za-z0-9._ &-]+$/;

// The one page every stage feeds. Rendered after each stage, not once at the end.
export const RENDER_CMD = "node scripts/render-companion-app.mjs <project>";

const req = (scope, p, from, extra = {}) => ({ scope, path: p, from, ...extra });

export const STAGES = {
  // ---------------------------------------------------------------- project
  capabilities: {
    level: LEVEL.PROJECT,
    order: 1,
    label: "Capability & Process Map",
    agent: "Capabilities Process Architect",
    agentKey: "capArchitect",
    skill: "capability-process-map",
    work: "solutions/Capabilities",
    titlePrefix: "Generate capability map",
    publishes: true,
    produces: [
      "solutions/Capabilities/outputs/capability-process.md",
      "solutions/Capabilities/outputs/capability-map.json",
      "solutions/Capabilities/outputs/process-model.json",
    ],
    requires: [],
    enriches: [req("project", "documents", "documents")],
    then: "node scripts/render-capability-map.mjs <project> --validate-only",
  },

  personas: {
    level: LEVEL.PROJECT,
    order: 2,
    label: "Personas & Journey Map",
    agent: "Service Designer",
    agentKey: "serviceDesigner",
    skill: "persona-journey-map",
    work: "solutions/Experience",
    titlePrefix: "Generate personas",
    publishes: true,
    produces: [
      "solutions/Experience/outputs/personas-journeys.md",
      "solutions/Experience/outputs/personas.json",
      "solutions/Experience/outputs/journey-map.json",
    ],
    // Journey stages align to the capability model's L1 lifecycle phases, which
    // is the whole reason the wizard runs these two in sequence rather than
    // together. Encoding it here keeps the CLI honest about the same thing.
    requires: [req("project", "solutions/Capabilities/outputs/capability-map.json", "capabilities")],
    enriches: [req("project", "documents", "documents")],
    then: "node scripts/validate-experience.mjs <project>",
  },

  // ---------------------------------------------------------------- feature
  requirements: {
    level: LEVEL.FEATURE,
    order: 3,
    label: "Requirements & Product Summary",
    agent: "BA",
    agentKey: "ba",
    skill: "requirement-generator",
    work: "requirements",
    titlePrefix: "Generate requirements",
    publishes: true,
    produces: ["outputs/product-summary.md", "outputs/stories.json"],
    requires: [],
    enriches: [
      req("project", "documents", "documents"),
      req("project", "solutions/Experience/outputs/personas.json", "personas"),
      req("project", "solutions/Capabilities/outputs/capability-process.md", "capabilities"),
    ],
  },

  // Deliberately ahead of the data model: the client wants to see screens before
  // committing to a schema. The cost is real — no field names, no picklists, no
  // failure states — so `mockups.json` records which inputs it had, and the
  // staleness walk offers a refresh once the data model and test pack land.
  ui: {
    level: LEVEL.FEATURE,
    order: 4,
    label: "UI Mockups",
    agent: "UX Designer",
    agentKey: "uxDesigner",
    skill: "ui-mockup-generator",
    work: "solutions/UI",
    titlePrefix: "Generate UI mockups",
    publishes: false,
    produces: ["solutions/UI/outputs/mockups.json"],
    requires: [req("feature", "outputs/product-summary.md", "requirements")],
    enriches: [
      req("project", "documents", "documents"),
      req("project", "solutions/Experience/outputs/personas.json", "personas"),
      req("project", "solutions/Experience/outputs/journey-map.json", "personas"),
      req("project", "solutions/Capabilities/outputs/capability-map.json", "capabilities"),
      req("project", "solutions/Capabilities/outputs/process-model.json", "capabilities"),
      req("feature", "outputs/stories.md", "requirements"),
      req("feature", "solutions/DataModel/outputs", "datamodel"),
      req("feature", "solutions/Architecture/outputs", "architecture"),
      req("feature", "solutions/QA/outputs/test-cases.md", "qa"),
    ],
    then: "node scripts/render-mockups.mjs <project> <feature>",
  },

  datamodel: {
    level: LEVEL.FEATURE,
    order: 5,
    label: "Salesforce Data Model",
    agent: "Data Modeler",
    agentKey: "dataModeler",
    skill: "salesforce-data-modeler",
    work: "solutions/DataModel",
    titlePrefix: "Generate data model",
    publishes: true,
    produces: ["solutions/DataModel/outputs/salesforce-data-model.md"],
    requires: [req("feature", "outputs/product-summary.md", "requirements", { escape: "--from-requirements" })],
    enriches: [req("project", "documents", "documents")],
  },

  architecture: {
    level: LEVEL.FEATURE,
    order: 6,
    label: "Solution Architecture",
    agent: "Solution Architect",
    agentKey: "solutionArchitect",
    skill: "salesforce-service-cloud-architecture",
    work: "solutions/Architecture",
    titlePrefix: "Generate solution architecture",
    publishes: true,
    produces: ["solutions/Architecture/outputs/solution-architecture.md"],
    requires: [req("feature", "outputs/product-summary.md", "requirements")],
    enriches: [
      req("project", "documents", "documents"),
      req("project", "solutions/Capabilities/outputs/capability-process.md", "capabilities"),
      req("feature", "solutions/DataModel/outputs", "datamodel"),
    ],
  },

  qa: {
    level: LEVEL.FEATURE,
    order: 7,
    label: "Test Cases",
    agent: "QA Architect",
    agentKey: "qaArchitect",
    skill: "requirements-test-case-generator",
    work: "solutions/QA",
    titlePrefix: "Generate test cases",
    publishes: true,
    produces: ["solutions/QA/outputs/test-cases.md"],
    requires: [req("feature", "outputs/product-summary.md", "requirements")],
    enriches: [
      req("project", "documents", "documents"),
      req("project", "solutions/Experience/outputs/personas.json", "personas"),
      req("feature", "solutions/DataModel/outputs", "datamodel"),
      req("feature", "solutions/Architecture/outputs", "architecture"),
      req("feature", "solutions/Design/outputs", "design"),
    ],
  },

  // Optional side stage, deliberately outside the numbered order: a narrower,
  // component-level deliverable that overlaps `architecture`. Excluded from
  // `all` — ask for it by name when a client wants that level of detail.
  design: {
    level: LEVEL.FEATURE,
    order: 7.5,
    optional: true,
    label: "Solution Design (optional side stage)",
    agent: "Architecture Lead",
    agentKey: "archLead",
    skill: "solution-design-document",
    work: "solutions/Design",
    titlePrefix: "Generate solution design",
    publishes: true,
    produces: ["solutions/Design/outputs/solution-design.md"],
    requires: [req("feature", "outputs/product-summary.md", "requirements")],
    enriches: [req("feature", "solutions/DataModel/outputs", "datamodel")],
  },

  // ---------------------------------------------------------------- project
  app: {
    level: LEVEL.PROJECT,
    order: 8,
    label: "Companion App",
    agent: "Developer",
    agentKey: "ui",
    script: "node scripts/render-companion-app.mjs <project>",
    work: "-",
    titlePrefix: "Build UI",
    publishes: false,
    produces: [],
    // The only stage whose output lands outside the project directory.
    producesInWorkspace: ["generated-apps/<project>/index.html"],
    requires: [],
    enriches: [],
  },
};

export const ORDERED = Object.entries(STAGES).sort((a, b) => a[1].order - b[1].order);

export const ordered = (level) =>
  level ? ORDERED.filter(([, d]) => d.level === level) : ORDERED;

export const isProjectStage = (key) => STAGES[key]?.level === LEVEL.PROJECT;
export const isFeatureStage = (key) => STAGES[key]?.level === LEVEL.FEATURE;

// ---------------------------------------------------------------------------
// Revision routing
// ---------------------------------------------------------------------------
// What a human calls an artefact, mapped to the stage that owns it. The chat
// LLM passes one of these; /api/revise and the Delivery Lead both resolve it
// through here rather than each keeping their own list.

export const ARTEFACT_ALIASES = {
  capabilities: "capabilities",
  "capability map": "capabilities",
  "capability model": "capabilities",
  "process model": "capabilities",
  personas: "personas",
  "persona set": "personas",
  journeys: "personas",
  "journey map": "personas",
  requirements: "requirements",
  "product summary": "requirements",
  stories: "requirements",
  "user stories": "requirements",
  ui: "ui",
  mockups: "ui",
  "ui mockups": "ui",
  wireframes: "ui",
  screens: "ui",
  datamodel: "datamodel",
  "data model": "datamodel",
  erd: "datamodel",
  schema: "datamodel",
  architecture: "architecture",
  "solution architecture": "architecture",
  sad: "architecture",
  qa: "qa",
  "test cases": "qa",
  "test pack": "qa",
  tests: "qa",
  design: "design",
  "solution design": "design",
  sdd: "design",
};

/** Resolve a human artefact name to its stage key, or null. */
export function stageFor(artefact) {
  if (!artefact) return null;
  const k = String(artefact).trim().toLowerCase();
  return ARTEFACT_ALIASES[k] ?? (Object.hasOwn(STAGES, k) ? k : null);
}

/** The key an artefact is tracked under in .published.json and staleness. */
export const artefactKey = (stageKey, feature) =>
  isProjectStage(stageKey) ? stageKey : `${feature}/${stageKey}`;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export const projectDir = (workspace, project) => path.join(workspace, "projects", project);
export const featureDir = (workspace, project, feature) => path.join(workspace, "projects", project, feature);

/** The root a stage's `produces` and `work` paths are relative to. */
export function levelRoot(workspace, key, project, feature) {
  return isProjectStage(key) ? projectDir(workspace, project) : featureDir(workspace, project, feature);
}

/** Absolute path for one requires/enriches entry. */
export function resolveInput(workspace, input, project, feature) {
  const root = input.scope === "project" ? projectDir(workspace, project) : featureDir(workspace, project, feature);
  return path.join(root, input.path);
}

export const exists = async (p) => {
  try { await fs.access(p); return true; } catch { return false; }
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const isDir = async (p) => {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
};

export async function listProjects(workspace) {
  const root = path.join(workspace, "projects");
  const names = (await fs.readdir(root).catch(() => [])).sort();
  const out = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (await isDir(path.join(root, name))) out.push(name);
  }
  return out;
}

// A project directory holds features PLUS the project's own folders. Only the
// former are features — without this filter `solutions` and `documents` would
// show up as features the moment a project generates anything.
const PROJECT_OWN_DIRS = new Set(["solutions", "documents", "design", "original-files", "outputs"]);

export async function listFeatures(workspace, project) {
  const pdir = projectDir(workspace, project);
  const names = (await fs.readdir(pdir).catch(() => [])).sort();
  const out = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (PROJECT_OWN_DIRS.has(name.toLowerCase())) continue;
    if (await isDir(path.join(pdir, name))) out.push(name);
  }
  return out;
}

/** Every project/feature pair on disk. */
export async function listAll(workspace) {
  const out = [];
  for (const project of await listProjects(workspace)) {
    for (const feature of await listFeatures(workspace, project)) {
      out.push({ project, feature, dir: featureDir(workspace, project, feature) });
    }
  }
  return out;
}

/**
 * A feature name may not collide with a project-level stage key, because
 * `npm run stage SAPN capabilities` has to mean the stage. Enforced here so the
 * CLI and POST /api/features agree.
 */
// `baseline` is not a STAGE — it is the composite CLI/agent flow that runs
// `capabilities` then `personas` in one pass. It still has to be reserved, or a
// feature by that name would be unreachable from `npm run stage`.
export const RESERVED_FEATURE_NAMES = new Set(
  ordered(LEVEL.PROJECT).map(([k]) => k).concat(["all", "baseline"]),
);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Has this stage produced everything it declares? */
export async function stageIsDone(workspace, key, project, feature) {
  const def = STAGES[key];
  if (!def) return false;
  const outside = def.producesInWorkspace ?? [];
  if (!def.produces.length && !outside.length) return false;

  const root = levelRoot(workspace, key, project, feature);
  if (def.level === LEVEL.FEATURE && !feature) return false;
  for (const p of def.produces) {
    if (!(await exists(path.join(root, p)))) return false;
  }
  for (const p of outside) {
    const resolved = p.replace("<project>", project).replace("<feature>", feature ?? "");
    if (!(await exists(path.join(workspace, resolved)))) return false;
  }
  return true;
}

/** The newest mtime among a stage's outputs, or null if it has not run. */
export async function producedAt(workspace, key, project, feature) {
  const def = STAGES[key];
  if (!def) return null;
  const root = levelRoot(workspace, key, project, feature);
  const paths = def.produces
    .map((p) => path.join(root, p))
    .concat((def.producesInWorkspace ?? []).map((p) =>
      path.join(workspace, p.replace("<project>", project).replace("<feature>", feature ?? "")),
    ));
  let newest = null;
  for (const p of paths) {
    const st = await fs.stat(p).catch(() => null);
    if (!st) return null;
    if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return newest;
}

/** The newest mtime under a path, following one level into a directory. */
async function newestMtime(p) {
  const st = await fs.stat(p).catch(() => null);
  if (!st) return null;
  if (st.isFile()) return st.mtimeMs;
  let newest = null;
  for (const entry of await fs.readdir(p, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const s = await fs.stat(path.join(p, entry.name)).catch(() => null);
    if (s && (newest === null || s.mtimeMs > newest)) newest = s.mtimeMs;
  }
  return newest;
}

/** Which hard requirements are unmet. Empty array means the stage can run. */
export async function unmetRequirements(workspace, key, project, feature, flags = new Set()) {
  const def = STAGES[key];
  if (!def) return [];
  const missing = [];
  for (const input of def.requires ?? []) {
    if (input.escape && flags.has(input.escape)) continue;
    if (await exists(resolveInput(workspace, input, project, feature))) continue;
    missing.push(input);
  }
  return missing;
}

/**
 * Artefacts generated before one of their inputs last changed.
 *
 * mtime cannot distinguish a substantive revision from a re-run that changed
 * nothing, so this over-reports rather than under-reports. That is the safe
 * direction: the user is offered a refresh they may decline, never silently
 * handed a pack that contradicts itself.
 */
export async function staleness(workspace, project, feature) {
  const out = [];
  const keys = ORDERED
    .filter(([k, d]) => (d.level === LEVEL.PROJECT ? true : Boolean(feature)) && k !== "app")
    .map(([k]) => k);

  for (const key of keys) {
    const def = STAGES[key];
    const own = await producedAt(workspace, key, project, feature);
    if (own === null) continue;

    const superseded = [];
    for (const input of [...(def.requires ?? []), ...(def.enriches ?? [])]) {
      const at = await newestMtime(resolveInput(workspace, input, project, feature));
      if (at === null || at <= own) continue;
      const fromDef = STAGES[input.from];
      // Only report a superseding artefact once, even when several of its files
      // are read by the stale stage.
      if (superseded.some((s) => s.key === input.from)) continue;
      superseded.push({
        key: input.from,
        label: fromDef?.label ?? input.from,
        artefact: fromDef ? artefactKey(input.from, feature) : input.from,
        generatedAt: new Date(at).toISOString(),
      });
    }
    if (superseded.length) {
      out.push({
        key,
        artefact: artefactKey(key, feature),
        label: def.label,
        level: def.level,
        generatedAt: new Date(own).toISOString(),
        supersededBy: superseded,
      });
    }
  }
  return out;
}

/** Per-stage readiness for one project (and optionally one of its features). */
export async function status(workspace, project, feature) {
  const rows = [];
  for (const [key, def] of ORDERED) {
    if (def.level === LEVEL.FEATURE && !feature) continue;
    rows.push({
      key,
      def,
      done: await stageIsDone(workspace, key, project, feature),
      unmet: await unmetRequirements(workspace, key, project, feature),
    });
  }
  return rows;
}
