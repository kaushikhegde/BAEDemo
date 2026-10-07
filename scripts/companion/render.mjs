// Render a project's companion app: ONE self-contained HTML page built from
// whatever the pipeline has produced so far.
//
//   node scripts/render-companion-app.mjs <project> [--no-diagrams]
//
// Writes generated-apps/<project>/index.html and that project's entry in
// generated-apps/registry.json. The entry is the LAST thing printed to stdout:
// the chatbot's runHelper takes the trailing JSON object, so nothing after it
// may print a brace.
//
// Every view is rendered here, in node (docs/superpowers/specs/
// 2026-10-07-companion-app-redesign-design.md). The browser script only routes
// between views, opens dialogs and filters — so what a client sees can be
// checked without a browser, and a rendering bug is fixed once, here.
//
// SELF-CONTAINED means self-contained: no CDN, no webfont, no external image.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFeatures as listFeatureDirs } from "../pipeline.mjs";
import {
  WORKSPACE, die, withoutSourceRefs, mdToHtml, collectMermaid, renderDiagrams, loadTheme,
  loadProjectArtefacts, loadFeatureArtefacts, loadImages, FEATURE_TABS,
} from "./load.mjs";
import { slug } from "./html.mjs";
import { page } from "./views/shell.mjs";
import { renderPersonasPanel } from "./views/personas.mjs";
import { renderCapabilitiesPanel } from "./views/capabilities.mjs";
import { renderProcessPanel } from "./views/process.mjs";
import { renderFeaturePanel } from "./views/feature.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAFE_NAME = /^[A-Za-z0-9._ &-]+$/;
const PREVIEW_ORIGIN = process.env.SCYNE_PREVIEW_ORIGIN || "http://127.0.0.1:4000";

/** The per-feature rows each feature tab renders. */
function featureRows(t, features) {
  return features.map((f) => ({
    feature: f.feature,
    has: t.has(f),
    stat: t.has(f) ? t.stat(f) : "Not generated",
    // Which Product Summary these artefacts belong to — "MVP / 8 stories" does
    // not say WHAT those stories realise.
    ps: f.summaries.length === 1 ? f.summaries[0].title
      : f.summaries.length > 1 ? `${f.summaries.length} product summaries` : null,
    docs: t.id === "summary" ? f.html.summaries
      : t.id === "testcases" ? f.html.packs
      : t.id === "datamodel" ? (f.html.dataModel ? [{ id: f.feature, title: f.dataModelKind || "Data Model", html: f.html.dataModel }] : [])
      : t.id === "architecture" ? (f.html.solutionArchitecture ? [{ id: f.feature, title: "Solution Architecture", html: f.html.solutionArchitecture }] : [])
      : t.id === "design" ? (f.html.solutionDesign ? [{ id: f.feature, title: "Solution Design", html: f.html.solutionDesign }] : [])
      : [],
    stories: t.id === "stories" ? f.stories : [],
    screens: t.id === "ui" ? f.screens.map((sc) => ({
      id: sc.id,
      name: sc.name || sc.id,
      persona: sc.persona || "",
      surface: sc.surface || "",
      states: Array.isArray(sc.states) ? sc.states.length : 1,
      stories: Array.isArray(sc?.realises?.stories) ? sc.realises.stories : [],
      // Must match render-mockups.mjs and the chatbot's mockups route.
      href: `mockups/${slug(f.feature)}/${slug(String(sc.id))}.html`,
    })) : [],
    mockupIndex: t.id === "ui" && f.screens.length ? `mockups/${slug(f.feature)}/index.html` : null,
    missing: t.id === "ui" && f.generatedFrom ? ["DataModel", "QA"].filter((k) => !f.generatedFrom.includes(k)) : [],
  }));
}

export async function buildPage({ project, p, features, theme, diagrams, noDiagrams, generatedOn }) {
  const md = (t, scope) => (t ? mdToHtml(t, diagrams, noDiagrams, scope) : null);
  // Heading anchors are scoped per document: every feature's data model and
  // architecture opens with "1. Executive Summary", and unscoped ids collide.
  for (const f of features) {
    const S = (k) => `${slug(f.feature)}-${k}-`;
    f.html = {
      summaries: f.summaries.map((d) => ({ id: d.id, title: d.title, html: md(d.body, S(`ps-${slug(d.id)}`)) })),
      packs: f.packs.map((d) => ({ id: d.id, title: d.title, html: md(d.body, S(`tc-${slug(d.id)}`)) })),
      dataModel: md(f.dataModel, S("dm")),
      solutionDesign: md(f.solutionDesign, S("sd")),
      solutionArchitecture: md(f.solutionArchitecture, S("sa")),
    };
  }

  // Stripped at the one place every view is fed from: which internal file said
  // so is evidence for the record, not something a client should read.
  const clean = withoutSourceRefs({
    personas: p.personas, journeys: p.journeys, capabilities: p.capabilities,
    activities: p.activities, flows: p.flows,
    tabs: Object.fromEntries(FEATURE_TABS.map((t) => [t.id, featureRows(t, features)])),
  });

  const sections = [];
  const defaults = {};
  const add = (id, label, count, view) => {
    sections.push({ id, label, count, html: view.html });
    Object.assign(defaults, view.defaults);
  };
  if (clean.personas.length) {
    add("personas", "Personas", clean.personas.length,
      renderPersonasPanel({ personas: clean.personas, journeys: clean.journeys, images: p.images }));
  }
  if (clean.capabilities.length) {
    add("capabilities", "Capabilities", clean.capabilities.length,
      renderCapabilitiesPanel({ capabilities: clean.capabilities, activities: clean.activities }));
  }
  if (clean.activities.length) {
    add("process", "Process", clean.activities.length,
      renderProcessPanel({ activities: clean.activities, flows: clean.flows }));
  }
  for (const t of FEATURE_TABS) {
    const rows = clean.tabs[t.id];
    const live = rows.filter((r) => r.has).length;
    if (!live) continue;
    add(t.id, t.label, features.length > 1 ? live : null, renderFeaturePanel(t, rows));
  }

  const [css, laneCss, js] = await Promise.all([
    fs.readFile(path.join(HERE, "styles.css"), "utf8"),
    fs.readFile(path.join(HERE, "swimlane.css"), "utf8"),
    fs.readFile(path.join(HERE, "client.js"), "utf8"),
  ]);
  if (/<\/script/i.test(js)) die("client.js must not contain a closing script tag");

  return page({
    project, featureCount: features.length, sections, defaults, theme, generatedOn,
    css: `${css}\n${laneCss}`, js,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((x) => x.startsWith("--")));
  const [project, ...rest] = argv.filter((x) => !x.startsWith("--"));
  for (const f of flags) if (!["--no-diagrams", "--open"].includes(f)) die(`unknown flag ${f}`);
  if (!project) {
    console.error("Usage: node scripts/render-companion-app.mjs <project> [--no-diagrams]");
    process.exit(1);
  }
  if (!SAFE_NAME.test(project)) die("project name contains unexpected characters");
  // A trailing feature name is accepted and ignored: the page covers every
  // feature, and older agent instructions still pass one.
  if (rest.length) console.warn(`[render-companion-app] ignoring "${rest.join(" ")}" — the companion app is project-level now`);

  const projectRoot = path.join(WORKSPACE, "projects", project);
  try { await fs.access(projectRoot); } catch { die(`no such project: projects/${project}`); }

  const p = await loadProjectArtefacts(projectRoot);
  p.images = await loadImages(projectRoot, p.personas);
  const theme = await loadTheme(projectRoot);

  const features = [];
  for (const name of await listFeatureDirs(WORKSPACE, project)) {
    const f = await loadFeatureArtefacts(path.join(projectRoot, name));
    f.feature = name;
    features.push(f);
  }

  const present = [
    p.personas.length && `${p.personas.length} personas`,
    p.journeys.length && `${p.journeys.length} journeys`,
    p.capabilities.length && `${p.capabilities.length} capabilities`,
    p.activities.length && `${p.activities.length} activities`,
    p.flows.length && `${p.flows.length} swimlane${p.flows.length === 1 ? "" : "s"}`,
    ...FEATURE_TABS.map((t) => {
      const n = features.filter((f) => t.has(f)).length;
      return n && `${t.label.toLowerCase()} ×${n}`;
    }),
  ].filter(Boolean);

  // The chatbot matches /nothing to render/i and turns it into a 409; the app
  // stage relies on this refusal. Keep the wording.
  if (present.length === 0) {
    die(`nothing to render for ${project} — no artefacts found.\n` +
        `  Run at least one stage (capability map, personas, requirements, …) first.`);
  }

  // One diagram pass across every document, so a diagram shared by two
  // features renders once.
  const mermaid = collectMermaid(features.flatMap((f) => [
    f.dataModel, f.solutionDesign, f.solutionArchitecture,
    ...f.summaries.map((d) => d.body), ...f.packs.map((d) => d.body),
  ]));
  if (mermaid.size) console.log(`[render-companion-app] rendering ${mermaid.size} diagram(s)…`);
  const noDiagrams = flags.has("--no-diagrams");
  const diagrams = await renderDiagrams(mermaid, { skip: noDiagrams });
  if (noDiagrams && mermaid.size) console.warn(`[render-companion-app] WARN --no-diagrams: ${mermaid.size} diagram(s) shown as source, NOT rendered. Do not ship this build.`);

  const generatedOn = new Date().toISOString().slice(0, 10);
  const html = await buildPage({ project, p, features, theme, diagrams, noDiagrams, generatedOn });

  const appDir = path.join(WORKSPACE, "generated-apps", project);
  await fs.mkdir(appDir, { recursive: true });
  const htmlPath = path.join(appDir, "index.html");
  await fs.writeFile(htmlPath, html, "utf8");

  // The TRAILING SLASH on devUrl matters: the UI tab links into the sibling
  // mockups/ directory relatively, and a relative link on a URL without one
  // resolves a segment too high.
  const registryPath = path.join(WORKSPACE, "generated-apps", "registry.json");
  let registry = {};
  try { registry = JSON.parse(await fs.readFile(registryPath, "utf8")); } catch { /* first render */ }
  const prev = registry[project] || {};
  registry[project] = {
    appPath: path.relative(WORKSPACE, appDir),
    htmlPath: path.relative(WORKSPACE, htmlPath),
    kind: "static-html",
    devUrl: `${PREVIEW_ORIGIN}/api/companion-app/${encodeURIComponent(project)}/`,
    // Preserved across renders — the Developer sets these when it pushes.
    branch: prev.branch ?? null,
    repoUrl: prev.repoUrl ?? null,
    generatedAt: new Date().toISOString(),
    features: Object.fromEntries(features.map((f) => [f.feature, {
      artefacts: FEATURE_TABS.filter((t) => t.has(f)).map((t) => t.label),
      screens: f.screens.length,
    }])),
    artefacts: present,
    diagrams: diagrams.size,
    bytes: Buffer.byteLength(html),
  };
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");

  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`[render-companion-app] ${project} → ${path.relative(WORKSPACE, htmlPath)} (${kb} KB, ${diagrams.size} inline diagram(s), ${features.length} feature(s))`);
  console.log(`  includes: ${present.join(", ")}`);
  console.log(JSON.stringify(registry[project], null, 2));
}
