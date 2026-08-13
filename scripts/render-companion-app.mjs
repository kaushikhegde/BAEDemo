#!/usr/bin/env node
// Render a feature's companion app: ONE self-contained, interactive HTML page
// built from whatever artefacts the pipeline has produced for it.
//
//   node scripts/render-companion-app.mjs <project> <feature> [--no-diagrams] [--open]
//
// Reads (all optional — a perspective appears only if its source exists):
//   outputs/product-summary.md · stories.json · stories.md · gaps.md
//   solutions/DataModel/outputs/{datamodel-impact,salesforce-data-model}.md
//   solutions/Design/outputs/solution-design.md
//   solutions/Architecture/outputs/solution-architecture.md
//   solutions/QA/outputs/test-cases.md
//   solutions/Capabilities/outputs/{capability-map.json,process-model.json}
//   solutions/Experience/outputs/{personas.json,journey-map.json}
//
// Writes:
//   generated-apps/<project>-<feature>/index.html   (inline CSS + JS + data island)
//   generated-apps/registry.json                    (entry for the preview pane)
//
// This replaces the Vite/React scaffold (see scripts/legacy-react-scaffold/).
// The deliverable is something a consultant hands to a client, so it is a
// document, not a running program: no install, no port, no detached process, no
// pid. It opens from a file and survives a restart.
//
// Determinism is the point — the same reasoning as render-capability-map.mjs.
// The agent never hand-writes this HTML, so every run looks the same and a
// rendering bug is fixed once, here, rather than re-argued per feature.
//
// SELF-CONTAINED means self-contained: no CDN, no webfont, no external image.
// Mermaid blocks found in the markdown are pre-rendered to inline SVG at build
// time via mermaid-cli; if that fails the source is shown in a <pre> rather than
// leaving a blank space. Charts are hand-drawn SVG with no library at all.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const WORKSPACE = process.env.WORKSPACE_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_NAME = /^[A-Za-z0-9._ &-]+$/;
const PREVIEW_ORIGIN = process.env.SCYNE_PREVIEW_ORIGIN || "http://127.0.0.1:4000";

const die = (msg) => { console.error(`[render-companion-app] ${msg}`); process.exit(1); };

// ---------------------------------------------------------------- utilities

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// JSON embedded in a <script> must not be able to close the tag early.
const jsonIsland = (data) => JSON.stringify(data).replace(/</g, "\\u003c");

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function readText(...rel) {
  try { return await fs.readFile(path.join(...rel), "utf8"); } catch { return null; }
}
async function readJson(...rel) {
  const raw = await readText(...rel);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (e) {
    console.warn(`[render-companion-app] WARN ${path.relative(WORKSPACE, path.join(...rel))} is not valid JSON (${e.message}) — skipping`);
    return null;
  }
}

// ------------------------------------------------------- markdown → html
// Deliberately small. Every document this renders is one we generate, so the
// surface is known: ATX headings, GFM tables (which our docs lean on heavily),
// fenced code, lists, blockquotes, and inline emphasis/code/links. Anything
// fancier is not worth a dependency in a file that must stay self-contained.

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) =>
    /^(https?:|#|\.|\/)/.test(href) ? `<a href="${esc(href)}" rel="noopener">${label}</a>` : label);
  return t;
}

function mdToHtml(md, diagrams) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let listType = null;

  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code / mermaid
    const fence = /^(`{3,})\s*(\w*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const [, ticks, lang] = fence;
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^${ticks}\\s*$`).test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      const src = body.join("\n");
      if (lang === "mermaid") {
        const key = diagramKey(src);
        const svg = diagrams.get(key);
        out.push(svg
          ? `<figure class="diagram" role="group" aria-label="Diagram" tabindex="0"><div class="diagram-inner">${svg}</div></figure>`
          : `<figure class="diagram diagram-fallback"><figcaption>Diagram source (not rendered)</figcaption><pre tabindex="0"><code>${esc(src)}</code></pre></figure>`);
      } else {
        out.push(`<pre tabindex="0"><code>${esc(src)}</code></pre>`);
      }
      continue;
    }

    // GFM table
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      // A wide table scrolls inside its own container, which makes that container
      // the only way to reach the off-screen columns. Without tabindex a keyboard
      // user simply cannot scroll it, so the columns are unreachable for them.
      const label = esc(head.filter(Boolean).slice(0, 3).join(", ")) || "Table";
      out.push(
        `<div class="table-wrap" tabindex="0" role="region" aria-label="Table: ${label}">` +
        `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
        `</tbody></table></div>`
      );
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl} id="${slug(h[2]).slice(0, 60)}">${inline(h[2])}</h${lvl}>`);
      i++; continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push("<hr/>"); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out.push(`<blockquote>${mdToHtml(buf.join("\n"), diagrams)}</blockquote>`);
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want; }
      let text = (ul || ol)[1];
      // task list checkbox
      const box = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (box) {
        out.push(`<li class="task"><span class="box" aria-hidden="true">${box[1].trim() ? "✓" : ""}</span>${inline(box[2])}</li>`);
      } else {
        out.push(`<li>${inline(text)}</li>`);
      }
      i++; continue;
    }

    if (!line.trim()) { closeList(); i++; continue; }

    closeList();
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|`{3,}|\s*\|)/.test(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  closeList();
  return out.join("\n");
}

// --------------------------------------------------------------- diagrams

const diagramKey = (src) => {
  // Cheap stable key — content-addressed so identical diagrams render once.
  let h = 0;
  for (let i = 0; i < src.length; i++) { h = (h * 31 + src.charCodeAt(i)) | 0; }
  return "d" + (h >>> 0).toString(36) + "_" + src.length;
};

function collectMermaid(docs) {
  const found = new Map();
  for (const md of docs) {
    if (!md) continue;
    const re = /```mermaid\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(md))) {
      const src = m[1].replace(/\s+$/, "");
      found.set(diagramKey(src), src);
    }
  }
  return found;
}

// An SVG with role="img" and no accessible name fails WCAG 1.1.1, so derive one
// from the diagram source: its type, plus its `title` line where mermaid has one.
const DIAGRAM_TYPES = {
  flowchart: "Flowchart", graph: "Flowchart", sequencediagram: "Sequence diagram",
  erdiagram: "Entity relationship diagram", journey: "User journey diagram",
  classdiagram: "Class diagram", statediagram: "State diagram", gantt: "Gantt chart",
  pie: "Pie chart", mindmap: "Mind map", timeline: "Timeline",
};
function diagramLabel(src) {
  const lines = String(src).split("\n").map((l) => l.trim()).filter(Boolean);
  const first = (lines[0] || "").split(/[\s-]/)[0].toLowerCase();
  const kind = DIAGRAM_TYPES[first] || "Diagram";
  const titleLine = lines.find((l) => /^title\s+/i.test(l));
  return titleLine ? `${kind}: ${titleLine.replace(/^title\s+/i, "")}` : kind;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", () => resolve({ ok: false, stderr: "spawn failed" }));
    child.on("close", (code) => resolve({ ok: code === 0, stderr }));
  });
}

// Pre-render every mermaid block to INLINE SVG. Inline (not <img src>) so the
// page stays one file and the diagram inherits the page's fonts and colours.
async function renderDiagrams(sources, { skip }) {
  const out = new Map();
  if (skip || sources.size === 0) return out;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scyne-diagrams-"));
  let failed = 0;
  let n = 0;
  for (const [key, src] of sources) {
    n++;
    const mmd = path.join(dir, `${key}.mmd`);
    const svgPath = path.join(dir, `${key}.svg`);
    await fs.writeFile(mmd, src, "utf8");
    process.stdout.write(`  diagram ${n}/${sources.size} …\r`);
    const r = await run("npx", ["-y", "@mermaid-js/mermaid-cli", "-i", mmd, "-o", svgPath, "-b", "transparent"], { cwd: WORKSPACE });
    if (!r.ok) { failed++; continue; }
    let svg = await fs.readFile(svgPath, "utf8").catch(() => null);
    if (!svg) { failed++; continue; }
    // Strip the XML prolog and any <style> that would leak into the page, and
    // make the SVG responsive rather than fixed-width.
    svg = svg.replace(/<\?xml[^>]*\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
    svg = svg.replace(/<svg /, `<svg role="img" aria-label="${esc(diagramLabel(src))}" class="mermaid-svg" preserveAspectRatio="xMidYMid meet" `);
    svg = svg.replace(/ width="[^"]*"/, "").replace(/ height="[^"]*"/, "");
    out.set(key, svg);
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  process.stdout.write(" ".repeat(40) + "\r");
  if (failed) console.warn(`[render-companion-app] WARN ${failed}/${sources.size} diagram(s) failed to render — source shown instead`);
  return out;
}

// ------------------------------------------------------------------- theme
// Branding is DATA, not code. The renderer is deterministic, so an agent must
// never hand-edit the emitted HTML (the next render would wipe it) and must
// never edit this script for one client (that would change every feature).
// A per-feature design/style-guides/theme.json is the supported surface.
//
//   { "brand": "#464e7e", "accent": "#b4795a", "logoText": "Scyne" }
//
// Foreground for the selected nav item is COMPUTED from the brand colour's
// luminance rather than taken on trust — that is what keeps the page at WCAG
// 2.0 AA no matter which palette a client supplies.

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function expandHex(h) {
  const v = h.slice(1);
  return v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
}
function relativeLuminance(hex) {
  const v = expandHex(hex);
  const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const l1 = relativeLuminance(a), l2 = relativeLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
/** Whichever of white / near-black reads better on `bg`. */
function readableOn(bg) {
  return contrast(bg, "#ffffff") >= contrast(bg, "#12151d") ? "#ffffff" : "#12151d";
}

function hexToRgb(hex) {
  const v = expandHex(hex);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
}
const toHexStr = (rgb) => `#${rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a, b, t) => toHexStr(hexToRgb(a).map((c, i) => c + (hexToRgb(b)[i] - c) * t));

/**
 * A brand colour used as TEXT has to clear 4.5:1 against the surface behind it.
 * A client's palette is chosen for their website, not for this page's dark mode:
 * most brand colours are dark, and pasting one straight into both themes makes
 * the wordmark, headings and links invisible on a dark background. So the text
 * role is derived per theme — the brand is walked toward white or black only as
 * far as it must go, which keeps the hue recognisably theirs.
 */
function brandTextColor(brand, surface) {
  const target = readableOn(surface); // walk toward whichever end has headroom
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = mix(brand, target, t);
    if (contrast(c, surface) >= 4.5) return c;
  }
  return target;
}

/**
 * A colour used as a BACKGROUND behind text must clear 4.5:1 against some
 * foreground. Mid-greys are a dead zone: white and black both land near 4.4:1
 * there, so no choice of text colour rescues them. A brand that falls in that
 * band is walked out of it rather than trusted — otherwise the selected
 * navigation item fails for every client whose brand is a mid-tone.
 */
function ensureTextSurface(bg, toward) {
  if (contrast(bg, readableOn(bg)) >= 4.5) return bg;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(bg, toward, t);
    if (contrast(c, readableOn(c)) >= 4.5) return c;
  }
  return toward;
}

/**
 * A font stack out of theme.json is untrusted text landing inside a CSS rule.
 * Only family names, quotes, commas and spaces can survive — anything that could
 * close the declaration or pull a resource is rejected outright rather than
 * stripped, so a mangled stack never silently becomes a different font.
 */
function safeFontStack(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 160) return null;
  if (!/^[A-Za-z0-9 ,'"._-]+$/.test(s)) return null;
  if (/url\(|@import|expression|[;{}<>\\]/i.test(s)) return null;
  return s;
}

/** Only an inline raster/vector data URI — the page must make zero requests. */
function safeLogoSrc(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/.test(s)) return null;
  if (s.length > 700_000) return null;
  return s;
}

async function loadTheme(featureRoot) {
  const t = await readJson(path.join(featureRoot, "design", "style-guides", "theme.json"));
  // `vars` applies to both themes; `lightVars` / `darkVars` are theme-scoped and
  // must win over the stylesheet's own dark block, so they are emitted after it.
  const out = { logoText: "Scyne", logoSrc: null, fontStack: null, vars: {}, lightVars: {}, darkVars: {} };
  if (!t) return out;
  if (typeof t.logoText === "string" && t.logoText.trim()) out.logoText = t.logoText.trim();

  if (t.logoSrc != null) {
    out.logoSrc = safeLogoSrc(t.logoSrc);
    if (!out.logoSrc) console.warn(`[render-companion-app] WARN theme.json "logoSrc" is not an inline data:image URI — ignored`);
  }
  if (t.fontFamily != null) {
    out.fontStack = safeFontStack(t.fontFamily);
    if (!out.fontStack) console.warn(`[render-companion-app] WARN theme.json "fontFamily" is not a plain font stack — ignored`);
  }
  const map = { brand: "--brand", brandDeep: "--brand-deep", accent: "--accent", ink: "--ink", bg: "--bg", panel: "--panel", line: "--line" };
  for (const [k, cssVar] of Object.entries(map)) {
    const v = t[k];
    if (typeof v === "string" && HEX.test(v.trim())) out.vars[cssVar] = v.trim();
    else if (v != null) console.warn(`[render-companion-app] WARN theme.json "${k}" is not a hex colour — ignored`);
  }
  if (out.vars["--brand"]) {
    const brand = out.vars["--brand"];
    const LIGHT_SURFACE = "#f7f8fb", DARK_SURFACE = "#181c26";

    // The selected navigation item paints text ON the brand, so the brand has to
    // be a surface that can carry text at all.
    const selLight = ensureTextSurface(brand, "#12151d");
    out.vars["--sel-bg"] = selLight;
    out.vars["--sel-fg"] = readableOn(selLight);

    // The wordmark, panel headings and links read against the page surface, and
    // that surface differs per theme — so these are theme-scoped, not part of
    // the single override block that applies to both.
    out.lightVars["--brand-fg"] = brandTextColor(out.vars["--brand-deep"] || brand, LIGHT_SURFACE);
    out.darkVars["--brand-fg"] = brandTextColor(brand, DARK_SURFACE);

    // The brand as a background also flips: a dark navy is right in light mode
    // and disappears into a dark one, so lift it clear of the dark surface, then
    // make sure the lifted colour can still carry text.
    const darkBrand = ensureTextSurface(
      contrast(brand, DARK_SURFACE) >= 3 ? brand : mix(brand, "#ffffff", 0.45),
      "#ffffff",
    );
    out.darkVars["--brand"] = darkBrand;
    out.darkVars["--sel-bg"] = darkBrand;
    out.darkVars["--sel-fg"] = readableOn(darkBrand);

    console.log(
      `[render-companion-app] theme: brand ${brand}\n` +
      `  light  nav ${selLight} on ${out.vars["--sel-fg"]} (${contrast(selLight, out.vars["--sel-fg"]).toFixed(1)}:1), ` +
      `text ${out.lightVars["--brand-fg"]} (${contrast(out.lightVars["--brand-fg"], LIGHT_SURFACE).toFixed(1)}:1)\n` +
      `  dark   nav ${darkBrand} on ${out.darkVars["--sel-fg"]} (${contrast(darkBrand, out.darkVars["--sel-fg"]).toFixed(1)}:1), ` +
      `text ${out.darkVars["--brand-fg"]} (${contrast(out.darkVars["--brand-fg"], DARK_SURFACE).toFixed(1)}:1)`,
    );
  }
  return out;
}

// ------------------------------------------------------------------ inputs

async function loadArtefacts(featureRoot) {
  const R = (...p) => path.join(featureRoot, ...p);
  const [
    productSummary, storiesJson, storiesMd, gaps,
    dataModelImpact, salesforceDataModel, solutionDesign, solutionArchitecture, testCases,
    capabilityMap, processModel, personas, journeyMap,
  ] = await Promise.all([
    readText(R("outputs", "product-summary.md")),
    readJson(R("outputs", "stories.json")),
    readText(R("outputs", "stories.md")),
    readText(R("outputs", "gaps.md")),
    readText(R("solutions", "DataModel", "outputs", "datamodel-impact.md")),
    readText(R("solutions", "DataModel", "outputs", "salesforce-data-model.md")),
    readText(R("solutions", "Design", "outputs", "solution-design.md")),
    readText(R("solutions", "Architecture", "outputs", "solution-architecture.md")),
    readText(R("solutions", "QA", "outputs", "test-cases.md")),
    readJson(R("solutions", "Capabilities", "outputs", "capability-map.json")),
    readJson(R("solutions", "Capabilities", "outputs", "process-model.json")),
    readJson(R("solutions", "Experience", "outputs", "personas.json")),
    readJson(R("solutions", "Experience", "outputs", "journey-map.json")),
  ]);

  const stories = Array.isArray(storiesJson)
    ? storiesJson.map((s) => ({
        summary: s?.fields?.summary ?? s?.summary ?? "",
        description: s?.fields?.description ?? s?.description ?? "",
        labels: s?.fields?.labels ?? s?.labels ?? [],
      }))
    : [];

  return {
    productSummary, stories, storiesMd, gaps,
    dataModel: dataModelImpact || salesforceDataModel,
    dataModelKind: dataModelImpact ? "Data Model Impact" : salesforceDataModel ? "Salesforce Data Model" : null,
    solutionDesign, solutionArchitecture, testCases,
    capabilities: Array.isArray(capabilityMap?.capabilities) ? capabilityMap.capabilities : [],
    activities: Array.isArray(processModel?.activities) ? processModel.activities : [],
    personas: Array.isArray(personas?.personas) ? personas.personas : [],
    journeys: Array.isArray(journeyMap?.journeys) ? journeyMap.journeys : [],
  };
}

// ------------------------------------------------------------------ page

function page({ project, feature, generatedOn, a, docHtml, theme }) {
  const title = `${feature} — Companion App`;
  const data = jsonIsland({
    project, feature,
    personas: a.personas, journeys: a.journeys,
    capabilities: a.capabilities, activities: a.activities,
    stories: a.stories,
  });

  const sections = [];
  const push = (id, label, count) => sections.push({ id, label, count });
  push("overview", "Overview", null);
  if (a.personas.length) push("personas", "Personas", a.personas.length);
  if (a.journeys.length) push("journeys", "Journeys", a.journeys.length);
  if (a.capabilities.length) push("capabilities", "Capabilities", a.capabilities.length);
  if (a.activities.length) push("process", "Process", a.activities.length);
  if (a.stories.length) push("stories", "Stories", a.stories.length);
  if (a.productSummary) push("summary", "Product Summary", null);
  if (a.dataModel) push("datamodel", "Data Model", null);
  if (a.solutionDesign) push("design", "Solution Design", null);
  if (a.solutionArchitecture) push("architecture", "Architecture", null);
  if (a.testCases) push("testcases", "Test Cases", null);
  if (a.gaps) push("gaps", "Gaps", null);

  const nav = sections.map((s) =>
    `<li role="none"><a href="#/${s.id}" data-nav="${s.id}" role="tab" aria-selected="false" tabindex="-1">` +
    `<span>${esc(s.label)}</span>${s.count != null ? `<span class="pill">${s.count}</span>` : ""}</a></li>`
  ).join("");

  const inventory = sections.filter((s) => s.id !== "overview").map((s) =>
    `<li><a href="#/${s.id}">${esc(s.label)}</a>${s.count != null ? ` — ${s.count} record${s.count === 1 ? "" : "s"}` : ""}</li>`
  ).join("") || "<li>No artefacts generated for this feature yet.</li>";

  const docPanel = (id, heading, html) => html
    ? `<section class="panel" id="panel-${id}" role="tabpanel" aria-labelledby="tab-${id}" hidden>
         <h2 class="panel-h">${esc(heading)}</h2>
         <div class="doc">${html}</div>
       </section>` : "";

  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<meta name="description" content="Companion app for ${esc(project)} / ${esc(feature)} — personas, journeys, capabilities, process and solution artefacts."/>
<style>
:root{
  --ink:#1f2430; --muted:#5c6478; --line:#e2e5ee; --bg:#ffffff; --panel:#f7f8fb;
  --brand:#464e7e; --brand-deep:#363c63; --accent:#b4795a;
  --sel-bg:#464e7e; --sel-fg:#ffffff;
  --ok:#2f7d5d; --warn:#a8621b; --bad:#b3402f;
  --radius:12px; --maxw:1160px;
  --shadow:0 1px 2px rgba(20,24,40,.06),0 8px 24px rgba(20,24,40,.06);
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --ink:#e8eaf2; --muted:#a2abc2; --line:#2c3242; --bg:#12151d; --panel:#181c26;
    --brand:#9aa6e0; --brand-deep:#c3cbf0; --accent:#d79a76;
    --sel-bg:#9aa6e0; --sel-fg:#12151d;
    --ok:#5cc292; --warn:#e0a35c; --bad:#e8796a;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
  }
}
:root[data-theme="dark"]{
  --ink:#e8eaf2; --muted:#a2abc2; --line:#2c3242; --bg:#12151d; --panel:#181c26;
  --brand:#9aa6e0; --brand-deep:#c3cbf0; --accent:#d79a76;
  --sel-bg:#9aa6e0; --sel-fg:#12151d;
  --ok:#5cc292; --warn:#e0a35c; --bad:#e8796a;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--ink);
  font:15px/1.6 var(--font,Arial,"Helvetica Neue",Helvetica,sans-serif);
  -webkit-text-size-adjust:100%;
}
a{color:var(--brand-fg,var(--brand-deep))}
a:focus-visible,button:focus-visible,[tabindex]:focus-visible,input:focus-visible,select:focus-visible{
  outline:3px solid var(--accent); outline-offset:2px; border-radius:4px;
}
.skip{position:absolute;left:-9999px;top:0;background:var(--brand);color:#fff;padding:.6rem 1rem;z-index:99}
.skip:focus{left:.5rem;top:.5rem}
header.top{
  border-bottom:1px solid var(--line); background:var(--panel);
  position:sticky; top:0; z-index:20;
}
.top-in{max-width:var(--maxw);margin:0 auto;padding:.85rem 1.25rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
.brand{font-weight:700;color:var(--brand-fg,var(--brand-deep));letter-spacing:.02em}
.crumb{color:var(--muted);font-size:.85rem}
.spacer{flex:1}
.btn{
  background:transparent;border:1px solid var(--line);color:var(--ink);
  padding:.4rem .7rem;border-radius:999px;cursor:pointer;font-size:.82rem;
}
.btn:hover{border-color:var(--brand)}
.search{
  border:1px solid var(--line);background:var(--bg);color:var(--ink);
  padding:.45rem .7rem;border-radius:999px;min-width:min(280px,50vw);font-size:.85rem;
}
.wrap{max-width:var(--maxw);margin:0 auto;padding:1.25rem;display:grid;grid-template-columns:220px 1fr;gap:1.5rem}
@media (max-width:860px){.wrap{grid-template-columns:1fr}}
nav.side ul{list-style:none;margin:0;padding:0;position:sticky;top:76px}
nav.side a{
  display:flex;align-items:center;gap:.5rem;justify-content:space-between;
  padding:.5rem .7rem;border-radius:8px;text-decoration:none;color:var(--ink);font-size:.9rem;
}
nav.side a:hover{background:var(--panel)}
nav.side a[aria-selected="true"]{background:var(--sel-bg);color:var(--sel-fg);font-weight:600}
nav.side a[aria-selected="true"] .pill{background:transparent;border-color:currentColor;color:var(--sel-fg)}
.pill{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:0 .45rem;font-size:.72rem;color:var(--muted)}
main{min-width:0}
.panel[hidden]{display:none}
.panel-h{margin:.2rem 0 1rem;font-size:1.5rem;color:var(--brand-fg,var(--brand-deep))}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem}
.card{
  border:1px solid var(--line);border-radius:var(--radius);padding:1rem;background:var(--bg);
  box-shadow:var(--shadow);text-align:left;width:100%;cursor:pointer;color:inherit;font:inherit;
}
.card:hover{border-color:var(--brand)}
.card h3{margin:.1rem 0 .2rem;font-size:1.05rem}
.card .role{color:var(--muted);font-size:.85rem;margin-bottom:.5rem}
.avatar{width:38px;height:38px;border-radius:999px;display:grid;place-items:center;color:#fff;font-weight:700;margin-bottom:.5rem}
.two{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media (max-width:700px){.two{grid-template-columns:1fr}}
.box{border:1px solid var(--line);border-radius:var(--radius);padding:.9rem;background:var(--panel)}
.box h4{margin:.1rem 0 .5rem;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.box ul{margin:0;padding-left:1.1rem}
.tag{display:inline-block;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:.1rem .55rem;font-size:.75rem;color:var(--muted);margin:.15rem .25rem .15rem 0}
.doc h1{font-size:1.6rem}.doc h2{font-size:1.25rem;margin-top:1.6rem;border-bottom:1px solid var(--line);padding-bottom:.3rem}
.doc h3{font-size:1.05rem;margin-top:1.2rem}
.doc code{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:0 .25rem;font-size:.88em}
.doc pre{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.8rem;overflow:auto}
.doc pre code{border:0;background:none;padding:0}
.doc blockquote{margin:.8rem 0;padding:.1rem .9rem;border-left:3px solid var(--accent);background:var(--panel);border-radius:0 8px 8px 0}
.doc li.task{list-style:none;margin-left:-1.1rem}
.doc li.task .box{display:inline-grid;place-items:center;width:1em;height:1em;border:1px solid var(--muted);border-radius:3px;margin-right:.4rem;padding:0;background:none;font-size:.8em}
.table-wrap{overflow-x:auto;margin:.8rem 0;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:.88rem}
th,td{text-align:left;padding:.5rem .65rem;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--panel);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);position:sticky;top:0}
tbody tr:last-child td{border-bottom:0}
figure.diagram{margin:1rem 0;border:1px solid var(--line);border-radius:var(--radius);padding:1rem;background:var(--panel);overflow:auto}
.diagram-inner{min-width:min-content}
.mermaid-svg{max-width:100%;height:auto;display:block;margin:0 auto}
figure.diagram-fallback figcaption{color:var(--muted);font-size:.8rem;margin-bottom:.4rem}
.filters{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem;align-items:center}
select{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:8px;padding:.35rem .5rem;font-size:.85rem}
.tree{list-style:none;margin:0;padding:0}
.tree ul{list-style:none;margin:0;padding-left:1.1rem;border-left:1px dashed var(--line)}
.tree li{margin:.15rem 0}
.node{display:flex;gap:.5rem;align-items:center;padding:.3rem .45rem;border-radius:6px}
.node:hover{background:var(--panel)}
.lvl{font-size:.68rem;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 .3rem}
.bar{height:6px;border-radius:999px;background:var(--line);width:70px;overflow:hidden;flex:none}
.bar span{display:block;height:100%;background:var(--brand)}
.legend{display:flex;gap:1rem;flex-wrap:wrap;color:var(--muted);font-size:.8rem;margin:.4rem 0 1rem}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:.35rem}
.j-stage{border:1px solid var(--line);border-radius:var(--radius);margin-bottom:1rem;overflow:hidden}
.j-stage>h4{margin:0;padding:.6rem .9rem;background:var(--panel);font-size:.95rem;border-bottom:1px solid var(--line)}
.step{padding:.7rem .9rem;border-bottom:1px solid var(--line)}
.step:last-child{border-bottom:0}
.step-top{display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap}
.step-name{font-weight:600}
.score{font-size:.75rem;border-radius:999px;padding:.05rem .5rem;border:1px solid var(--line)}
.score-1,.score-2{color:var(--bad)} .score-3{color:var(--warn)} .score-4,.score-5{color:var(--ok)}
.dl{display:grid;grid-template-columns:auto 1fr;gap:.15rem .7rem;margin:.4rem 0 0;font-size:.88rem}
.dl dt{color:var(--muted)}
.dl dd{margin:0}
.moment{border-left:3px solid var(--accent);background:var(--panel);padding:.5rem .7rem;border-radius:0 8px 8px 0;margin:.3rem 0}
.chart{width:100%;height:auto;display:block}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .axis{stroke:var(--muted);stroke-width:1}
.chart text{fill:var(--muted);font-size:10px}
.chart .today{stroke:var(--bad);stroke-width:2.5;fill:none}
.chart .target{stroke:var(--ok);stroke-width:2.5;fill:none;stroke-dasharray:5 3}
.chart .dot-today{fill:var(--bad)} .chart .dot-target{fill:var(--ok)}
.empty{color:var(--muted);font-style:italic;padding:2rem;text-align:center;border:1px dashed var(--line);border-radius:var(--radius)}
footer{max-width:var(--maxw);margin:0 auto;padding:2rem 1.25rem;color:var(--muted);font-size:.8rem;border-top:1px solid var(--line)}
mark{background:var(--accent);color:#fff;border-radius:3px;padding:0 .1rem}
dialog{border:1px solid var(--line);border-radius:var(--radius);padding:0;max-width:min(760px,92vw);width:100%;background:var(--bg);color:var(--ink);box-shadow:var(--shadow)}
dialog::backdrop{background:rgba(10,12,20,.5)}
.dlg-head{display:flex;align-items:center;gap:.8rem;padding:1rem 1.2rem;border-bottom:1px solid var(--line)}
.dlg-body{padding:1.2rem;max-height:70vh;overflow:auto}
@media print{
  nav.side,header.top,.btn,.search,.filters{display:none!important}
  .panel[hidden]{display:block!important}
  .wrap{grid-template-columns:1fr}
}
${(() => {
  const decl = (o) => Object.entries(o).map(([k, v]) => `${k}:${v};`).join("");
  const vars = { ...theme.vars };
  // The page loads no webfont, so the client's face only applies where it is
  // already installed — always keep a generic tail so text renders regardless.
  if (theme.fontStack) vars["--font"] = `${theme.fontStack},Arial,"Helvetica Neue",Helvetica,sans-serif`;
  const out = [];
  if (Object.keys(vars).length) out.push(`:root,:root[data-theme]{${decl(vars)}}`);
  // Theme-scoped overrides mirror the three states the base stylesheet uses:
  // bare :root (light), the prefers-color-scheme block guarded against an
  // explicit light choice, and the explicit dark attribute.
  if (Object.keys(theme.lightVars).length) out.push(`:root,:root[data-theme="light"]{${decl(theme.lightVars)}}`);
  if (Object.keys(theme.darkVars).length) {
    const d = decl(theme.darkVars);
    out.push(`@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${d}}}`);
    out.push(`:root[data-theme="dark"]{${d}}`);
  }
  return out.join("\n");
})()}
.brand-logo{height:26px;width:auto;max-width:170px;display:block;flex:0 0 auto}
.brand-lock{display:flex;align-items:center;gap:.55rem;min-width:0}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="top-in">
    <span class="brand-lock">${theme.logoSrc ? `<img class="brand-logo" src="${theme.logoSrc}" alt=""/>` : ""}<span class="brand">${esc(theme.logoText)}</span></span>
    <span class="crumb">${esc(project)} <span aria-hidden="true">/</span> ${esc(feature)}</span>
    <span class="spacer"></span>
    <label class="visually-hidden" for="q" style="position:absolute;left:-9999px">Search this page</label>
    <input id="q" class="search" type="search" placeholder="Search personas, steps, capabilities…" autocomplete="off"/>
    <button class="btn" id="theme" type="button" aria-pressed="false">Dark</button>
    <button class="btn" id="printer" type="button">Print</button>
  </div>
</header>

<div class="wrap">
  <nav class="side" aria-label="Sections">
    <ul role="tablist" aria-orientation="vertical">${nav}</ul>
  </nav>

  <main id="main" tabindex="-1">
    <section class="panel" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview">
      <h2 class="panel-h">${esc(feature)}</h2>
      <p>Companion app for <strong>${esc(project)} / ${esc(feature)}</strong>, generated on ${esc(generatedOn)} from the artefacts this feature has produced. Everything below is embedded in this single file — it works offline, from a file, with no server.</p>
      <div class="box"><h4>What's in here</h4><ul>${inventory}</ul></div>
    </section>

    <section class="panel" id="panel-personas" role="tabpanel" aria-labelledby="tab-personas" hidden>
      <h2 class="panel-h">Personas</h2>
      <div class="cards" id="persona-cards"></div>
    </section>

    <section class="panel" id="panel-journeys" role="tabpanel" aria-labelledby="tab-journeys" hidden>
      <h2 class="panel-h">Journeys</h2>
      <div class="filters">
        <label for="j-pick">Journey</label>
        <select id="j-pick"></select>
      </div>
      <div id="journey-body"></div>
    </section>

    <section class="panel" id="panel-capabilities" role="tabpanel" aria-labelledby="tab-capabilities" hidden>
      <h2 class="panel-h">Capabilities</h2>
      <div class="legend">
        <span><i style="background:var(--line)"></i>Current maturity</span>
        <span><i style="background:var(--brand)"></i>Target maturity</span>
      </div>
      <ul class="tree" id="cap-tree"></ul>
    </section>

    <section class="panel" id="panel-process" role="tabpanel" aria-labelledby="tab-process" hidden>
      <h2 class="panel-h">Process model</h2>
      <div class="filters">
        <label for="p-phase">Phase</label><select id="p-phase"></select>
        <label for="p-actor">Actor</label><select id="p-actor"></select>
      </div>
      <div id="proc-body"></div>
    </section>

    <section class="panel" id="panel-stories" role="tabpanel" aria-labelledby="tab-stories" hidden>
      <h2 class="panel-h">User stories</h2>
      <div id="story-list"></div>
    </section>

    ${docPanel("summary", "Product Summary", docHtml.productSummary)}
    ${docPanel("datamodel", a.dataModelKind || "Data Model", docHtml.dataModel)}
    ${docPanel("design", "Solution Design", docHtml.solutionDesign)}
    ${docPanel("architecture", "Solution Architecture", docHtml.solutionArchitecture)}
    ${docPanel("testcases", "Test Cases", docHtml.testCases)}
    ${docPanel("gaps", "Gaps", docHtml.gaps)}
  </main>
</div>

<dialog id="dlg" aria-labelledby="dlg-title">
  <div class="dlg-head"><h3 id="dlg-title" style="margin:0;font-size:1.1rem"></h3><span class="spacer"></span>
    <button class="btn" id="dlg-close" type="button">Close</button></div>
  <div class="dlg-body" id="dlg-body"></div>
</dialog>

<footer>Generated by <code>scripts/render-companion-app.mjs</code> on ${esc(generatedOn)}. Self-contained: no network requests, no external assets.</footer>

<script type="application/json" id="data">${data}</script>
<script>
(function(){
  "use strict";
  var DATA = JSON.parse(document.getElementById("data").textContent);
  var $ = function(s,r){ return (r||document).querySelector(s); };
  var $$ = function(s,r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };
  function el(tag, cls, text){ var n=document.createElement(tag); if(cls) n.className=cls; if(text!=null) n.textContent=text; return n; }

  // ---------------- navigation (tabs + hash routing, keyboard accessible)
  var navLinks = $$("[data-nav]");
  navLinks.forEach(function(a){ a.id = "tab-" + a.getAttribute("data-nav"); a.setAttribute("aria-controls","panel-"+a.getAttribute("data-nav")); });

  function show(id, focusMain){
    if(!document.getElementById("panel-"+id)) id = "overview";
    $$(".panel").forEach(function(p){ p.hidden = (p.id !== "panel-"+id); });
    navLinks.forEach(function(a){
      var on = a.getAttribute("data-nav") === id;
      a.setAttribute("aria-selected", on ? "true" : "false");
      a.tabIndex = on ? 0 : -1;
    });
    if(focusMain){ $("#main").focus(); }
  }
  function fromHash(){ var m = /^#\\/(.+)$/.exec(location.hash || ""); show(m ? m[1] : "overview", false); }
  window.addEventListener("hashchange", fromHash);

  // Roving tabindex so arrow keys move between sections, per WAI-ARIA tabs.
  $(".side ul").addEventListener("keydown", function(e){
    var i = navLinks.indexOf(document.activeElement);
    if(i < 0) return;
    var next = null;
    if(e.key === "ArrowDown" || e.key === "ArrowRight") next = navLinks[(i+1) % navLinks.length];
    else if(e.key === "ArrowUp" || e.key === "ArrowLeft") next = navLinks[(i-1+navLinks.length) % navLinks.length];
    else if(e.key === "Home") next = navLinks[0];
    else if(e.key === "End") next = navLinks[navLinks.length-1];
    if(next){ e.preventDefault(); next.focus(); next.click(); }
  });

  // ---------------- personas
  var personas = DATA.personas || [];
  var COLOURS = {"bg-blue-900":"#1e3a8a","bg-amber-500":"#f59e0b","bg-teal-600":"#0d9488","bg-sky-400":"#38bdf8","bg-rose-600":"#e11d48","bg-violet-700":"#6d28d9","bg-emerald-600":"#059669"};
  function personaColour(p){ return COLOURS[p.avatarColor] || "#464e7e"; }

  var cards = $("#persona-cards");
  if(cards){
    personas.forEach(function(p){
      var b = el("button","card"); b.type="button";
      b.setAttribute("aria-haspopup","dialog");
      var av = el("div","avatar", (p.name||"?").slice(0,1).toUpperCase());
      av.style.background = personaColour(p);
      b.appendChild(av);
      b.appendChild(el("h3", null, p.name || p.id));
      b.appendChild(el("div","role", p.role || ""));
      b.appendChild(el("p", null, p.context || ""));
      if(p.keyBenefit){ var k = el("div","tag", p.keyBenefit); b.appendChild(k); }
      b.addEventListener("click", function(){ openPersona(p); });
      cards.appendChild(b);
    });
    if(!personas.length) cards.appendChild(el("div","empty","No personas generated for this feature yet."));
  }

  var dlg = $("#dlg");
  function openPersona(p){
    $("#dlg-title").textContent = (p.name||"") + " — " + (p.role||"");
    var body = $("#dlg-body"); body.innerHTML = "";
    if(p.context) body.appendChild(el("p", null, p.context));
    var two = el("div","two");
    [["Today", p.today||[]], ["Tomorrow", p.tomorrow||[]]].forEach(function(pair){
      var box = el("div","box"); box.appendChild(el("h4", null, pair[0]));
      var ul = el("ul"); pair[1].forEach(function(t){ ul.appendChild(el("li", null, t)); }); box.appendChild(ul);
      two.appendChild(box);
    });
    body.appendChild(two);
    if(p.keyBenefit){ var kb = el("div","box"); kb.appendChild(el("h4",null,"Key benefit")); kb.appendChild(el("p",null,p.keyBenefit)); body.appendChild(kb); }
    if(p.journeySummary){ var js = el("div","box"); js.appendChild(el("h4",null,"Journey")); js.appendChild(el("p",null,p.journeySummary)); body.appendChild(js); }
    var j = (DATA.journeys||[]).filter(function(x){ return x.personaId === p.id; })[0];
    if(j){
      var go = el("button","btn","Open " + (j.title||"journey"));
      go.type = "button";
      go.addEventListener("click", function(){ dlg.close(); location.hash = "#/journeys"; var sel=$("#j-pick"); if(sel){ sel.value = j.id; sel.dispatchEvent(new Event("change")); } });
      body.appendChild(el("div", null, " ")).appendChild(go);
    }
    if((p.sources||[]).length){
      var s = el("div","box"); s.appendChild(el("h4",null,"Evidence"));
      p.sources.forEach(function(f){ s.appendChild(el("span","tag", f)); });
      body.appendChild(s);
    }
    if(typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open","");
  }
  if($("#dlg-close")) $("#dlg-close").addEventListener("click", function(){ dlg.close(); });

  // ---------------- journeys
  var journeys = DATA.journeys || [];
  var pick = $("#j-pick");
  if(pick){
    journeys.forEach(function(j){
      var o = el("option", null, (personaName(j.personaId) ? personaName(j.personaId) + " — " : "") + (j.title || j.id));
      o.value = j.id; pick.appendChild(o);
    });
    pick.addEventListener("change", function(){ drawJourney(pick.value); });
    if(journeys.length) drawJourney(journeys[0].id);
    else $("#journey-body").appendChild(el("div","empty","No journeys generated for this feature yet."));
  }
  function personaName(id){ var p = personas.filter(function(x){ return x.id === id; })[0]; return p ? p.name : ""; }

  function drawJourney(id){
    var j = journeys.filter(function(x){ return x.id === id; })[0];
    var host = $("#journey-body"); host.innerHTML = "";
    if(!j) return;
    if(j.scenario) host.appendChild(el("p", null, j.scenario));

    var steps = [];
    (j.stages||[]).forEach(function(st){ (st.steps||[]).forEach(function(s){ steps.push({ stage: st.name, step: s }); }); });

    // Satisfaction curve — hand-drawn SVG, no charting library.
    if(steps.length){
      var fig = el("figure","diagram");
      fig.appendChild(chart(steps));
      var cap = el("figcaption");
      cap.style.cssText = "color:var(--muted);font-size:.8rem;margin-top:.5rem;text-align:center";
      cap.textContent = "Satisfaction across the journey — solid red is today, dashed green is the target state (1 = harmful, 5 = excellent).";
      fig.appendChild(cap);
      host.appendChild(fig);
    }

    (j.stages||[]).forEach(function(st){
      var wrap = el("div","j-stage");
      wrap.appendChild(el("h4", null, st.name + (st.l1Phase ? "  ·  " + st.l1Phase : "")));
      (st.steps||[]).forEach(function(s){
        var d = el("div","step");
        var top = el("div","step-top");
        top.appendChild(el("span","step-name", s.name));
        if(s.actor) top.appendChild(el("span","tag", s.actor));
        if(s.channel) top.appendChild(el("span","tag", s.channel));
        top.appendChild(el("span","score score-"+s.todayScore, "today " + s.todayScore));
        top.appendChild(el("span","score score-"+s.targetScore, "target " + s.targetScore));
        d.appendChild(top);
        var dl = el("dl","dl");
        [["Doing", s.doing], ["Thinking", s.thinking], ["Feeling", s.feeling]].forEach(function(p){
          if(!p[1]) return;
          dl.appendChild(el("dt", null, p[0])); dl.appendChild(el("dd", null, p[1]));
        });
        if((s.painPoints||[]).length){ dl.appendChild(el("dt",null,"Pain")); dl.appendChild(el("dd",null,s.painPoints.join(" · "))); }
        if((s.opportunities||[]).length){ dl.appendChild(el("dt",null,"Opportunity")); dl.appendChild(el("dd",null,s.opportunities.join(" · "))); }
        d.appendChild(dl);
        wrap.appendChild(d);
      });
      host.appendChild(wrap);
    });

    if((j.momentsThatMatter||[]).length){
      var box = el("div","box"); box.appendChild(el("h4", null, "Moments that matter"));
      j.momentsThatMatter.forEach(function(m){
        var name = "";
        (j.stages||[]).forEach(function(st){ (st.steps||[]).forEach(function(s){ if(s.id === m.stepId) name = s.name; }); });
        var mm = el("div","moment");
        mm.appendChild(el("strong", null, name || m.stepId));
        mm.appendChild(el("div", null, m.why || ""));
        if(m.designResponse) mm.appendChild(el("div", null, "\\u2192 " + m.designResponse));
        box.appendChild(mm);
      });
      host.appendChild(box);
    }

    if((j.metrics||[]).length){
      var t = el("table");
      t.innerHTML = "<thead><tr><th>Metric</th><th>Today</th><th>Target</th></tr></thead>";
      var tb = el("tbody");
      j.metrics.forEach(function(m){
        var tr = el("tr");
        [m.name, m.today, m.target].forEach(function(v){ tr.appendChild(el("td", null, v || "—")); });
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      var tw = scrollTable(t, "Experience metrics");
      var h = el("h3", null, "Experience metrics"); host.appendChild(h); host.appendChild(tw);
    }
  }

  // A scrolling table container is unreachable by keyboard unless it is
  // focusable — the off-screen columns would exist but not be viewable.
  function scrollTable(t, label){
    var tw = el("div","table-wrap");
    tw.setAttribute("tabindex","0");
    tw.setAttribute("role","region");
    tw.setAttribute("aria-label","Table: " + label);
    tw.appendChild(t);
    return tw;
  }

  function chart(steps){
    var W = 720, H = 220, padL = 34, padR = 12, padT = 14, padB = 54;
    var n = steps.length;
    var svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("viewBox","0 0 "+W+" "+H);
    svg.setAttribute("class","chart");
    svg.setAttribute("role","img");
    svg.setAttribute("aria-label", "Satisfaction chart across " + n + " journey steps, comparing today with the target state.");
    function x(i){ return n===1 ? padL : padL + i * (W-padL-padR) / (n-1); }
    function y(v){ return padT + (5-v) * (H-padT-padB) / 4; }
    function add(tag, attrs){ var e=document.createElementNS("http://www.w3.org/2000/svg",tag); for(var k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; }

    for(var v=1; v<=5; v++){
      add("line",{class:"grid", x1:padL, x2:W-padR, y1:y(v), y2:y(v)});
      var t = add("text",{x:padL-8, y:y(v)+3, "text-anchor":"end"}); t.textContent = v;
    }
    add("line",{class:"axis", x1:padL, x2:padL, y1:padT, y2:H-padB});

    ["today","target"].forEach(function(kind){
      var pts = steps.map(function(s,i){ return x(i)+","+y(kind==="today" ? s.step.todayScore : s.step.targetScore); }).join(" ");
      add("polyline",{class:kind, points:pts});
      steps.forEach(function(s,i){
        add("circle",{class:"dot-"+kind, cx:x(i), cy:y(kind==="today"?s.step.todayScore:s.step.targetScore), r:3});
      });
    });

    // Stage labels along the bottom, rotated so long names stay readable.
    var lastStage = null;
    steps.forEach(function(s,i){
      if(s.stage === lastStage) return;
      lastStage = s.stage;
      var t = add("text",{x:x(i), y:H-padB+16, "text-anchor":"start", transform:"rotate(28 "+x(i)+" "+(H-padB+16)+")"});
      t.textContent = s.stage;
    });
    return svg;
  }

  // ---------------- capabilities
  var caps = DATA.capabilities || [];
  var MAT = ["None","Foundational","Operational","Optimised","Transformational"];
  var capTree = $("#cap-tree");
  if(capTree){
    var kids = {};
    caps.forEach(function(c){ var p = c.parentId || "__root"; (kids[p] = kids[p] || []).push(c); });
    (function build(parent, host){
      (kids[parent]||[]).forEach(function(c){
        var li = el("li");
        var node = el("div","node");
        node.appendChild(el("span","lvl","L"+(c.level||1)));
        node.appendChild(el("strong", null, c.name || c.id));
        if(c.currentMaturity || c.targetMaturity){
          var cur = MAT.indexOf(c.currentMaturity), tgt = MAT.indexOf(c.targetMaturity);
          var bar = el("div","bar");
          var fill = el("span"); fill.style.width = Math.max(0,(tgt<0?0:tgt))/4*100 + "%";
          bar.appendChild(fill); bar.title = (c.currentMaturity||"?") + " → " + (c.targetMaturity||"?");
          node.appendChild(bar);
          node.appendChild(el("span","tag", (c.currentMaturity||"?") + " \\u2192 " + (c.targetMaturity||"?")));
          if(cur>=0 && tgt>cur) node.appendChild(el("span","tag","gap " + (tgt-cur)));
        }
        li.appendChild(node);
        if(c.description){ var d = el("div"); d.style.cssText="color:var(--muted);font-size:.85rem;margin:0 0 .2rem 2.2rem"; d.textContent=c.description; li.appendChild(d); }
        if(kids[c.id]){ var ul = el("ul"); build(c.id, ul); li.appendChild(ul); }
        host.appendChild(li);
      });
    })("__root", capTree);
    if(!caps.length) capTree.appendChild(el("div","empty","No capability map generated for this feature yet."));
  }

  // ---------------- process model
  var acts = DATA.activities || [];
  var phaseSel = $("#p-phase"), actorSel = $("#p-actor");
  if(phaseSel){
    var phases = [], actors = [];
    acts.forEach(function(a){
      if(a.l1 && phases.indexOf(a.l1)<0) phases.push(a.l1);
      if(a.actor && actors.indexOf(a.actor)<0) actors.push(a.actor);
    });
    function fill(sel, vals){
      sel.appendChild(el("option", null, "All")).value = "";
      vals.forEach(function(v){ var o = el("option", null, v); o.value = v; sel.appendChild(o); });
    }
    fill(phaseSel, phases); fill(actorSel, actors);
    phaseSel.addEventListener("change", drawProcess);
    actorSel.addEventListener("change", drawProcess);
    drawProcess();
  }
  function drawProcess(){
    var host = $("#proc-body"); host.innerHTML = "";
    var p = phaseSel.value, ac = actorSel.value;
    var rows = acts.filter(function(a){ return (!p || a.l1===p) && (!ac || a.actor===ac); });
    if(!rows.length){ host.appendChild(el("div","empty","No activities match these filters.")); return; }
    var byPhase = {};
    rows.forEach(function(a){ (byPhase[a.l1] = byPhase[a.l1] || []).push(a); });
    Object.keys(byPhase).forEach(function(ph){
      var wrap = el("div","j-stage");
      wrap.appendChild(el("h4", null, ph + "  ·  " + byPhase[ph].length + " activities"));
      var t = el("table");
      t.innerHTML = "<thead><tr><th>Step</th><th>Activity</th><th>Actor</th><th>Tier</th></tr></thead>";
      var tb = el("tbody");
      byPhase[ph].forEach(function(a){
        var tr = el("tr");
        [a.l2, a.l3, a.actor, a.serviceTier].forEach(function(v){ tr.appendChild(el("td", null, v || "—")); });
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      var tw = scrollTable(t, "Process activities for " + ph);
      wrap.appendChild(tw);
      host.appendChild(wrap);
    });
  }

  // ---------------- stories
  var storyHost = $("#story-list");
  if(storyHost){
    (DATA.stories||[]).forEach(function(s){
      var b = el("div","box"); b.style.marginBottom = ".7rem";
      b.appendChild(el("strong", null, s.summary || ""));
      if(s.description){ var d = el("p"); d.style.whiteSpace = "pre-wrap"; d.textContent = s.description; b.appendChild(d); }
      (s.labels||[]).forEach(function(l){ b.appendChild(el("span","tag", l)); });
      storyHost.appendChild(b);
    });
    if(!(DATA.stories||[]).length) storyHost.appendChild(el("div","empty","No stories generated for this feature yet."));
  }

  // ---------------- search (highlights within the visible panel)
  var q = $("#q");
  var timer = null;
  q.addEventListener("input", function(){
    clearTimeout(timer);
    timer = setTimeout(function(){ runSearch(q.value.trim()); }, 160);
  });
  function clearMarks(root){
    $$("mark", root).forEach(function(m){
      var t = document.createTextNode(m.textContent);
      m.parentNode.replaceChild(t, m);
    });
    root.normalize();
  }
  function runSearch(term){
    var panel = $$(".panel").filter(function(p){ return !p.hidden; })[0];
    if(!panel) return;
    clearMarks(panel);
    if(term.length < 2) return;
    var rx = new RegExp("(" + term.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&") + ")", "gi");
    var walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n){
        if(!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentNode.nodeName;
        if(p === "SCRIPT" || p === "STYLE" || p === "MARK") return NodeFilter.FILTER_REJECT;
        return rx.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var hits = [];
    while(walker.nextNode()) hits.push(walker.currentNode);
    hits.forEach(function(n){
      var span = document.createElement("span");
      span.innerHTML = n.nodeValue.replace(/[&<>]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }).replace(rx, "<mark>$1</mark>");
      n.parentNode.replaceChild(span, n);
    });
    if(hits.length){ var first = $("mark", panel); if(first) first.scrollIntoView({block:"center", behavior:"smooth"}); }
  }

  // ---------------- theme + print
  var themeBtn = $("#theme");
  function applyTheme(t){
    if(t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
    var dark = t === "dark" || (!t && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    themeBtn.textContent = dark ? "Light" : "Dark";
    themeBtn.setAttribute("aria-pressed", dark ? "true" : "false");
  }
  themeBtn.addEventListener("click", function(){
    var cur = document.documentElement.getAttribute("data-theme");
    var dark = cur === "dark" || (!cur && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    applyTheme(dark ? "light" : "dark");
  });
  applyTheme(null);
  $("#printer").addEventListener("click", function(){ window.print(); });

  navLinks.forEach(function(a){ a.addEventListener("click", function(){ setTimeout(function(){ show(a.getAttribute("data-nav"), false); }, 0); }); });
  fromHash();
})();
</script>
</body>
</html>`;
}

// ------------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((x) => x.startsWith("--")));
  const [project, ...rest] = argv.filter((x) => !x.startsWith("--"));
  const feature = rest.join(" ");
  for (const f of flags) if (!["--no-diagrams", "--open"].includes(f)) die(`unknown flag ${f}`);

  if (!project || !feature) {
    console.error("Usage: node scripts/render-companion-app.mjs <project> <feature> [--no-diagrams]");
    process.exit(1);
  }
  if (!SAFE_NAME.test(project) || !SAFE_NAME.test(feature)) die("project/feature contain unexpected characters");

  const featureRoot = path.join(WORKSPACE, "projects", project, feature);
  try { await fs.access(featureRoot); } catch { die(`no such feature: projects/${project}/${feature}`); }

  const a = await loadArtefacts(featureRoot);
  const theme = await loadTheme(featureRoot);

  const present = [
    a.personas.length && `${a.personas.length} personas`,
    a.journeys.length && `${a.journeys.length} journeys`,
    a.capabilities.length && `${a.capabilities.length} capabilities`,
    a.activities.length && `${a.activities.length} activities`,
    a.stories.length && `${a.stories.length} stories`,
    a.productSummary && "product summary",
    a.dataModel && "data model",
    a.solutionDesign && "solution design",
    a.solutionArchitecture && "architecture",
    a.testCases && "test cases",
    a.gaps && "gaps",
  ].filter(Boolean);

  if (present.length === 0) {
    die(`nothing to render for ${project}/${feature} — no artefacts found.\n` +
        `  Run at least one stage (requirements, personas, capability map, …) first.`);
  }

  const docs = [a.productSummary, a.dataModel, a.solutionDesign, a.solutionArchitecture, a.testCases, a.gaps, a.storiesMd];
  const mermaid = collectMermaid(docs);
  if (mermaid.size) console.log(`[render-companion-app] rendering ${mermaid.size} diagram(s)…`);
  const diagrams = await renderDiagrams(mermaid, { skip: flags.has("--no-diagrams") });

  const docHtml = {
    productSummary: a.productSummary ? mdToHtml(a.productSummary, diagrams) : null,
    dataModel: a.dataModel ? mdToHtml(a.dataModel, diagrams) : null,
    solutionDesign: a.solutionDesign ? mdToHtml(a.solutionDesign, diagrams) : null,
    solutionArchitecture: a.solutionArchitecture ? mdToHtml(a.solutionArchitecture, diagrams) : null,
    testCases: a.testCases ? mdToHtml(a.testCases, diagrams) : null,
    gaps: a.gaps ? mdToHtml(a.gaps, diagrams) : null,
  };

  const generatedOn = new Date().toISOString().slice(0, 10);
  const html = page({ project, feature, generatedOn, a, docHtml, theme });

  const key = `${project}-${feature}`;
  const appDir = path.join(WORKSPACE, "generated-apps", key);
  await fs.mkdir(appDir, { recursive: true });
  const htmlPath = path.join(appDir, "index.html");
  await fs.writeFile(htmlPath, html, "utf8");

  // Registry entry. Keeps `devUrl` so the chatbot's preview pane and
  // scripts/audit-a11y.mjs keep working unchanged — it now points at the route
  // that serves this file rather than at a dev server.
  const registryPath = path.join(WORKSPACE, "generated-apps", "registry.json");
  let registry = {};
  try { registry = JSON.parse(await fs.readFile(registryPath, "utf8")); } catch {}
  const prev = registry[key] || {};
  registry[key] = {
    appPath: path.relative(WORKSPACE, appDir),
    htmlPath: path.relative(WORKSPACE, htmlPath),
    kind: "static-html",
    devUrl: `${PREVIEW_ORIGIN}/api/companion-app/${encodeURIComponent(project)}/${encodeURIComponent(feature)}`,
    // Preserved across renders — the Developer sets these when it pushes.
    branch: prev.branch ?? null,
    repoUrl: prev.repoUrl ?? null,
    generatedAt: new Date().toISOString(),
    artefacts: present,
    diagrams: diagrams.size,
    bytes: Buffer.byteLength(html),
  };
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");

  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`[render-companion-app] ${project}/${feature} → ${path.relative(WORKSPACE, htmlPath)} (${kb} KB, ${diagrams.size} inline diagram(s))`);
  console.log(`  includes: ${present.join(", ")}`);
  console.log(JSON.stringify(registry[key], null, 2));
}

main().catch((e) => die(e.stack || String(e)));
