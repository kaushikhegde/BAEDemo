// Everything the companion app READS: theme, artefacts, collections, artwork,
// and the markdown + Mermaid passes that turn documents into HTML.
//
// Moved verbatim out of scripts/render-companion-app.mjs when the page became
// statically rendered (docs/superpowers/specs/2026-10-07-companion-app-redesign-design.md).
// The comments explain past failures; keep them with the code they explain.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { WORK_ROOT } from "../lib/roots.mjs";
import {
  HEX, contrast, mix, brandTextColor, ensureTextSurface, selectedSurface,
} from "../lib/colour.mjs";
import { validateFlows } from "../lib/flows.mjs";
import { esc, slug } from "./html.mjs";

export const WORKSPACE = WORK_ROOT;
export const die = (msg) => { console.error(`[render-companion-app] ${msg}`); process.exit(1); };

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

/**
 * The island payload, with every trace of WHICH DOCUMENT said so removed.
 *
 * The persona and capability artefacts carry their evidence in two shapes: a
 * `sources` / `sourceDocs` array of file paths, and inline `[project/root/….md
 * §7.5]` citations inside the persona's own today/tomorrow bullets. Both were
 * rendered — the arrays as chips, the citations as raw text mid-sentence — so
 * a client reading their own delivery pack saw our internal file names.
 *
 * Stripped HERE, at the one place every surface is fed from, rather than at
 * each render site: there are several, and a new one added later would
 * reintroduce this silently.
 *
 * The files on disk are NOT touched. Evidence is the discipline the persona
 * skill is built on, `validate-experience.mjs` checks it, and the wiki
 * document keeps it — this removes it from the page, not from the record.
 */
export function withoutSourceRefs(value) {
  const CITATION = /\s*\[[^\]\n]*\.md[^\]\n]*\]/gi;
  const walk = (v) => {
    if (typeof v === "string") return v.replace(CITATION, "").trim();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        // "source" (singular) is the third shape, on the metric objects
        // inside a journey: {name, today, target, source}. Measured rather
        // than guessed — the first two keys alone still left five file
        // paths on the page.
        if (k === "sources" || k === "sourceDocs" || k === "source") continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/**
 * A story's description, as parts a page can lay out.
 *
 * `stories.json` is Jira-shaped and its description is Jira WIKI MARKUP —
 * `h3.` headings, `*bold*` labels and `*` bullets — because that is what the
 * BA writes for the backlog. The page rendered the whole thing into a single
 * <p>, so HTML collapsed every newline and the reader got one grey paragraph
 * with `h3. Detail Description`, the labels, every acceptance criterion and a
 * literal `{{PRODUCT_SUMMARY_URL}}` run together on one line.
 *
 * Parsed HERE rather than in the browser for the reason every other artefact
 * is: the renderer owns the pixels, the agent writes the data, and a parse
 * that runs in node can be checked without a browser.
 *
 * Anything unrecognised comes back as `narrative`, so a story written in a
 * shape this does not know still renders its own words rather than nothing.
 */
export function parseStory(raw) {
  const text = String(raw == null ? "" : raw).trim();
  const empty = { narrative: "", userGroup: "", process: "", acceptanceCriteria: [] };
  if (!text) return empty;

  // A publish-time token, substituted when the work items are created and
  // meaningless to anyone reading the page.
  const cleaned = text.replace(/^[ \t]*\*Product Summary:\*.*$/gim, "").trim();

  const field = (label) => {
    const re = new RegExp("^[ \\t]*\\*" + label + ":\\*[ \\t]*(.+)$", "im");
    const m = cleaned.match(re);
    return m ? m[1].trim() : "";
  };

  // The bullets are the `* ` lines after the Acceptance Criteria label.
  const parts = cleaned.split(/^[ \t]*\*Acceptance Criteria[^*\n]*:\*[ \t]*$/im);
  const acceptanceCriteria = (parts[1] || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("* "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);

  // The narrative is everything before the first structural marker.
  const narrative = cleaned
    .split(/^[ \t]*(?:h[1-6]\.|\*(?:User Group|Process|Acceptance Criteria))/im)[0]
    .trim();

  return {
    narrative,
    userGroup: field("User Group"),
    process: field("Process"),
    acceptanceCriteria,
  };
}

export async function readText(...rel) {
  try { return await fs.readFile(path.join(...rel), "utf8"); } catch { return null; }
}
export async function readJson(...rel) {
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

export function mdToHtml(md, diagrams, diagramsSkipped, idScope = "") {
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
        // A missing SVG means one of two very different things, and a reader
        // cannot tell them apart from raw source alone: either the diagram
        // failed, or this page was built with --no-diagrams. Say which.
        const why = diagramsSkipped
          ? "Diagram not rendered — this page was built with --no-diagrams. Re-run without that flag."
          : "Diagram source (this diagram failed to render)";
        out.push(svg
          ? `<figure class="diagram" role="group" aria-label="Diagram" tabindex="0"><div class="diagram-inner">${svg}</div></figure>`
          : `<figure class="diagram diagram-fallback"><figcaption>${esc(why)}</figcaption><pre tabindex="0"><code>${esc(src)}</code></pre></figure>`);
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
      out.push(`<h${lvl} id="${idScope}${slug(h[2]).slice(0, 60)}">${inline(h[2])}</h${lvl}>`);
      i++; continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push("<hr/>"); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out.push(`<blockquote>${mdToHtml(buf.join("\n"), diagrams, diagramsSkipped)}</blockquote>`);
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

export function collectMermaid(docs) {
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
export function diagramLabel(src) {
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

/**
 * Namespace an inlined SVG's internal ids.
 *
 * mermaid-cli emits fixed ids for every diagram it renders — `my-svg` on the
 * root, plus `my-svg-drop-shadow`, arrowhead markers, gradients and clip paths
 * in `<defs>`. Inlining several diagrams into ONE page therefore produces one
 * duplicate id per diagram per def, which is a WCAG 4.1.1 failure and, worse,
 * makes every `url(#…)` reference resolve to the FIRST diagram's def — so later
 * diagrams silently borrow the first one's markers.
 *
 * It went unnoticed while a page carried a handful of diagrams. A project page
 * carries every feature's, so it scales with the client.
 */
function uniquifySvgIds(svg, n) {
  const ids = new Set();
  for (const m of svg.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  if (!ids.size) return svg;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = svg;
  for (const id of ids) {
    const scoped = `d${n}-${id}`;
    const q = esc(id);
    out = out
      .replace(new RegExp(`(\\sid=")${q}(")`, "g"), `$1${scoped}$2`)
      // url(#id), url("#id"), url('#id')
      .replace(new RegExp(`url\\((['"]?)#${q}\\1\\)`, "g"), `url($1#${scoped}$1)`)
      // href="#id" / xlink:href="#id" / aria-labelledby / clip-path attributes
      .replace(new RegExp(`((?:xlink:)?href=")#${q}(")`, "g"), `$1#${scoped}$2`)
      .replace(new RegExp(`(aria-labelledby=")${q}(")`, "g"), `$1${scoped}$2`);
  }

  // ...and the CSS selectors inside <style>, which is where mermaid puts nearly
  // all of its styling: every rule is scoped `#my-svg .node rect { … }`, ~70 of
  // them per diagram. Renaming the root element without rewriting these leaves
  // every rule matching nothing, so nodes fall back to the SVG default fill —
  // BLACK boxes with black text, and edge markers rendering as a filled blob.
  // The diagram looked broken while the ids were, correctly, unique.
  //
  // Longest id first, with a lookahead: `#my-svg` must not eat the prefix of
  // `#my-svg-drop-shadow` and leave `-drop-shadow` dangling.
  const byLength = [...ids].sort((a, b) => b.length - a.length);
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g, (_m, open, css, close) => {
    let c = css;
    for (const id of byLength) {
      c = c.replace(new RegExp(`#${esc(id)}(?![\\w-])`, "g"), `#d${n}-${id}`);
    }
    return open + c + close;
  });

  return out;
}

// Pre-render every mermaid block to INLINE SVG. Inline (not <img src>) so the
// page stays one file and the diagram inherits the page's fonts and colours.
export async function renderDiagrams(sources, { skip }) {
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
    out.set(key, uniquifySvgIds(svg, n));
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

// The colour arithmetic lives in lib/colour.mjs, where it is tested.

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

export async function loadTheme(featureRoot) {
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
    // be a surface that can carry text at all. `onBrand` is the house type
    // colour on the brand (BAE: white on red); without it the maths picks.
    if (t.onBrand != null && !(typeof t.onBrand === "string" && HEX.test(t.onBrand.trim()))) {
      console.warn(`[render-companion-app] WARN theme.json "onBrand" is not a hex colour — ignored`);
    }
    const sel = selectedSurface(brand, t.onBrand);
    const selLight = sel.bg;
    out.vars["--sel-bg"] = selLight;
    out.vars["--sel-fg"] = sel.fg;

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
    const selDark = selectedSurface(darkBrand, t.onBrand);
    out.darkVars["--sel-bg"] = selDark.bg;
    out.darkVars["--sel-fg"] = selDark.fg;

    console.log(
      `[render-companion-app] theme: brand ${brand}\n` +
      `  light  nav ${selLight} on ${out.vars["--sel-fg"]} (${contrast(selLight, out.vars["--sel-fg"]).toFixed(1)}:1), ` +
      `text ${out.lightVars["--brand-fg"]} (${contrast(out.lightVars["--brand-fg"], LIGHT_SURFACE).toFixed(1)}:1)\n` +
      `  dark   nav ${selDark.bg} on ${out.darkVars["--sel-fg"]} (${contrast(selDark.bg, out.darkVars["--sel-fg"]).toFixed(1)}:1), ` +
      `text ${out.darkVars["--brand-fg"]} (${contrast(out.darkVars["--brand-fg"], DARK_SURFACE).toFixed(1)}:1)`,
    );
  }
  return out;
}

// ------------------------------------------------------------------ inputs


/**
 * A collection of documents that share a folder — hundreds of product summaries
 * for one feature, or the test packs that cover them.
 *
 * Each file may carry YAML-ish front matter:
 *   ---
 *   id: PS-001
 *   title: Expression of Interest
 *   productSummary: PS-001      # test packs only — what this pack covers
 *   ---
 *
 * `id` is what links the two collections in both directions, so a file can be
 * renamed without breaking the link. Missing front matter is tolerated: the id
 * falls back to the filename stem and the title to the first heading.
 */
function parseFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

async function readCollection(dir, kind) {
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".md")).sort();
  } catch { return []; }
  const out = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(dir, name), "utf8").catch(() => null);
    if (!raw) continue;
    const { meta, body } = parseFrontMatter(raw);
    const stem = name.replace(/\.md$/i, "");
    const heading = (/^#\s+(.+)$/m.exec(body) || [])[1];
    out.push({
      kind,
      id: meta.id || stem,
      title: meta.title || heading || stem,
      covers: meta.productSummary || meta.covers || null,
      summary: meta.summary || null,
      file: name,
      body,
    });
  }
  return out;
}

/**
 * PROJECT-level artefacts — the ones that describe the client organisation
 * rather than one slice of work. Generated once, read by every feature.
 */
export async function loadProjectArtefacts(projectRoot) {
  const R = (...p) => path.join(projectRoot, ...p);
  const [capabilityMap, processModel, personas, journeyMap] = await Promise.all([
    readJson(R("solutions", "Capabilities", "outputs", "capability-map.json")),
    readJson(R("solutions", "Capabilities", "outputs", "process-model.json")),
    readJson(R("solutions", "Experience", "outputs", "personas.json")),
    readJson(R("solutions", "Experience", "outputs", "journey-map.json")),
  ]);
  const activities = Array.isArray(processModel?.activities) ? processModel.activities : [];

  // Swimlanes are optional. The capability stage refuses a malformed `flows`
  // (render-capability-map.mjs --validate-only), so an error here means the
  // file was edited by hand since — draw the flows that are valid, say why the
  // rest are missing, rather than fail the whole page over one diagram.
  const { flows, errors } = validateFlows(processModel?.flows, activities);
  if (errors.length) {
    console.warn(`[render-companion-app] WARN process-model.json flows — ${errors.length} problem(s), affected swimlanes not drawn:\n  ${errors.join("\n  ")}`);
  }
  return {
    capabilities: Array.isArray(capabilityMap?.capabilities) ? capabilityMap.capabilities : [],
    activities,
    flows,
    personas: Array.isArray(personas?.personas) ? personas.personas : [],
    journeys: Array.isArray(journeyMap?.journeys) ? journeyMap.journeys : [],
  };
}

/**
 * FEATURE-level artefacts — one slice of work. Loaded once per feature and
 * surfaced behind a feature card on each feature tab.
 */
export async function loadFeatureArtefacts(featureRoot) {
  const R = (...p) => path.join(featureRoot, ...p);
  const [
    storiesJson, storiesMd, gaps,
    dataModelImpact, salesforceDataModel, solutionDesign, solutionArchitecture,
    mockups,
  ] = await Promise.all([
    readJson(R("outputs", "stories.json")),
    readText(R("outputs", "stories.md")),
    readText(R("outputs", "gaps.md")),
    readText(R("solutions", "DataModel", "outputs", "datamodel-impact.md")),
    readText(R("solutions", "DataModel", "outputs", "salesforce-data-model.md")),
    readText(R("solutions", "Design", "outputs", "solution-design.md")),
    readText(R("solutions", "Architecture", "outputs", "solution-architecture.md")),
    readJson(R("solutions", "UI", "outputs", "mockups.json")),
  ]);

  const stories = Array.isArray(storiesJson)
    ? storiesJson.map((s) => ({
        summary: s?.fields?.summary ?? s?.summary ?? "",
        ...parseStory(s?.fields?.description ?? s?.description ?? ""),
        labels: s?.fields?.labels ?? s?.labels ?? [],
      }))
    : [];

  const { summaries, packs } = await loadCollections(featureRoot);

  return {
    stories, storiesMd, gaps,
    dataModel: dataModelImpact || salesforceDataModel,
    dataModelKind: dataModelImpact ? "Data Model Impact" : salesforceDataModel ? "Salesforce Data Model" : null,
    solutionDesign, solutionArchitecture,
    screens: Array.isArray(mockups?.screens) ? mockups.screens : [],
    generatedFrom: Array.isArray(mockups?.generatedFrom) ? mockups.generatedFrom : null,
    summaries, packs,
  };
}

/**
 * Product summaries and their test packs.
 *
 * A feature may hold hundreds of product summaries, so the folder form is the
 * primary shape. The historic single-file form is still read and presented as a
 * collection of one, so features generated before this change keep working.
 */
async function loadCollections(featureRoot) {
  const R = (...p) => path.join(featureRoot, ...p);
  const [summaries, packs, legacySummary, legacyPack] = await Promise.all([
    readCollection(R("outputs", "product-summaries"), "summary"),
    readCollection(R("solutions", "QA", "outputs", "test-cases"), "testcase"),
    readText(R("outputs", "product-summary.md")),
    readText(R("solutions", "QA", "outputs", "test-cases.md")),
  ]);

  if (!summaries.length && legacySummary) {
    const { meta, body } = parseFrontMatter(legacySummary);
    summaries.push({
      kind: "summary",
      id: meta.id || "PS-001",
      title: meta.title || (/^#\s+(.+)$/m.exec(body) || [])[1] || "Product Summary",
      covers: null, file: "product-summary.md", body,
    });
  }
  if (!packs.length && legacyPack) {
    const { meta, body } = parseFrontMatter(legacyPack);
    packs.push({
      kind: "testcase",
      id: meta.id || "TC-001",
      title: meta.title || (/^#\s+(.+)$/m.exec(body) || [])[1] || "Test Cases",
      // With one of each and no declared link, the pairing is unambiguous.
      covers: meta.productSummary || (summaries.length === 1 ? summaries[0].id : null),
      file: "test-cases.md", body,
    });
  }
  return { summaries, packs };
}

/**
 * Optional artwork, keyed by persona id:
 *   design/personas/<id>.png        -> the round avatar on the persona card
 *   design/journeys/<id>-journey.png -> the full journey diagram
 * Anything absent simply falls back to what the page draws itself.
 */
export async function loadImages(projectRoot, personas) {
  const personaDir = path.join(projectRoot, "design", "personas");
  const journeyDir = path.join(projectRoot, "design", "journeys");
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

/**
 * The feature-level tabs, in pipeline order. Each opens on a grid of feature
 * cards and drills into one feature's document — which is why they are declared
 * as data: the markup, the nav entry and the JS all derive from this one list.
 *
 * `stat` is the one line a reader sees on the card before opening it, and `has`
 * decides whether the card is live or a muted "not generated" placeholder.
 */
export const FEATURE_TABS = [
  {
    id: "summary", label: "Product Summary", eyebrow: "Requirements", noun: "a product summary",
    has: (f) => f.summaries.length > 0,
    stat: (f) => `${f.summaries.length} document${f.summaries.length === 1 ? "" : "s"}` +
                 (f.stories.length ? ` · ${f.stories.length} stor${f.stories.length === 1 ? "y" : "ies"}` : ""),
  },
  {
    id: "stories", label: "Stories", eyebrow: "Jira-ready user stories", noun: "stories",
    has: (f) => f.stories.length > 0,
    stat: (f) => `${f.stories.length} stor${f.stories.length === 1 ? "y" : "ies"}`,
  },
  {
    id: "ui", label: "UI", eyebrow: "Wireframes", noun: "UI mockups",
    has: (f) => f.screens.length > 0,
    stat: (f) => `${f.screens.length} screen${f.screens.length === 1 ? "" : "s"}` +
                 (f.generatedFrom && !f.generatedFrom.includes("DataModel") ? " · designed before the data model" : ""),
  },
  {
    id: "datamodel", label: "Data Model", eyebrow: "Salesforce schema", noun: "a data model",
    has: (f) => Boolean(f.dataModel),
    stat: (f) => f.dataModelKind || "Data model",
  },
  {
    id: "architecture", label: "Architecture", eyebrow: "Solution architecture", noun: "an architecture",
    has: (f) => Boolean(f.solutionArchitecture),
    stat: () => "Solution Architecture Document",
  },
  {
    id: "testcases", label: "Test Cases", eyebrow: "Test packs", noun: "test cases",
    has: (f) => f.packs.length > 0,
    stat: (f) => `${f.packs.length} pack${f.packs.length === 1 ? "" : "s"}`,
  },
  {
    id: "design", label: "Solution Design", eyebrow: "Component design", noun: "a solution design",
    has: (f) => Boolean(f.solutionDesign),
    stat: () => "Solution Design Document",
  },
];
