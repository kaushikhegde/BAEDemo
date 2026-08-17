// Reads openapi.yaml once, serves it as JSON at /openapi.json, and renders a
// hand-rolled reference page at /docs — no CDN-loaded Swagger UI or Redoc, so
// the page makes zero network requests. The renderer is pure (spec + theme in,
// HTML string out) so it can be unit-tested without booting an Express app.

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Request, Response } from "express";
import type { Theme } from "../config.js";
import { themeCss } from "./theme.js";

// Minimal shape this module actually reads off the parsed spec — not a full
// OpenAPI type (that's what a real `openapi-types` dependency is for; this
// prototype doesn't pull one in just to type a doc renderer).
export interface OpenApiOperation {
  summary?: string;
  description?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; schema?: { type?: string } }>;
  requestBody?: { description?: string; content?: Record<string, { schema?: unknown; example?: unknown }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown; example?: unknown }> }>;
}
export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, unknown> };
}

/** `openapi.yaml` sits at the package root, two levels above this file (`src/http/`). */
const OPENAPI_PATH = new URL("../../openapi.yaml", import.meta.url);

export function loadOpenApiSpec(): OpenApiSpec {
  return parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiSpec;
}

// `yaml`'s parse() does not resolve `$ref` — openapi.yaml uses
// `components.parameters` refs (`AgentKey`, `IssueId`, `GateId`, `RunId`) to
// avoid repeating the same path-parameter object on every operation, so the
// PAGE renderer (which reads `p.name`/`p.in`/`p.description` straight off
// each parameter) needs those resolved first. `/openapi.json` still serves
// the spec AS WRITTEN — with `$ref`s intact, which is the normal contract for
// an OpenAPI document — only the page renderer works off a dereferenced copy.
function resolveJsonPointer(root: unknown, ref: string): unknown {
  let node: unknown = root;
  for (const segment of ref.replace(/^#\//, "").split("/")) {
    if (node && typeof node === "object" && segment in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

function deref(root: unknown, node: unknown, seenRefs: ReadonlySet<string>): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(item => deref(root, item, seenRefs));

  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    if (seenRefs.has(obj.$ref)) return {};   // cyclic ref guard; none exist in openapi.yaml today
    return deref(root, resolveJsonPointer(root, obj.$ref), new Set(seenRefs).add(obj.$ref));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) out[key] = deref(root, value, seenRefs);
  return out;
}

/** A fully `$ref`-resolved copy, for the page renderer's convenience only. */
export function dereferenceSpec(spec: OpenApiSpec): OpenApiSpec {
  return deref(spec, spec, new Set()) as OpenApiSpec;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const METHOD_ORDER = ["get", "post", "patch", "put", "delete"];

function renderParams(op: OpenApiOperation): string {
  if (!op.parameters?.length) return "";
  const items = op.parameters
    .map(p => `<li><code>${escapeHtml(p.name)}</code> <span class="tag">${escapeHtml(p.in)}</span>${
      p.required ? ' <span class="tag required">required</span>' : ""
    }${p.description ? ` — ${escapeHtml(p.description)}` : ""}</li>`)
    .join("");
  return `<h4>Parameters</h4><ul class="params">${items}</ul>`;
}

function renderResponses(op: OpenApiOperation): string {
  const entries = Object.entries(op.responses ?? {});
  if (!entries.length) return "";
  const items = entries
    .map(([code, r]) => {
      const example = firstExample(r.content);
      return `<li><code class="status">${escapeHtml(code)}</code> ${escapeHtml(r.description ?? "")}${
        example ? `<pre class="example">${escapeHtml(JSON.stringify(example, null, 2))}</pre>` : ""
      }</li>`;
    })
    .join("");
  return `<h4>Responses</h4><ul class="responses">${items}</ul>`;
}

function firstExample(content: Record<string, { example?: unknown }> | undefined): unknown {
  if (!content) return undefined;
  for (const c of Object.values(content)) if (c.example !== undefined) return c.example;
  return undefined;
}

function renderRequestBody(op: OpenApiOperation): string {
  if (!op.requestBody) return "";
  const example = firstExample(op.requestBody.content);
  return `<h4>Request body</h4>${op.requestBody.description ? `<p>${escapeHtml(op.requestBody.description)}</p>` : ""}${
    example ? `<pre class="example">${escapeHtml(JSON.stringify(example, null, 2))}</pre>` : ""
  }`;
}

function renderOperation(path: string, method: string, op: OpenApiOperation): string {
  return `<article class="op">
    <h3><span class="method method-${escapeHtml(method)}">${escapeHtml(method.toUpperCase())}</span> <code class="path">${escapeHtml(path)}</code></h3>
    <p class="summary">${escapeHtml(op.summary ?? "")}</p>
    ${op.description ? `<p class="description">${escapeHtml(op.description)}</p>` : ""}
    ${renderParams(op)}
    ${renderRequestBody(op)}
    ${renderResponses(op)}
  </article>`;
}

function renderPaths(spec: OpenApiSpec): string {
  const sections = Object.entries(spec.paths)
    .map(([path, ops]) => {
      const methods = Object.keys(ops).sort(
        (a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b));
      const opsHtml = methods.map(m => renderOperation(path, m, ops[m])).join("");
      return `<section class="path-group" id="${escapeHtml(path.replace(/[{}/]/g, "-"))}">${opsHtml}</section>`;
    })
    .join("");
  return `<main>${sections}</main>`;
}

/**
 * Styled ONLY with the custom properties `themeCss` defines
 * (`var(--brand)`, `var(--surface)`, `var(--border)`, ...) — a consumer's
 * theme override repaints this page without touching a single rule here.
 */
const DOCS_CSS = `
header {
  display: flex; align-items: baseline; gap: 0.75rem;
  padding: 1.5rem 2rem; border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.wordmark { font-size: 1.35rem; font-weight: 700; color: var(--brand); }
.ver { color: var(--ink-500); font-size: 0.85rem; }
.intro { padding: 1rem 2rem 0; color: var(--ink-500); max-width: 72ch; }
main { padding: 1rem 2rem 3rem; max-width: 960px; margin: 0 auto; }
.path-group { border: 1px solid var(--border); border-radius: 8px; margin: 1.25rem 0; overflow: hidden; background: var(--surface); }
.op { padding: 1rem 1.25rem; border-top: 1px solid var(--border); }
.op:first-child { border-top: none; }
.op h3 { margin: 0 0 0.4rem; font-size: 1rem; display: flex; align-items: center; gap: 0.6rem; }
.method { display: inline-block; min-width: 3.6rem; text-align: center; padding: 0.15rem 0.5rem; border-radius: 4px;
  font-size: 0.72rem; font-weight: 700; letter-spacing: 0.02em; color: #ffffff; }
.method-get { background: var(--info); }
.method-post { background: var(--success); }
.method-patch { background: var(--warning); }
.method-put { background: var(--warning); }
.method-delete { background: var(--danger); }
code.path { font-family: ui-monospace, Menlo, Consolas, monospace; }
.summary { margin: 0.2rem 0; }
.description { margin: 0.2rem 0; color: var(--ink-500); }
h4 { margin: 0.75rem 0 0.25rem; font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--ink-500); }
ul.params, ul.responses { margin: 0; padding-left: 1.1rem; }
ul.params li, ul.responses li { margin: 0.2rem 0; }
.tag { display: inline-block; font-size: 0.68rem; padding: 0.05rem 0.35rem; border-radius: 3px;
  background: var(--ink-50); color: var(--ink-500); border: 1px solid var(--border); }
.tag.required { background: var(--danger); color: #ffffff; border-color: var(--danger); }
code.status { font-weight: 700; }
pre.example { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem 0.75rem;
  overflow-x: auto; font-size: 0.8rem; margin: 0.3rem 0 0; }
footer { padding: 1.5rem 2rem 3rem; color: var(--ink-500); text-align: center; font-size: 0.8rem; }
`;

export function renderDocsPage(theme: Theme, spec: OpenApiSpec): string {
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(theme.logoText)} — API</title>
<style>${themeCss(theme)}${DOCS_CSS}</style>
</head><body>
<header><span class="wordmark">${escapeHtml(theme.logoText)}</span><span class="ver">v${escapeHtml(spec.info.version)}</span></header>
${spec.info.description ? `<p class="intro">${escapeHtml(spec.info.description.trim())}</p>` : ""}
${renderPaths(spec)}
<footer>Rendered locally from <code>openapi.yaml</code>. No external requests.</footer>
</body></html>`;
}

/**
 * `getTheme` is a thunk rather than a fixed `Theme`, so the page always
 * reflects the orchestrator's CURRENT config — a theme override in
 * `orchestrator.config.ts` takes effect on the next request, no restart of
 * this module required. The parsed spec, in contrast, is read from disk once
 * and cached: `openapi.yaml` is a build artefact of this task, not something
 * a consumer edits at runtime.
 */
export function createDocsHandlers(getTheme: () => Theme): {
  openapiHandler: (req: Request, res: Response) => void;
  docsHandler: (req: Request, res: Response) => void;
} {
  const spec = loadOpenApiSpec();
  const resolvedSpec = dereferenceSpec(spec);
  return {
    openapiHandler(_req, res) {
      res.type("application/json").send(JSON.stringify(spec, null, 2));
    },
    docsHandler(_req, res) {
      res.type("html").send(renderDocsPage(getTheme(), resolvedSpec));
    },
  };
}
