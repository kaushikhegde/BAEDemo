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

/**
 * A picture for a persona or a journey, inlined as a data URI.
 *
 * The reference app ships hand-drawn PNGs per persona. Our features rarely have
 * them, so a picture is OPTIONAL: drop one in and the page uses it exactly like
 * the reference, leave it out and the page draws the journey from the data
 * instead. Inlined rather than linked because the page makes zero requests.
 */
const IMG_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };
const MAX_IMG_BYTES = 4_000_000;
async function readDataUri(dir, base) {
  for (const ext of Object.keys(IMG_MIME)) {
    const file = path.join(dir, base + ext);
    try {
      const buf = await fs.readFile(file);
      if (buf.length > MAX_IMG_BYTES) {
        console.warn(`[render-companion-app] skipped ${path.basename(file)} — ${(buf.length / 1e6).toFixed(1)} MB exceeds the ${MAX_IMG_BYTES / 1e6} MB inline limit`);
        continue;
      }
      return `data:${IMG_MIME[ext]};base64,${buf.toString("base64")}`;
    } catch { /* next extension */ }
  }
  return null;
}

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

    // The accent carries the small uppercase section eyebrow, which is text —
    // so it needs the same treatment. A raw accent is chosen to sit BESIDE
    // text, not to be text, and a mid-tone one lands around 3.5:1.
    if (out.vars["--accent"]) {
      out.lightVars["--accent-fg"] = brandTextColor(out.vars["--accent"], LIGHT_SURFACE);
      out.darkVars["--accent-fg"] = brandTextColor(out.vars["--accent"], DARK_SURFACE);
    }

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

/**
 * Optional artwork, keyed by persona id:
 *   design/personas/<id>.png        -> the round avatar on the persona card
 *   design/journeys/<id>-journey.png -> the full journey diagram
 * Anything absent simply falls back to what the page draws itself.
 */
async function loadImages(featureRoot, personas) {
  const personaDir = path.join(featureRoot, "design", "personas");
  const journeyDir = path.join(featureRoot, "design", "journeys");
  const out = {};
  let found = 0;
  for (const p of personas) {
    if (!p?.id) continue;
    const [avatar, journey] = await Promise.all([
      readDataUri(personaDir, p.id),
      readDataUri(journeyDir, `${p.id}-journey`),
    ]);
    if (avatar || journey) { out[p.id] = { avatar, journey }; found++; }
  }
  if (found) console.log(`[render-companion-app] artwork: ${found} persona(s) with a supplied image`);
  return out;
}

// ------------------------------------------------------------------ page

function page({ project, feature, generatedOn, a, docHtml, theme }) {
  const title = `${feature} — Companion App`;

  // Personas leads and is the default view. Journeys is NOT a top-level tab —
  // it is a sub-tab inside Personas, matching the reference app. There is no
  // Overview, Stories or Gaps tab.
  const sections = [];
  const push = (id, label, count) => sections.push({ id, label, count });
  if (a.personas.length) push("personas", "Personas", a.personas.length);
  if (a.capabilities.length) push("capabilities", "Capabilities", a.capabilities.length);
  if (a.activities.length) push("process", "Process", a.activities.length);
  if (a.productSummary) push("summary", "Product Summary", null);
  if (a.dataModel) push("datamodel", "Data Model", null);
  if (a.solutionDesign) push("design", "Solution Design", null);
  if (a.solutionArchitecture) push("architecture", "Architecture", null);
  if (a.testCases) push("testcases", "Test Cases", null);
  // A feature with nothing at all still needs one landing panel.
  if (!sections.length) push("empty", "Nothing generated yet", null);
  const DEFAULT_SECTION = sections[0].id;

  const data = jsonIsland({
    project, feature,
    personas: a.personas, journeys: a.journeys,
    capabilities: a.capabilities, activities: a.activities,
    images: a.images || {},
    defaultSection: DEFAULT_SECTION,
  });

  // Horizontal perspective nav with a sliding underline — the house design
  // system's shell, matching the capability map page.
  const nav = sections.map((s) =>
    `<a class="pbtn" href="#/${s.id}" data-nav="${s.id}" role="tab" aria-selected="false" tabindex="-1">` +
    `<span class="lbl">${esc(s.label)}</span>${s.count != null ? `<span class="badge tnum">${s.count}</span>` : ""}</a>`
  ).join("");

  // The eyebrow reads as the document's subject trail, like the reference's
  // "CAPABILITIES · PROCESS · COVERAGE".
  const eyebrowTrail = sections.slice(0, 4)
    .map((s) => s.label).join(" · ") || "Solution guide";

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
  --accent-fg:#94654e;
  --today-bg:#fdf2f2; --today-line:#f3d0cd; --today-dot:#c0392b; --today-lbl:#992d20;
  --tmrw-bg:#f0faf5; --tmrw-line:#bfe5d3; --tmrw-dot:#1a7f5a; --tmrw-lbl:#186748;
  --radius:12px; --maxw:100%; --pad:2rem;
  --shadow:0 1px 2px rgba(20,24,40,.06),0 8px 24px rgba(20,24,40,.06);
}
:root[data-theme="dark"]{
  --ink:#e8eaf2; --muted:#a2abc2; --line:#2c3242; --bg:#12151d; --panel:#181c26;
  --brand:#9aa6e0; --brand-deep:#c3cbf0; --accent:#d79a76;
  --sel-bg:#9aa6e0; --sel-fg:#12151d;
  --ok:#5cc292; --warn:#e0a35c; --bad:#e8796a;
  --accent-fg:#d79a76;
  --today-bg:#241a1c; --today-line:#432b2e; --today-dot:#eb8b80; --today-lbl:#f0a49b;
  --tmrw-bg:#12221d; --tmrw-line:#25453a; --tmrw-dot:#5cc292; --tmrw-lbl:#7ed3ab;
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
/* ---------- header (house design system — matches the capability map page) ---------- */
header.top{
  background:var(--panel);border-bottom:1px solid var(--line);
  position:sticky;top:0;z-index:30;flex-shrink:0;
  transition:background-color .2s ease,border-color .2s ease;
}
.top-row{height:4rem;display:flex;align-items:center;gap:1rem;padding:0 var(--pad);max-width:var(--maxw);margin:0 auto}
.brandmark{display:flex;align-items:center;gap:.75rem;min-width:0}
.logo-img{height:2.5rem;width:auto;display:block;border-radius:.375rem}
/* Client logos are drawn for a light background. On a dark surface give the
   artwork its own light plate rather than filtering it, which would destroy the
   brand colours inside the mark. */
:root[data-theme="dark"] .logo-img{background:#fff;padding:.25rem .375rem}
.logo-text{font-weight:800;font-size:1.05rem;color:var(--brand-fg,var(--brand-deep));letter-spacing:.02em}
.rule{height:2rem;width:1px;background:var(--line);flex-shrink:0}
.titles{min-width:0}
.titles h1{margin:0;font-size:1.25rem;font-weight:700;color:var(--brand-fg,var(--brand-deep));line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.eyebrow-sm{font-size:.625rem;text-transform:uppercase;letter-spacing:.2em;font-weight:700;color:var(--muted);margin-top:.25rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.count-pill{
  display:inline-flex;align-items:center;gap:.375rem;flex-shrink:0;
  padding:.15rem .625rem;border-radius:999px;font-size:.75rem;font-weight:700;
  background:var(--panel);border:1px solid var(--line);color:var(--brand-fg,var(--brand-deep));
}
.dot-pulse{width:.375rem;height:.375rem;border-radius:999px;background:var(--accent-fg,var(--accent));animation:pulse 2s cubic-bezier(.4,0,.6,1) infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@media (prefers-reduced-motion: reduce){.dot-pulse{animation:none}}
.spacer{flex:1}
.iconbtn,.btn{
  display:inline-flex;align-items:center;gap:.5rem;padding:.375rem .75rem;border-radius:var(--radius);
  background:transparent;border:1px solid var(--line);color:var(--muted);cursor:pointer;
  font:inherit;font-size:.8rem;font-weight:600;transition:color .15s ease,background-color .15s ease,border-color .15s ease;
}
.iconbtn:hover,.btn:hover{color:var(--brand-fg,var(--brand-deep));background:var(--bg);border-color:var(--brand)}
.iconbtn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.search{
  border:1px solid var(--line);background:var(--bg);color:var(--ink);
  padding:.45rem .7rem;border-radius:var(--radius);min-width:min(280px,34vw);font-size:.85rem;
}
/* perspective nav — sliding underline stands in for the reference's layoutId */
nav.perspectives{display:flex;align-items:center;gap:2rem;padding:0 var(--pad);position:relative;overflow-x:auto;scrollbar-width:none;max-width:var(--maxw);margin:0 auto}
nav.perspectives::-webkit-scrollbar{display:none}
.pbtn{position:relative;padding:.5rem 0 .625rem;background:none;border:0;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:.5rem;text-decoration:none}
.pbtn .lbl{font-size:.875rem;font-weight:700;letter-spacing:-.01em;color:var(--muted);transition:color .15s ease}
.pbtn:hover .lbl{color:var(--ink)}
.pbtn[aria-selected="true"] .lbl{color:var(--brand-fg,var(--brand-deep))}
.pbtn .badge{font-size:.625rem;font-weight:700;padding:.05rem .375rem;border-radius:999px;background:var(--bg);border:1px solid var(--line);color:var(--muted)}
.pbtn[aria-selected="true"] .badge{border-color:var(--brand);color:var(--brand-fg,var(--brand-deep))}
#underline{position:absolute;bottom:0;height:2px;background:var(--brand-fg,var(--brand-deep));border-radius:999px;transition:transform .28s cubic-bezier(.17,.89,.32,1.06),width .28s cubic-bezier(.17,.89,.32,1.06);transform-origin:left;width:0}
@media (prefers-reduced-motion: reduce){#underline{transition:none}}
.wrap{max-width:var(--maxw);margin:0 auto;padding:1.75rem var(--pad) 2.5rem}
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

/* ---------- section heading (eyebrow + lede) ---------- */
.sec-head{margin:.2rem 0 1.75rem;max-width:60ch}
.eyebrow{display:flex;align-items:center;gap:.6rem;font-size:.7rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent-fg,var(--accent));margin-bottom:.75rem}
.eyebrow::before{content:"";width:2rem;height:2px;background:var(--accent-fg,var(--accent));flex:none}
.sec-head .panel-h{margin:0 0 .6rem;font-size:1.9rem;line-height:1.2;letter-spacing:-.01em}
.lede{margin:0;color:var(--muted);font-size:1rem;line-height:1.55}

/* ---------- persona cards (Today / Tomorrow / Key benefit) ---------- */
.pgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.25rem}
@media (max-width:900px){.pgrid{grid-template-columns:1fr}}
.pcard{border:1px solid var(--line);border-radius:var(--radius);background:var(--bg);box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden}
.pcard-h{display:flex;gap:.9rem;align-items:flex-start;padding:1.15rem 1.25rem}
.pavatar{flex:none;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:.95rem;background:var(--pc,var(--brand));color:var(--pcfg,#fff);box-shadow:0 0 0 3px var(--bg),0 0 0 5px var(--pc,var(--brand))}
.pcard-h h3{margin:0;font-size:1.15rem;color:var(--brand-fg,var(--brand-deep))}
.prole{font-size:.9rem;color:var(--ink);margin-top:.1rem}
.pctx{margin:.4rem 0 0;font-size:.85rem;font-style:italic;color:var(--muted);line-height:1.5}
.pcard-b{display:grid;grid-template-columns:1fr 1fr;gap:.85rem;padding:0 1.25rem 1.15rem;border-top:1px solid var(--line);padding-top:1.15rem}
@media (max-width:560px){.pcard-b{grid-template-columns:1fr}}
.ppanel{border-radius:10px;padding:.85rem .9rem}
.ppanel h4{margin:0 0 .6rem;font-size:.68rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.ppanel ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:.5rem}
.ppanel li{position:relative;padding-left:.95rem;font-size:.82rem;line-height:1.45}
.ppanel li::before{content:"";position:absolute;left:0;top:.45em;width:6px;height:6px;border-radius:50%}
.p-today{background:var(--today-bg);border:1px solid var(--today-line)}
.p-today h4{color:var(--today-lbl)}
.p-today li::before{background:var(--today-dot)}
.p-tmrw{background:var(--tmrw-bg);border:1px solid var(--tmrw-line)}
.p-tmrw h4{color:var(--tmrw-lbl)}
.p-tmrw li::before{background:var(--tmrw-dot)}
.pcard-f{margin-top:auto;border-top:1px solid var(--line);padding:1rem 1.25rem 1.15rem;display:flex;flex-wrap:wrap;gap:.75rem;align-items:flex-end;justify-content:space-between}
.klabel{font-size:.68rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.kval{margin:.35rem 0 0;font-weight:700;font-size:.95rem;color:var(--brand-fg,var(--brand-deep));line-height:1.4}


/* ---------- supplied artwork (persona avatar + journey diagram) ---------- */
.pavatar-img{padding:0;overflow:hidden;background:var(--pc,var(--brand))}
.pavatar-img img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}
.jfig{margin:0}
.jimg{width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:var(--radius);cursor:zoom-in;background:#fff}
.jimg:focus-visible{outline:3px solid var(--brand);outline-offset:2px}
.jfig figcaption{margin-top:.6rem;text-align:center;font-size:.75rem;font-style:italic;color:var(--muted)}
.lightbox{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.85);display:grid;place-items:center;padding:2rem}
.lightbox[hidden]{display:none}
.lightbox img{max-width:100%;max-height:85vh;object-fit:contain;border-radius:var(--radius);background:#fff}
.lb-close{position:absolute;top:1rem;right:1.25rem;background:none;border:0;color:#fff;font-size:2.25rem;line-height:1;cursor:pointer;padding:.25rem .6rem}
.lb-close:hover{color:#cbd5e1}

/* ---------- capabilities: filter sidebar + L1 section -> L2 card -> L3 tile ---------- */
.cap-shell{display:grid;grid-template-columns:17rem minmax(0,1fr);gap:2rem;align-items:start}
@media (max-width:960px){.cap-shell{grid-template-columns:1fr}}
.cap-side{position:sticky;top:8.5rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--bg);padding:1.15rem}
@media (max-width:960px){.cap-side{position:static}}
.cap-side-h{display:flex;align-items:center;gap:.5rem;font-size:.9rem;font-weight:700;color:var(--brand-fg,var(--brand-deep));margin-bottom:1rem}
.cap-side-h svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round}
.cap-search{width:100%;min-width:0;margin-bottom:1.15rem}
.cap-facet h4{margin:0 0 .6rem;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
.cap-check{display:flex;align-items:flex-start;gap:.55rem;padding:.3rem 0;font-size:.82rem;line-height:1.4;cursor:pointer;color:var(--ink)}
.cap-check input{margin-top:.2rem;flex:none;accent-color:var(--brand)}
.cap-clear{width:100%;margin-top:1.15rem;padding:.55rem;border:1px dashed var(--line);border-radius:var(--radius);background:transparent;color:var(--muted);font:inherit;font-size:.8rem;font-weight:600;cursor:pointer}
.cap-clear:hover{color:var(--brand-fg,var(--brand-deep));border-color:var(--brand)}
.cap-hint{margin:.85rem 0 0;font-size:.72rem;color:var(--muted);line-height:1.5}
.cap-legend{display:flex;flex-wrap:wrap;align-items:center;gap:.85rem;margin-bottom:1.5rem;font-size:.72rem;color:var(--muted)}
.cap-legend-l{font-weight:700;text-transform:uppercase;letter-spacing:.1em;font-size:.65rem}
.cap-legend-i{display:inline-flex;align-items:center;gap:.35rem}
.cap-legend-i i{width:.5rem;height:.5rem;border-radius:50%;display:block}
.cap-sec{border:1px solid var(--line);border-radius:16px;background:var(--bg);padding:1.25rem;margin-bottom:1.25rem;transition:opacity .2s ease}
.cap-sec-h{display:flex;align-items:flex-start;gap:.85rem;margin-bottom:1.15rem}
.cap-sec-n{flex:none;display:grid;place-items:center;min-width:2rem;height:2rem;padding:0 .4rem;border-radius:9px;background:var(--sel-bg);color:var(--sel-fg);font-size:.75rem;font-weight:700}
.cap-sec-h h3{margin:0;font-size:1.05rem;font-weight:700;color:var(--brand-fg,var(--brand-deep))}
.cap-sec-d{margin:.3rem 0 0;font-size:.82rem;color:var(--muted);line-height:1.5}
.cap-sec-c{margin-left:auto;flex:none;font-size:.72rem;font-weight:600;color:var(--muted);white-space:nowrap}
.cap-areas{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}
@media (max-width:1100px){.cap-areas{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:700px){.cap-areas{grid-template-columns:1fr}}
.cap-area{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:.9rem;display:flex;flex-direction:column;gap:.75rem}
.cap-area-h{display:flex;align-items:baseline;gap:.5rem}
.cap-area-n{font-size:.68rem;font-weight:700;color:var(--muted);flex:none}
.cap-area-h h4{margin:0;font-size:.85rem;font-weight:700;line-height:1.35;color:var(--ink)}
.cap-tiles{display:flex;flex-direction:column;gap:.5rem}
.cap-tile{border:1px solid var(--line);border-radius:9px;background:var(--bg);padding:.6rem .7rem;display:flex;flex-direction:column;gap:.35rem;transition:opacity .2s ease}
.cap-tile.dim,.cap-sec.dim{opacity:.3}
.cap-tile-h{display:flex;align-items:baseline;gap:.4rem}
.cap-tile-n{font-size:.65rem;font-weight:700;color:var(--muted);flex:none}
.cap-tile-t{font-size:.8rem;font-weight:600;line-height:1.35;color:var(--ink)}
.mat-dots{display:inline-flex;align-items:center;gap:.3rem;font-size:.7rem;color:var(--muted)}
.mat-dot{width:.45rem;height:.45rem;border-radius:50%;display:block;flex:none}
.mat-arrow{color:var(--line)}
.mat-target{color:var(--ok);font-weight:600}
.cap-stage{font-size:.62rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}

/* ---------- process drill-down (phase -> step -> activity) ---------- */
.crumbs{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;margin-bottom:1.25rem;font-size:.85rem}
.crumb{background:none;border:0;padding:0;font:inherit;font-size:.85rem;color:var(--muted);cursor:pointer}
.crumb:hover{color:var(--brand-fg,var(--brand-deep));text-decoration:underline}
.crumb.on{color:var(--brand-fg,var(--brand-deep));font-weight:700;cursor:default;text-decoration:none}
.crumb-sep{color:var(--line)}
.backbtn{display:inline-flex;align-items:center;gap:.4rem;background:none;border:0;padding:0;margin-bottom:1.25rem;font:inherit;font-size:.78rem;font-weight:700;color:var(--muted);cursor:pointer}
.backbtn:hover{color:var(--brand-fg,var(--brand-deep))}
.phase-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}
.step-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
.act-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
@media (max-width:1000px){.phase-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:720px){.phase-grid,.step-grid,.act-grid{grid-template-columns:1fr}}
.phase-card,.step-card{
  text-align:left;background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:1.25rem;
  cursor:pointer;font:inherit;color:inherit;display:flex;flex-direction:column;gap:.75rem;
  transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease;
}
.phase-card:hover,.step-card:hover{border-color:var(--brand);box-shadow:var(--shadow);transform:translateY(-2px)}
@media (prefers-reduced-motion: reduce){.phase-card,.step-card{transition:none}.phase-card:hover,.step-card:hover{transform:none}}
.phase-top{display:flex;align-items:flex-start;justify-content:space-between}
.phase-ic{display:grid;place-items:center;width:2.75rem;height:2.75rem;border-radius:12px;background:var(--panel);color:var(--brand-fg,var(--brand-deep));transition:background-color .18s ease,color .18s ease}
.phase-ic svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.phase-card:hover .phase-ic{background:var(--sel-bg);color:var(--sel-fg)}
.phase-num,.step-num{font-size:.7rem;font-weight:700;color:var(--muted)}
.phase-card h3,.step-card h3{margin:0;font-size:1rem;font-weight:700;line-height:1.35;color:var(--brand-fg,var(--brand-deep))}
.phase-meta{display:flex;align-items:center;gap:.6rem;font-size:.78rem;color:var(--muted);font-weight:600}
.dot-sep{width:4px;height:4px;border-radius:50%;background:var(--line)}
.chev{margin-left:auto;color:var(--muted);font-size:1.1rem;line-height:1}
.act-card{background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:1.15rem 1.25rem;display:flex;flex-direction:column;gap:.65rem}
.act-card h3{margin:0;font-size:.95rem;font-weight:700;line-height:1.4;color:var(--brand-fg,var(--brand-deep))}
.act-desc{margin:0;font-size:.85rem;line-height:1.55;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:.35rem}
.chip{display:inline-block;font-size:.7rem;font-weight:600;padding:.15rem .5rem;border-radius:999px;background:var(--panel);border:1px solid var(--line);color:var(--muted)}
.chip-actor{background:var(--tmrw-bg);border-color:var(--tmrw-line);color:var(--tmrw-lbl)}
.chip-quiet{background:transparent}
.act-caps{display:flex;gap:.5rem;font-size:.75rem;color:var(--muted);border-top:1px solid var(--line);padding-top:.6rem}
.act-caps-l{font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:.65rem;flex:none}

/* ---------- persona sub-tabs (Overview | Journeys) ---------- */
.subtabs{display:flex;align-items:center;gap:1.5rem;border-bottom:1px solid var(--line);margin-bottom:1.75rem;padding:0 .25rem;position:relative}
.subtab{position:relative;display:flex;align-items:center;gap:.5rem;padding:.75rem .25rem;background:none;border:0;cursor:pointer;font:inherit}
.subtab svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;color:var(--muted);transition:color .15s ease}
.subtab span{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);transition:color .15s ease}
.subtab:hover svg,.subtab:hover span{color:var(--ink)}
.subtab[aria-selected="true"] svg{color:var(--accent-fg,var(--accent))}
.subtab[aria-selected="true"] span{color:var(--brand-fg,var(--brand-deep))}
#sub-underline{position:absolute;bottom:-1px;height:2px;background:var(--brand-fg,var(--brand-deep));border-radius:999px;transition:transform .28s cubic-bezier(.17,.89,.32,1.06),width .28s cubic-bezier(.17,.89,.32,1.06);transform-origin:left;width:0}
@media (prefers-reduced-motion: reduce){#sub-underline{transition:none}}

/* ---------- journey persona strip ---------- */
.jtabs{display:flex;flex-wrap:wrap;gap:.5rem;padding:.4rem;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);margin-bottom:1.5rem}
.jtab{flex:1 1 auto;min-width:9rem;border:1px solid transparent;border-radius:9px;background:transparent;padding:.6rem .9rem;cursor:pointer;font:inherit;color:var(--muted);text-align:center;line-height:1.3}
.jtab .jt-name{display:block;font-weight:700;font-size:.95rem;color:var(--ink)}
.jtab .jt-role{display:block;font-size:.68rem;letter-spacing:.09em;text-transform:uppercase;margin-top:.15rem}
.jtab[aria-selected="true"]{background:var(--bg);border-color:var(--line);box-shadow:var(--shadow)}
.jtab[aria-selected="true"] .jt-name{color:var(--brand-fg,var(--brand-deep))}
.callout{margin-top:1.75rem;border-left:4px solid var(--brand);background:var(--panel);border-radius:0 var(--radius) var(--radius) 0;padding:1.15rem 1.35rem}
.callout h4{margin:0 0 .5rem;font-size:1rem;color:var(--brand-fg,var(--brand-deep))}
.callout p{margin:0;color:var(--muted);line-height:1.6;font-size:.9rem}
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
footer{max-width:var(--maxw);margin:0 auto;padding:2rem var(--pad);color:var(--muted);font-size:.8rem;border-top:1px solid var(--line)}
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
  // The page defaults to LIGHT. Dark is opt-in through the toggle, which sets
  // data-theme="dark" — the system preference is deliberately not consulted, so
  // the document looks the same for everyone who opens it.
  if (Object.keys(theme.lightVars).length) out.push(`:root,:root[data-theme="light"]{${decl(theme.lightVars)}}`);
  if (Object.keys(theme.darkVars).length) out.push(`:root[data-theme="dark"]{${decl(theme.darkVars)}}`);
  return out.join("\n");
})()}
.brand-logo{height:26px;width:auto;max-width:170px;display:block;flex:0 0 auto}
.brand-lock{display:flex;align-items:center;gap:.55rem;min-width:0}
/* ---------- full-bleed: wide screens gain columns, not wider cards ---------- */
@media (min-width:1500px){
  :root{--pad:2.5rem}
  .pgrid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .cap-areas{grid-template-columns:repeat(4,minmax(0,1fr))}
  .phase-grid{grid-template-columns:repeat(4,minmax(0,1fr))}
  .act-grid,.step-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media (min-width:2100px){
  :root{--pad:3rem}
  .pgrid{grid-template-columns:repeat(4,minmax(0,1fr))}
  .cap-areas{grid-template-columns:repeat(5,minmax(0,1fr))}
  .phase-grid{grid-template-columns:repeat(5,minmax(0,1fr))}
}
/* Documents run the full width like every other page. Tables and diagrams
   inside them still scroll in their own container rather than pushing the
   page sideways. */
.doc{max-width:none}
.doc .scroller,.doc figure,.doc table,.doc pre{max-width:none}
.doc img{max-width:100%;height:auto}

</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="top-row">
    <div class="brandmark">
      ${theme.logoSrc ? `<img class="logo-img" src="${theme.logoSrc}" alt=""/>` : `<span class="logo-text">${esc(theme.logoText)}</span>`}
      <div class="rule" aria-hidden="true"></div>
      <div class="titles">
        <h1>${esc(feature)}</h1>
        <div class="eyebrow-sm">${esc(eyebrowTrail)}</div>
      </div>
    </div>
    <span class="count-pill tnum"><i class="dot-pulse" aria-hidden="true"></i><span>${esc(project)} / ${esc(feature)}</span></span>
    <span class="spacer"></span>
    <label class="visually-hidden" for="q" style="position:absolute;left:-9999px">Search this page</label>
    <input id="q" class="search" type="search" placeholder="Search personas, steps, capabilities…" autocomplete="off"/>
    <button class="iconbtn" id="theme" type="button" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg><span>Dark</span>
    </button>
    <button class="iconbtn" id="printer" type="button">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/></svg><span>Print</span>
    </button>
  </div>
  <nav class="perspectives" role="tablist" aria-label="Sections">${nav}<span id="underline" aria-hidden="true"></span></nav>
</header>

<div class="wrap">
  <main id="main" tabindex="-1">
    <section class="panel" id="panel-personas" role="tabpanel" aria-labelledby="tab-personas" hidden>
      <div class="subtabs" role="tablist" aria-label="Persona views">
        <button class="subtab" type="button" role="tab" id="sub-overview" aria-controls="sub-panel-overview" aria-selected="true" data-sub="overview">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          <span>Overview</span>
        </button>
        <button class="subtab" type="button" role="tab" id="sub-journeys" aria-controls="sub-panel-journeys" aria-selected="false" data-sub="journeys" tabindex="-1">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 20l-6-3V4l6 3m0 13l6-3m-6 3V7m6 10l6 3V7l-6-3m0 13V4"/></svg>
          <span>Journeys</span>
        </button>
        <span id="sub-underline" aria-hidden="true"></span>
      </div>

      <div id="sub-panel-overview" role="tabpanel" aria-labelledby="sub-overview">
        <div class="sec-head">
          <div class="eyebrow">Who we serve</div>
          <h2 class="panel-h" id="persona-head">Representative participants, in detail.</h2>
          <p class="lede">Each persona stands for a category of actors with similar journeys. Every persona and every pain point below is traced to a source document.</p>
        </div>
        <div class="pgrid" id="persona-cards"></div>
        <div class="callout" id="persona-note" hidden></div>
      </div>

      <div id="sub-panel-journeys" role="tabpanel" aria-labelledby="sub-journeys" hidden>
        <div class="sec-head">
          <div class="eyebrow">Persona journeys</div>
          <h2 class="panel-h">Today vs tomorrow &mdash; every step.</h2>
          <p class="lede">How the target state changes each persona's experience across the full lifecycle, stage by stage.</p>
        </div>
        <div class="jtabs" role="tablist" aria-label="Journeys by persona" id="j-tabs"></div>
        <div id="journey-body"></div>
        <div class="callout" id="journey-note" hidden></div>
      </div>
    </section>

    <section class="panel" id="panel-capabilities" role="tabpanel" aria-labelledby="tab-capabilities" hidden>
      <div class="cap-shell">
        <aside class="cap-side" aria-label="Capability filters">
          <div class="cap-side-h">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
            <span>Filters</span>
          </div>
          <label class="visually-hidden" for="capq" style="position:absolute;left:-9999px">Search capabilities</label>
          <input id="capq" class="search cap-search" type="search" placeholder="Search capabilities…" autocomplete="off"/>
          <div class="cap-facet">
            <h4>Domain</h4>
            <div id="cap-domains"></div>
          </div>
          <button class="cap-clear" id="cap-clear" type="button">Clear all filters</button>
          <p class="cap-hint">Non-matching rows dim rather than disappear.</p>
        </aside>
        <div class="cap-main">
          <div class="sec-head">
            <div class="eyebrow">Business capability map</div>
            <h2 class="panel-h">Capabilities</h2>
            <p class="lede">Current and target maturity for every capability, grouped by domain.</p>
          </div>
          <div class="cap-legend" id="cap-legend"></div>
          <div id="cap-canvas"></div>
        </div>
      </div>
    </section>

    <section class="panel" id="panel-process" role="tabpanel" aria-labelledby="tab-process" hidden>
      <div id="proc-body"></div>
    </section>

    ${docPanel("summary", "Product Summary", docHtml.productSummary)}
    ${docPanel("datamodel", a.dataModelKind || "Data Model", docHtml.dataModel)}
    ${docPanel("design", "Solution Design", docHtml.solutionDesign)}
    ${docPanel("architecture", "Solution Architecture", docHtml.solutionArchitecture)}
    ${docPanel("testcases", "Test Cases", docHtml.testCases)}
  </main>
</div>

<div class="lightbox" id="lightbox" hidden role="dialog" aria-modal="true" aria-label="Journey diagram">
  <button class="lb-close" id="lb-close" type="button" aria-label="Close">&times;</button>
  <img id="lb-img" alt=""/>
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
    if(!document.getElementById("panel-"+id)) id = DEFAULT;
    $$(".panel").forEach(function(p){ p.hidden = (p.id !== "panel-"+id); });
    navLinks.forEach(function(a){
      var on = a.getAttribute("data-nav") === id;
      a.setAttribute("aria-selected", on ? "true" : "false");
      a.tabIndex = on ? 0 : -1;
    });
    moveUnderline();
    if(id === "personas" && typeof moveSubUnderline === "function") moveSubUnderline();
    if(focusMain){ $("#main").focus(); }
  }
  // Sliding underline under the selected tab — the reference's shared-element
  // transition, done with a transform so it animates on the compositor.
  function moveUnderline(){
    var u = $("#underline"); if(!u) return;
    var on = navLinks.filter(function(a){ return a.getAttribute("aria-selected") === "true"; })[0];
    if(!on){ u.style.width = "0px"; return; }
    u.style.width = on.offsetWidth + "px";
    u.style.transform = "translateX(" + on.offsetLeft + "px)";
  }
  window.addEventListener("resize", function(){ moveUnderline(); moveSubUnderline(); });
  function fromHash(){ var m = /^#\\/(.+)$/.exec(location.hash || ""); show(m ? m[1] : DEFAULT, false); }
  window.addEventListener("hashchange", fromHash);

  // Roving tabindex so arrow keys move between sections, per WAI-ARIA tabs.
  $("nav.perspectives").addEventListener("keydown", function(e){
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
  var DEFAULT = DATA.defaultSection || "personas";

  // ---------------- persona sub-tabs (Overview | Journeys)
  var subBtns = $$(".subtab");
  function showSub(which){
    subBtns.forEach(function(b){
      var on = b.dataset.sub === which;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      var panel = document.getElementById("sub-panel-" + b.dataset.sub);
      if(panel) panel.hidden = !on;
    });
    moveSubUnderline();
  }
  function moveSubUnderline(){
    var u = $("#sub-underline"); if(!u) return;
    var on = subBtns.filter(function(b){ return b.getAttribute("aria-selected") === "true"; })[0];
    if(!on){ u.style.width = "0px"; return; }
    u.style.width = on.offsetWidth + "px";
    u.style.transform = "translateX(" + on.offsetLeft + "px)";
  }
  subBtns.forEach(function(b){ b.addEventListener("click", function(){ showSub(b.dataset.sub); }); });
  if(subBtns.length){
    $(".subtabs").addEventListener("keydown", function(e){
      var i = subBtns.indexOf(document.activeElement); if(i < 0) return;
      var next = null;
      if(e.key === "ArrowRight" || e.key === "ArrowDown") next = subBtns[(i+1) % subBtns.length];
      else if(e.key === "ArrowLeft" || e.key === "ArrowUp") next = subBtns[(i-1+subBtns.length) % subBtns.length];
      else if(e.key === "Home") next = subBtns[0];
      else if(e.key === "End") next = subBtns[subBtns.length-1];
      if(next){ e.preventDefault(); next.focus(); next.click(); }
    });
    showSub("overview");
  }

  var personas = DATA.personas || [];
  var COLOURS = {"bg-blue-900":"#1e3a8a","bg-amber-500":"#f59e0b","bg-teal-600":"#0d9488","bg-sky-400":"#38bdf8","bg-rose-600":"#e11d48","bg-violet-700":"#6d28d9","bg-emerald-600":"#059669"};
  function personaColour(p){ return COLOURS[p.avatarColor] || "#464e7e"; }

  // Avatar text is chosen against the persona colour so a client palette
  // cannot drive the initials below AA — same rule the nav selection uses.
  function readableOn(hex){
    var h = String(hex||"").replace("#","");
    if(h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    if(h.length !== 6) return "#ffffff";
    var f = function(v){ v = parseInt(v,16)/255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); };
    var L = .2126*f(h.slice(0,2)) + .7152*f(h.slice(2,4)) + .0722*f(h.slice(4,6));
    return (L + .05) / .05 > 4.5 ? "#12151d" : "#ffffff";
  }
  function initials(name){
    var parts = String(name||"?").trim().split(/\s+/).filter(Boolean);
    if(!parts.length) return "?";
    if(parts.length === 1) return parts[0].slice(0,1).toUpperCase();
    return (parts[0].slice(0,1) + parts[parts.length-1].slice(0,1)).toUpperCase();
  }
  var NUMWORD = ["No","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten"];

  var cards = $("#persona-cards");
  if(cards){
    var head = $("#persona-head");
    if(head) head.textContent = (NUMWORD[personas.length] || personas.length) +
      (personas.length === 1 ? " representative participant, in detail." : " representative participants, in detail.");

    personas.forEach(function(p){
      var colour = personaColour(p);
      var art = el("article","pcard");

      var h = el("div","pcard-h");
      var pic = (DATA.images || {})[p.id] || {};
      var av;
      if(pic.avatar){
        av = el("span","pavatar pavatar-img");
        av.style.setProperty("--pc", colour);
        var im = document.createElement("img");
        im.src = pic.avatar; im.alt = ""; im.loading = "lazy";
        av.appendChild(im);
      } else {
        av = el("span","pavatar", initials(p.name));
        av.style.setProperty("--pc", colour);
        av.style.setProperty("--pcfg", readableOn(colour));
      }
      av.setAttribute("aria-hidden","true");
      h.appendChild(av);
      var who = el("div");
      who.appendChild(el("h3", null, p.name || p.id));
      if(p.role) who.appendChild(el("div","prole", p.role));
      if(p.context) who.appendChild(el("p","pctx", p.context));
      h.appendChild(who);
      art.appendChild(h);

      var b = el("div","pcard-b");
      [["TODAY","p-today", p.today||[]], ["TOMORROW","p-tmrw", p.tomorrow||[]]].forEach(function(t){
        var box = el("div","ppanel " + t[1]);
        box.appendChild(el("h4", null, t[0]));
        var ul = el("ul");
        t[2].forEach(function(x){ ul.appendChild(el("li", null, x)); });
        if(!t[2].length) ul.appendChild(el("li", null, "Not recorded."));
        box.appendChild(ul);
        b.appendChild(box);
      });
      art.appendChild(b);

      var f = el("div","pcard-f");
      var kb = el("div");
      kb.appendChild(el("div","klabel","Key benefit"));
      kb.appendChild(el("p","kval", p.keyBenefit || "—"));
      f.appendChild(kb);
      var more = el("button","btn","Full detail");
      more.type = "button";
      more.setAttribute("aria-haspopup","dialog");
      more.addEventListener("click", function(){ openPersona(p); });
      f.appendChild(more);
      art.appendChild(f);

      cards.appendChild(art);
    });
    if(!personas.length) cards.appendChild(el("div","empty","No personas generated for this feature yet."));

    var note = $("#persona-note");
    if(note && personas.length){
      note.hidden = false;
      note.appendChild(el("h4", null, "These personas illustrate the platform's value at a human level."));
      note.appendChild(el("p", null,
        "Each stands for a category of actors with similar journeys rather than for one individual. " +
        "Open any persona for its journey summary and the source documents it was drawn from."));
    }
  }

  // Lightbox for a supplied journey diagram.
  function openLightbox(src, alt){
    var lb = $("#lightbox"); if(!lb) return;
    var im = $("#lb-img"); im.src = src; im.alt = alt || "";
    lb.hidden = false;
    document.body.style.overflow = "hidden";
    $("#lb-close").focus();
  }
  function closeLightbox(){
    var lb = $("#lightbox"); if(!lb) return;
    lb.hidden = true; document.body.style.overflow = "";
  }
  if($("#lightbox")){
    $("#lb-close").addEventListener("click", closeLightbox);
    $("#lightbox").addEventListener("click", function(e){ if(e.target.id === "lightbox") closeLightbox(); });
    document.addEventListener("keydown", function(e){ if(e.key === "Escape") closeLightbox(); });
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
      go.addEventListener("click", function(){ dlg.close(); showSub("journeys"); selectJourney(j.id); });
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
  var jtabs = $("#j-tabs");
  if(jtabs){
    if(!journeys.length){
      jtabs.hidden = true;
      $("#journey-body").appendChild(el("div","empty","No journeys generated for this feature yet."));
    }
    journeys.forEach(function(j, i){
      var t = el("button","jtab"); t.type = "button";
      t.setAttribute("role","tab");
      t.setAttribute("aria-selected", i === 0 ? "true" : "false");
      t.tabIndex = i === 0 ? 0 : -1;
      t.dataset.jid = j.id;
      t.appendChild(el("span","jt-name", personaName(j.personaId) || j.title || j.id));
      t.appendChild(el("span","jt-role", personaRole(j.personaId) || j.title || ""));
      t.addEventListener("click", function(){ selectJourney(j.id); });
      jtabs.appendChild(t);
    });
    // Roving tabindex, same keyboard contract as the main navigation.
    jtabs.addEventListener("keydown", function(e){
      var tabs = [].slice.call(jtabs.querySelectorAll(".jtab"));
      var i = tabs.indexOf(document.activeElement); if(i < 0) return;
      var next = null;
      if(e.key === "ArrowRight" || e.key === "ArrowDown") next = tabs[(i+1) % tabs.length];
      else if(e.key === "ArrowLeft" || e.key === "ArrowUp") next = tabs[(i-1+tabs.length) % tabs.length];
      else if(e.key === "Home") next = tabs[0];
      else if(e.key === "End") next = tabs[tabs.length-1];
      if(next){ e.preventDefault(); next.focus(); next.click(); }
    });
    if(journeys.length) selectJourney(journeys[0].id);
  }
  function selectJourney(id){
    [].slice.call(jtabs.querySelectorAll(".jtab")).forEach(function(t){
      var on = t.dataset.jid === id;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
    });
    drawJourney(id);
  }
  function personaOf(id){ return personas.filter(function(x){ return x.id === id; })[0]; }
  function personaName(id){ var p = personaOf(id); return p ? p.name : ""; }
  function personaRole(id){ var p = personaOf(id); return p ? p.role : ""; }

  function drawJourney(id){
    var j = journeys.filter(function(x){ return x.id === id; })[0];
    var host = $("#journey-body"); host.innerHTML = "";
    var jnote = $("#journey-note");
    if(jnote){ jnote.innerHTML = ""; jnote.hidden = true; }
    if(!j) return;
    if(j.scenario) host.appendChild(el("p", null, j.scenario));

    // The persona's own journey summary reads as the caption for the diagram.
    var jp = personaOf(j.personaId);
    if(jnote && jp && jp.journeySummary){
      jnote.hidden = false;
      jnote.appendChild(el("p", null, jp.journeySummary));
    }

    // A supplied diagram wins: it is the hand-drawn artefact the reference uses.
    var jart = (DATA.images || {})[j.personaId] || {};
    if(jart.journey){
      var fig0 = el("figure","diagram jfig");
      var big = document.createElement("img");
      big.src = jart.journey; big.alt = (personaName(j.personaId) || "Persona") + " journey diagram";
      big.className = "jimg";
      fig0.appendChild(big);
      var cap0 = el("figcaption", null, "Click image to view full resolution");
      fig0.appendChild(cap0);
      big.addEventListener("click", function(){ openLightbox(big.src, big.alt); });
      big.tabIndex = 0;
      big.addEventListener("keydown", function(e){ if(e.key === "Enter" || e.key === " "){ e.preventDefault(); openLightbox(big.src, big.alt); } });
      host.appendChild(fig0);
      return;
    }

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
  // ---------------- capabilities: L1 section -> L2 area card -> L3 tile.
  // Filters DIM non-matching rows to 30% rather than hiding them, so the shape
  // of the map never changes under the reader — the reference's behaviour.
  var caps = DATA.capabilities || [];
  var MAT = ["None","Foundational","Operational","Optimised","Transformational"];
  var MAT_COLOUR = { "None":"var(--line)", "Foundational":"var(--warn)", "Operational":"var(--brand)", "Optimised":"var(--ok)", "Transformational":"var(--ok)" };
  var capCanvas = $("#cap-canvas");
  if(capCanvas){
    var kids = {};
    caps.forEach(function(c){ var pid = c.parentId || "__root"; (kids[pid] = kids[pid] || []).push(c); });
    var roots = kids["__root"] || [];
    var F = { q: "", domains: [] };

    // legend
    var lg = $("#cap-legend");
    if(lg){
      lg.appendChild(el("span","cap-legend-l","Current maturity"));
      MAT.forEach(function(m){
        var s2 = el("span","cap-legend-i");
        var d = el("i"); d.style.background = MAT_COLOUR[m] || "var(--line)";
        s2.appendChild(d); s2.appendChild(el("span", null, m));
        lg.appendChild(s2);
      });
    }

    // domain facet
    var host = $("#cap-domains");
    roots.forEach(function(r){
      var id = "dom-" + r.id.replace(/[^A-Za-z0-9_-]/g,"");
      var row = el("label","cap-check");
      var cb = el("input"); cb.type = "checkbox"; cb.value = r.id; cb.id = id;
      cb.addEventListener("change", function(){
        F.domains = [].slice.call(host.querySelectorAll("input:checked")).map(function(x){ return x.value; });
        applyCapFilter();
      });
      row.setAttribute("for", id);
      row.appendChild(cb);
      row.appendChild(el("span", null, (r.id ? r.id + " " : "") + (r.name || "")));
      host.appendChild(row);
    });
    // NOTE: the name q is already taken by the page-wide search further down,
    // and the whole client script shares one function scope — reusing it made
    // this handler read the wrong input. Keep this name distinct.
    var capQ = $("#capq");
    if(capQ) capQ.addEventListener("input", function(){ F.q = capQ.value.trim().toLowerCase(); applyCapFilter(); });
    var clr = $("#cap-clear");
    if(clr) clr.addEventListener("click", function(){
      F.q = ""; F.domains = [];
      if(capQ) capQ.value = "";
      [].slice.call(host.querySelectorAll("input")).forEach(function(x){ x.checked = false; });
      applyCapFilter();
    });

    function dots(c){
      var wrap = el("span","mat-dots");
      var cur = MAT.indexOf(c.currentMaturity), tgt = MAT.indexOf(c.targetMaturity);
      var d1 = el("i","mat-dot"); d1.style.background = MAT_COLOUR[c.currentMaturity] || "var(--line)";
      wrap.appendChild(d1);
      wrap.appendChild(el("span","mat-txt", (c.currentMaturity || "?")));
      if(tgt > cur && tgt >= 0){
        wrap.appendChild(el("span","mat-arrow","→"));
        wrap.appendChild(el("span","mat-txt mat-target", c.targetMaturity));
      }
      return wrap;
    }

    // Build: one section per L1, a card per L2, a tile per L3+.
    roots.forEach(function(r){
      var sec = el("section","cap-sec"); sec.dataset.capId = r.id;
      var h = el("div","cap-sec-h");
      var badge = el("span","cap-sec-n tnum", r.id);
      h.appendChild(badge);
      var ht = el("div");
      ht.appendChild(el("h3", null, r.name || r.id));
      if(r.description) ht.appendChild(el("p","cap-sec-d", r.description));
      h.appendChild(ht);
      var leaves = 0;
      (kids[r.id]||[]).forEach(function(a){ leaves += (kids[a.id]||[]).length || 1; });
      h.appendChild(el("span","cap-sec-c", leaves + (leaves===1?" capability":" capabilities")));
      sec.appendChild(h);

      var grid = el("div","cap-areas");
      (kids[r.id]||[]).forEach(function(area){
        var card = el("div","cap-area"); card.dataset.capId = area.id;
        var ah = el("div","cap-area-h");
        ah.appendChild(el("span","cap-area-n tnum", area.id));
        ah.appendChild(el("h4", null, area.name || area.id));
        card.appendChild(ah);
        var tiles = el("div","cap-tiles");
        var leafList = kids[area.id] || [area];
        leafList.forEach(function(leaf){
          var t = el("div","cap-tile"); t.dataset.capId = leaf.id;
          t.dataset.hay = [leaf.id, leaf.name, leaf.description, leaf.stage, (leaf.sourceDocs||[]).join(" ")].join(" ").toLowerCase();
          t.dataset.root = r.id;
          var th = el("div","cap-tile-h");
          th.appendChild(el("span","cap-tile-n tnum", leaf.id));
          th.appendChild(el("span","cap-tile-t", leaf.name || leaf.id));
          t.appendChild(th);
          t.appendChild(dots(leaf));
          if(leaf.stage) t.appendChild(el("span","cap-stage", leaf.stage));
          tiles.appendChild(t);
        });
        card.appendChild(tiles);
        grid.appendChild(card);
      });
      sec.appendChild(grid);
      capCanvas.appendChild(sec);
    });
    if(!caps.length) capCanvas.appendChild(el("div","empty","No capability map generated for this feature yet."));

    function applyCapFilter(){
      var active = !!(F.q || F.domains.length);
      $$(".cap-tile").forEach(function(t){
        var ok = true;
        if(F.q && t.dataset.hay.indexOf(F.q) < 0) ok = false;
        if(ok && F.domains.length && F.domains.indexOf(t.dataset.root) < 0) ok = false;
        t.classList.toggle("dim", active && !ok);
      });
      $$(".cap-sec").forEach(function(sec){
        var any = [].slice.call(sec.querySelectorAll(".cap-tile")).some(function(t){ return !t.classList.contains("dim"); });
        sec.classList.toggle("dim", active && !any);
      });
    }
  }

  // ---------------- process model
  // ---------------- process: a three-level DRILL-DOWN, not a list.
  // phase cards -> step cards -> activity cards, with breadcrumbs and Back —
  // the companion-app reference's ProcessPerspective, in vanilla JS.
  var acts = DATA.activities || [];

  // Phase icons are keyword-matched from the phase name, so any feature's
  // lifecycle gets a sensible icon. The reference hardcodes its own phase
  // names, which would not transfer between clients.
  var ICON_RULES = [
    [/lodge|intake|submit|discover|receiv/i, "M20 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6M12 3v12m0 0l-4-4m4 4l4-4"],
    [/triage|registr|classif|rout/i,        "M4 6h16M7 12h10M10 18h4"],
    [/assess|review|analys|determin|screen/i,"M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4"],
    [/commercial|licen|fee|financ|billing|payment/i, "M3 10h18M7 15h4M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"],
    [/notif|clearance|works|schedul|coordinat/i, "M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zM18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"],
    [/lifecycle|manage|maintain|install|variation/i, "M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-5.07l-2.83 2.83M9.76 14.24l-2.83 2.83m0-10.14l2.83 2.83m4.48 4.48l2.83 2.83"],
    [/decommission|closure|clos|exit|remov|terminat/i, "M9 12l2 2 4-4M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"],
    [/care|health|clinical|support/i,        "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z"],
  ];
  var ICON_FALLBACK = "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5";
  function phaseIcon(name){
    for(var i=0;i<ICON_RULES.length;i++){ if(ICON_RULES[i][0].test(name||"")) return ICON_RULES[i][1]; }
    return ICON_FALLBACK;
  }
  function svgIcon(d, size){
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox","0 0 24 24"); svg.setAttribute("aria-hidden","true");
    if(size){ svg.setAttribute("width",size); svg.setAttribute("height",size); }
    var path = document.createElementNS(ns,"path");
    path.setAttribute("d", d);
    svg.appendChild(path);
    return svg;
  }

  // phase -> step -> activities, preserving document order.
  var PHASES = [];
  acts.forEach(function(a){
    var ph = PHASES.filter(function(p){ return p.name === a.l1; })[0];
    if(!ph){ ph = { name: a.l1, steps: [], count: 0 }; PHASES.push(ph); }
    var st = ph.steps.filter(function(s){ return s.name === a.l2; })[0];
    if(!st){ st = { name: a.l2, activities: [] }; ph.steps.push(st); }
    st.activities.push(a); ph.count++;
  });

  var pState = { phase: null, step: null };
  function drawProcess(){
    var host = $("#proc-body"); if(!host) return;
    host.innerHTML = "";
    var level = pState.step ? "activities" : pState.phase ? "steps" : "phases";

    // breadcrumb
    var crumbs = el("nav","crumbs"); crumbs.setAttribute("aria-label","Breadcrumb");
    function crumb(label, active, onClick){
      var b = el("button","crumb" + (active ? " on" : "")); b.type = "button";
      b.textContent = label;
      if(active) b.setAttribute("aria-current","page"); else b.addEventListener("click", onClick);
      return b;
    }
    crumbs.appendChild(crumb("Process", level === "phases", function(){ pState.phase = null; pState.step = null; drawProcess(); }));
    if(pState.phase){
      crumbs.appendChild(el("span","crumb-sep","›"));
      crumbs.appendChild(crumb(pState.phase.name, level === "steps", function(){ pState.step = null; drawProcess(); }));
    }
    if(pState.step){
      crumbs.appendChild(el("span","crumb-sep","›"));
      crumbs.appendChild(crumb(pState.step.name, true, null));
    }
    host.appendChild(crumbs);

    if(pState.phase || pState.step){
      var back = el("button","backbtn","← Back"); back.type = "button";
      back.addEventListener("click", function(){
        if(pState.step) pState.step = null; else pState.phase = null;
        drawProcess();
      });
      host.appendChild(back);
    }

    if(level === "phases"){
      host.appendChild(secHead("Lifecycle", "Process phases", "Select a phase to drill into its steps and activities."));
      var grid = el("div","phase-grid");
      PHASES.forEach(function(p, i){
        var card = el("button","phase-card"); card.type = "button";
        var top = el("div","phase-top");
        var ic = el("span","phase-ic"); ic.appendChild(svgIcon(phaseIcon(p.name)));
        top.appendChild(ic);
        top.appendChild(el("span","phase-num tnum", String(i+1).padStart(2,"0")));
        card.appendChild(top);
        card.appendChild(el("h3", null, p.name));
        var meta = el("div","phase-meta");
        meta.appendChild(el("span", null, p.steps.length + (p.steps.length===1?" step":" steps")));
        meta.appendChild(el("span","dot-sep",""));
        meta.appendChild(el("span", null, p.count + (p.count===1?" activity":" activities")));
        meta.appendChild(el("span","chev","›"));
        card.appendChild(meta);
        card.addEventListener("click", function(){ pState.phase = p; pState.step = null; drawProcess(); });
        grid.appendChild(card);
      });
      host.appendChild(grid);
      return;
    }

    if(level === "steps"){
      host.appendChild(secHead(pState.phase.name, "Process steps", pState.phase.steps.length + " steps in this phase."));
      var sgrid = el("div","step-grid");
      pState.phase.steps.forEach(function(st, i){
        var card = el("button","step-card"); card.type = "button";
        card.appendChild(el("span","step-num tnum", String(i+1).padStart(2,"0")));
        card.appendChild(el("h3", null, st.name));
        var m = el("div","phase-meta");
        m.appendChild(el("span", null, st.activities.length + (st.activities.length===1?" activity":" activities")));
        m.appendChild(el("span","chev","›"));
        card.appendChild(m);
        card.addEventListener("click", function(){ pState.step = st; drawProcess(); });
        sgrid.appendChild(card);
      });
      host.appendChild(sgrid);
      return;
    }

    host.appendChild(secHead(pState.step.name, "Activities", pState.step.activities.length + " activities in this step."));
    var agrid = el("div","act-grid");
    pState.step.activities.forEach(function(a){
      var card = el("article","act-card");
      card.appendChild(el("h3", null, a.l3));
      if(a.description) card.appendChild(el("p","act-desc", a.description));
      var chips = el("div","chips");
      if(a.actor) chips.appendChild(el("span","chip chip-actor", a.actor));
      if(a.serviceTier) chips.appendChild(el("span","chip", a.serviceTier));
      (a.components||[]).forEach(function(c){ chips.appendChild(el("span","chip chip-quiet", c)); });
      if(chips.childNodes.length) card.appendChild(chips);
      if((a.capabilityIds||[]).length){
        var cap = el("div","act-caps");
        cap.appendChild(el("span","act-caps-l","Capabilities"));
        cap.appendChild(el("span", null, a.capabilityIds.join(", ")));
        card.appendChild(cap);
      }
      agrid.appendChild(card);
    });
    host.appendChild(agrid);
  }
  function secHead(eyebrow, title, sub){
    var h = el("div","sec-head");
    h.appendChild(el("div","eyebrow", eyebrow));
    h.appendChild(el("h2","panel-h", title));
    if(sub) h.appendChild(el("p","lede", sub));
    return h;
  }
  if(acts.length) drawProcess();

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
  // Light is the default. Dark only applies when the reader asks for it, so the
  // page does not change appearance based on the machine it is opened on.
  function applyTheme(t){
    if(t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
    var dark = t === "dark";
    // The button holds an icon as well as its label, so only the label changes.
    var lbl = themeBtn.querySelector("span");
    if(lbl) lbl.textContent = dark ? "Light" : "Dark"; else themeBtn.textContent = dark ? "Light" : "Dark";
    themeBtn.setAttribute("aria-pressed", dark ? "true" : "false");
  }
  themeBtn.addEventListener("click", function(){
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
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
  a.images = await loadImages(featureRoot, a.personas);
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
