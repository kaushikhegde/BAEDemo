# Azure DevOps Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Confluence + Jira publishing with Azure DevOps Wiki pages and User Story work items, end to end, so every stage that publishes reaches ADO instead.

**Architecture:** Publishing stays two node scripts invoked by the publish agent, for the reason `confluence-publish.mjs` already exists — a 110 KB document passed through a tool call cost $2.73 and produced no page. `ado-publish.mjs` PUTs markdown straight to a wiki path (ADO Wiki takes markdown natively, so the storage-format conversion disappears); `ado-workitems.mjs` POSTs JSON-Patch work items. Page identity becomes the wiki **path**, which is inherently idempotent — no title lookup, no remembered page id.

**Tech Stack:** Node ESM `.mjs` scripts, Azure DevOps REST API 7.1, PAT over HTTP Basic, vitest 2.1 (added at the repo root — see Global Constraints).

**Spec:** `docs/superpowers/specs/2026-08-20-azure-devops-publishing-design.md`

## Global Constraints

- **Never run `git commit`.** The user commits their own work. Every task ends at a review checkpoint instead.
- Australian English in all generated content and user-facing strings.
- **Auth:** HTTP Basic, username empty, password = PAT. `Authorization: Basic ` + `base64(":" + PAT)`. PAT read from `ADO_PAT`, falling back to `MCP_TOKEN_FOR_AZURE`, from the environment or the root `.env` — the same pattern `scripts/lib/atlassian.mjs` uses.
- **API version is `7.1` on every call.** Omitting it makes ADO answer with an HTML sign-in page rather than JSON, which reads as a parse error rather than an auth error.
- **Never create an ADO project or wiki.** Verify and refuse, exactly as `confluence-publish.mjs` refuses to create a space. An ADO project create is a long-running async operation and a half-created project is worse than a clear refusal.
- **Scripts are tested.** `vitest` is added as a root devDependency and a root `vitest.config.ts` collects `scripts/**/*.test.mjs`. This is a deliberate new dependency: `check-routing.mts`'s comment argues a check beats a test runner "for a single round-trip assertion", and that reasoning does not extend to two scripts carrying ETag concurrency, idempotency and markdown rewriting. `npm test` runs both suites.
- Secrets never appear in output. `say()` must never print the PAT or an `Authorization` header.
- No network in tests. Every REST call goes through one injectable `fetch`.

---

## File Structure

| File | Responsibility |
|---|---|
| `vitest.config.ts` (root) | NEW — collects `scripts/**/*.test.mjs` |
| `scripts/lib/ado.mjs` | NEW — credentials, the `api()` helper, path/URL builders. The only file that knows the REST shape |
| `scripts/ado-publish.mjs` | NEW — markdown file → wiki page, attachments, `.published.json` |
| `scripts/ado-workitems.mjs` | NEW — `stories.json` → User Story work items |
| `scripts/lib/ado.test.mjs`, `scripts/ado-publish.test.mjs`, `scripts/ado-workitems.test.mjs` | NEW — unit tests over an injected `fetch` |
| `orchestrator.workflows.ts` | MODIFY — `publishPrompt`, `approvalSummary` |
| `scyne-chatbot/server/orchestrator.ts` | MODIFY — `PARAM_LABELS` |
| `scyne-chatbot/server/index.ts` | MODIFY — the description blocks that name Confluence/Jira |
| `scyne-chatbot/server/services/adoVerify.ts` | NEW — replaces `atlassianProvision.ts` |
| `scripts/check-routing.mts` | MODIFY — new title/description shapes |
| `agent-instructions/*.thin.md` | MODIFY — 8 bundles |
| `scripts/legacy-atlassian/` | NEW — archive for `confluence-publish.mjs`, `confluence-attach.mjs`, `lib/atlassian.mjs` |
| `.mcp.json`, `.env`, `CLAUDE.md` | MODIFY |

---

### Task 1: The ADO client library

One module owns credentials and the REST shape, so the two scripts cannot disagree about auth, API version or URL construction.

**Files:**
- Create: `vitest.config.ts` (root)
- Create: `scripts/lib/ado.mjs`
- Test: `scripts/lib/ado.test.mjs`
- Modify: `package.json` (root — devDependency + test script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```js
  export function fail(msg)                                   // stderr + exit 1
  export async function loadCredentials()                     // → { org, pat, auth }
  export function makeApi({ org, project, auth, fetchImpl })  // → api(method, urlPath, { body, headers, raw })
  export function wikiPageUrl(org, project, wiki, pagePath)   // → browser URL
  ```

- [ ] **Step 1: Add the root test runner**

```bash
npm i -D vitest@^2.1.8
```

Create `vitest.config.ts` at the repo root:

```ts
import { defineConfig } from "vitest/config";

// The repo-root suite, covering scripts/. packages/orchestrator has its own.
//
// A test runner here is a new dependency and was weighed: scripts/check-routing.mts
// argues that a check beats a runner "for a single round-trip assertion". That
// reasoning holds for one assertion and stops holding for the ADO scripts, which
// carry ETag concurrency, idempotency and markdown rewriting — logic that is
// wrong in ways a smoke check cannot see.
export default defineConfig({
  test: { globals: true, environment: "node", include: ["scripts/**/*.test.mjs"] },
});
```

In the root `package.json`, change the test script and add one:

```json
    "test:scripts": "vitest run",
    "test": "npm --prefix packages/orchestrator test && npm run test:scripts",
```

- [ ] **Step 2: Write the failing test**

Create `scripts/lib/ado.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { makeApi, wikiPageUrl } from "./ado.mjs";

const auth = "Basic " + Buffer.from(":TESTPAT").toString("base64");

describe("makeApi", () => {
  it("sends Basic auth and pins api-version 7.1 on every call", async () => {
    let seen;
    const api = makeApi({
      org: "scyne", project: "Delivery", auth,
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    });
    await api("GET", "/wiki/wikis");

    expect(seen.url).toBe("https://dev.azure.com/scyne/Delivery/_apis/wiki/wikis?api-version=7.1");
    expect(seen.init.headers.Authorization).toBe(auth);
  });

  it("preserves an existing query string when it appends api-version", async () => {
    let seen;
    const api = makeApi({
      org: "scyne", project: "Delivery", auth,
      fetchImpl: async (url) => { seen = url; return new Response("{}", { status: 200 }); },
    });
    await api("GET", "/wiki/wikis/Docs/pages?path=%2FA");
    expect(seen).toContain("?path=%2FA&api-version=7.1");
  });

  it("reports an HTML sign-in response as an auth failure, not a parse error", async () => {
    // ADO answers an unauthenticated request with a 203 and an HTML sign-in
    // page. Parsing that as JSON throws SyntaxError, which sends the reader
    // hunting for a bug in the payload instead of at the PAT.
    const api = makeApi({
      org: "scyne", project: "Delivery", auth,
      fetchImpl: async () => new Response("<html>Sign In</html>", {
        status: 203, headers: { "content-type": "text/html" },
      }),
    });
    await expect(api("GET", "/wiki/wikis")).rejects.toThrow(/Azure DevOps did not authenticate/i);
  });

  it("returns null for 404 rather than throwing, so callers can branch on absence", async () => {
    const api = makeApi({
      org: "scyne", project: "Delivery", auth,
      fetchImpl: async () => new Response("", { status: 404 }),
    });
    expect(await api("GET", "/wiki/wikis/Docs/pages?path=%2FNope")).toBeNull();
  });
});

describe("wikiPageUrl", () => {
  it("builds a browser URL with the page path encoded", () => {
    expect(wikiPageUrl("scyne", "Delivery", "Docs", "/Scyne/RTWSA/Data Model"))
      .toBe("https://dev.azure.com/scyne/Delivery/_wiki/wikis/Docs?pagePath=%2FScyne%2FRTWSA%2FData%20Model");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm run test:scripts`
Expected: FAIL — `Cannot find module './ado.mjs'`.

- [ ] **Step 4: Write the library**

Create `scripts/lib/ado.mjs`:

```js
// Azure DevOps REST, in one place.
//
// Modelled on lib/atlassian.mjs, which it replaces. Two scripts publish to ADO
// and both need identical auth, an identical API version and identically built
// URLs; putting that here is what stops them drifting apart.
//
// AUTH is HTTP Basic with an EMPTY username and the PAT as the password. Not a
// bearer token — a PAT sent as `Bearer` gets a 203 and an HTML sign-in page,
// which parses as a SyntaxError and sends the reader looking for a bug in the
// payload rather than at the credential.

import fs from "node:fs/promises";
import path from "node:path";
import { INSTALL_ROOT } from "./roots.mjs";

/** Every ADO call pins this. Omit it and the API answers with HTML. */
export const API_VERSION = "7.1";

export function fail(msg) {
  process.stderr.write(`\n${msg}\n\n`);
  process.exit(1);
}

/**
 * The PAT, from the environment or the root `.env`.
 *
 * `ADO_PAT` is the name to use. `MCP_TOKEN_FOR_AZURE` is accepted because that
 * is what the token was first added as, and a working deployment must not break
 * on a rename.
 */
export async function loadCredentials() {
  let org = process.env.ADO_ORG;
  let pat = process.env.ADO_PAT || process.env.MCP_TOKEN_FOR_AZURE;

  if (!org || !pat) {
    // INSTALL_ROOT, not cwd: this runs BY AN AGENT, whose working directory is
    // the project tree — which after materialisation is a temp directory with no
    // .env in it. Same reasoning lib/atlassian.mjs already records.
    const envPath = path.join(INSTALL_ROOT, ".env");
    let raw = "";
    try { raw = await fs.readFile(envPath, "utf8"); } catch { /* environment only */ }
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "").trim();
      if (m[1] === "ADO_ORG" && !org) org = val;
      if ((m[1] === "ADO_PAT" || m[1] === "MCP_TOKEN_FOR_AZURE") && !pat) pat = val;
    }
  }

  if (!pat) {
    fail(`No Azure DevOps PAT available.\n` +
         `  Looked for ADO_PAT (or MCP_TOKEN_FOR_AZURE) in the environment and in\n` +
         `  ${path.join(INSTALL_ROOT, ".env")}.\n` +
         `  Create one at https://dev.azure.com/<org>/_usersSettings/tokens with\n` +
         `  scopes: Wiki (Read & Write) and Work Items (Read, write & manage).`);
  }
  return { org, pat, auth: "Basic " + Buffer.from(`:${pat}`).toString("base64") };
}

/**
 * A bound REST client. `raw: true` returns the Response so a caller can read
 * headers — the wiki's ETag, which an update requires.
 */
export function makeApi({ org, project, auth, fetchImpl = fetch }) {
  const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis`;

  return async function api(method, urlPath, { body, headers = {}, raw = false, contentType } = {}) {
    const url = base + urlPath + (urlPath.includes("?") ? "&" : "?") + `api-version=${API_VERSION}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": contentType ?? "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined
        ? { body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) }
        : {}),
    });

    // An unauthenticated request gets a 203 carrying an HTML sign-in page.
    // Naming that here saves the reader from a SyntaxError with no context.
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/html")) {
      throw new Error(
        `Azure DevOps did not authenticate the request (HTTP ${res.status}, HTML response).\n` +
        `  The PAT is missing, expired, or lacks scope for ${method} ${urlPath}.`);
    }

    if (res.status === 404) return raw ? res : null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Azure DevOps ${method} ${urlPath} → ${res.status}: ${text.slice(0, 500)}`);
    }
    if (raw) return res;
    if (res.status === 204) return {};
    return res.json();
  };
}

/** The URL a human opens. `pagePath` is a wiki path like `/Scyne/RTWSA/Data Model`. */
export function wikiPageUrl(org, project, wiki, pagePath) {
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
         `/_wiki/wikis/${encodeURIComponent(wiki)}?pagePath=${encodeURIComponent(pagePath)}`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:scripts`
Expected: PASS, all five cases.

- [ ] **Step 6: Checkpoint**

Stop.

---

### Task 2: Publish a markdown file to a wiki page

**Files:**
- Create: `scripts/ado-publish.mjs`
- Test: `scripts/ado-publish.test.mjs`

**Interfaces:**
- Consumes: `loadCredentials`, `makeApi`, `wikiPageUrl`, `fail` from `scripts/lib/ado.mjs`.
- Produces: the CLI contract
  ```
  node scripts/ado-publish.mjs <file.md> --org O --project P --wiki W --path "/A/B"
       [--render-mermaid] [--published-json <path> --artefact-key <key>] [--json] [--verify]
  ```
  and, for tests, `export async function publish({ file, org, project, wiki, pagePath, api, readFile, ... })`.

- [ ] **Step 1: Write the failing test**

Create `scripts/ado-publish.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { publish, rewriteImages } from "./ado-publish.mjs";

/** A fake ADO that records calls and can pretend a page does or does not exist. */
function fakeAdo({ existing = null } = {}) {
  const calls = [];
  const api = async (method, urlPath, opts = {}) => {
    calls.push({ method, urlPath, opts });
    if (method === "GET" && urlPath.startsWith("/wiki/wikis/Docs/pages")) {
      if (!existing) return opts.raw ? { status: 404, headers: new Headers() } : null;
      return opts.raw
        ? { status: 200, headers: new Headers({ etag: '"v1"' }), json: async () => existing }
        : existing;
    }
    if (method === "PUT" && urlPath.includes("/attachments")) return { path: "/.attachments/d.png" };
    if (method === "PUT") return { id: 42, path: "/Scyne/Data Model" };
    if (method === "GET" && urlPath === "/wiki/wikis") return { value: [{ name: "Docs" }] };
    return {};
  };
  return { api, calls };
}

describe("publish", () => {
  it("creates a page with a bare PUT when none exists at the path", async () => {
    const { api, calls } = fakeAdo({ existing: null });
    const out = await publish({
      org: "scyne", project: "Delivery", wiki: "Docs", pagePath: "/Scyne/Data Model",
      markdown: "# Data Model\n", api,
    });
    const put = calls.find(c => c.method === "PUT");
    expect(put.opts.headers?.["If-Match"]).toBeUndefined();
    expect(put.opts.body.content).toContain("# Data Model");
    expect(out.url).toContain("pagePath=");
  });

  it("updates in place with the ETag when a page already exists — a revision must not create a second", async () => {
    const { api, calls } = fakeAdo({ existing: { id: 42, content: "old" } });
    await publish({
      org: "scyne", project: "Delivery", wiki: "Docs", pagePath: "/Scyne/Data Model",
      markdown: "# New\n", api,
    });
    const put = calls.find(c => c.method === "PUT" && !c.urlPath.includes("attachments"));
    expect(put.opts.headers["If-Match"]).toBe('"v1"');
  });

  it("is idempotent by path — publishing the same path twice touches one page", async () => {
    const { api, calls } = fakeAdo({ existing: { id: 42, content: "x" } });
    const a = await publish({ org: "s", project: "P", wiki: "Docs", pagePath: "/X", markdown: "1", api });
    const b = await publish({ org: "s", project: "P", wiki: "Docs", pagePath: "/X", markdown: "2", api });
    expect(a.url).toBe(b.url);
    expect(calls.filter(c => c.method === "PUT").every(c => c.urlPath.includes("path=%2FX"))).toBe(true);
  });

  it("uploads referenced images and rewrites them to the /.attachments path", async () => {
    const { api, calls } = fakeAdo();
    const out = await publish({
      org: "s", project: "P", wiki: "Docs", pagePath: "/X",
      markdown: "![ER](diagram.png)\n", api,
      attachments: [{ name: "diagram.png", bytes: new Uint8Array([1, 2, 3]) }],
    });
    expect(calls.some(c => c.urlPath.includes("/attachments?name=diagram.png"))).toBe(true);
    expect(out.content).toContain("![ER](/.attachments/diagram.png)");
  });

  it("refuses a wiki that does not exist rather than creating one", async () => {
    const api = async (method, urlPath) => {
      if (urlPath === "/wiki/wikis") return { value: [{ name: "Other" }] };
      return null;
    };
    await expect(publish({
      org: "s", project: "P", wiki: "Missing", pagePath: "/X", markdown: "y", api, verify: true,
    })).rejects.toThrow(/wiki 'Missing' does not exist/i);
  });
});

describe("rewriteImages", () => {
  it("leaves a mermaid fence alone, because ADO Wiki renders it natively", () => {
    const md = "```mermaid\ngraph TD;A-->B;\n```\n";
    expect(rewriteImages(md, [])).toBe(md);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:scripts`
Expected: FAIL — `Cannot find module './ado-publish.mjs'`.

- [ ] **Step 3: Write the script**

Create `scripts/ado-publish.mjs`:

```js
#!/usr/bin/env node
/**
 * Create or update an Azure DevOps Wiki page from a markdown file on disk.
 *
 * WHY THIS EXISTS
 * ---------------
 * The same reason `confluence-publish.mjs` did, and the lesson is worth
 * repeating rather than re-learning. Publishing agents used to read a document
 * and pass it to an MCP tool as an argument. Measured on a real run (SCY-6, 18
 * Aug 2026): the data model is 110 KB, the agent read it into context three
 * times building the call, hit a compaction thirteen minutes in, lost its place
 * and restarted the same approach — $2.73 spent, no page created.
 *
 * The document does not need to travel through a language model to reach a
 * wiki. The agent decides WHAT to publish; moving bytes is not a reasoning task.
 *
 * SIMPLER THAN CONFLUENCE, IN TWO WAYS
 * ------------------------------------
 * ADO Wiki stores MARKDOWN, so there is no storage-format conversion — the file
 * goes up as it is. And a page is identified by its PATH, so re-publishing is
 * inherently an update: no title lookup, no remembered page id, no way to end
 * up with two copies of one document.
 *
 * MERMAID: ADO Wiki renders ```mermaid fences natively, so they are left alone
 * by default and the PNG pipeline is not needed. `--render-mermaid` is the
 * fallback for diagram types the wiki's Mermaid build rejects.
 *
 * USAGE
 *   node scripts/ado-publish.mjs <file.md> --org O --project P --wiki W \
 *        --path "/Scyne/RTWSA/Data Model"
 *        [--render-mermaid]                render mermaid fences to PNG and attach
 *        [--published-json <p> --artefact-key <k>]   record {wikiPath,url,...}
 *        [--verify]                        check org/project/wiki, then publish
 *        [--json]                          machine-readable result only
 */

import fs from "node:fs/promises";
import path from "node:path";
import { loadCredentials, makeApi, wikiPageUrl, fail } from "./lib/ado.mjs";

/** Rewrite `![alt](name.png)` to the `/.attachments/` path ADO serves them from. */
export function rewriteImages(md, attachments) {
  let out = md;
  for (const a of attachments) {
    // Only bare filenames — an absolute or remote URL is the author's choice.
    const re = new RegExp(`\\]\\(\\s*${a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\)`, "g");
    out = out.replace(re, `](/.attachments/${a.name})`);
  }
  return out;
}

/**
 * Publish one page. Injectable `api` so this is testable without a network.
 *
 * Returns `{ url, pagePath, content }`.
 */
export async function publish({
  org, project, wiki, pagePath, markdown, api,
  attachments = [], verify = false, say = () => {},
}) {
  if (verify) {
    const wikis = await api("GET", "/wiki/wikis");
    const names = (wikis?.value ?? []).map(w => w.name);
    if (!names.includes(wiki)) {
      throw new Error(
        `Azure DevOps wiki '${wiki}' does not exist in ${org}/${project}, and this ` +
        `script will not create one.\n  Wikis that do exist: ${names.join(", ") || "(none)"}`);
    }
  }

  // Attachments first: a page referencing an attachment that is not there yet
  // renders as a broken image, which looks finished and is not.
  for (const a of attachments) {
    await api("PUT", `/wiki/wikis/${encodeURIComponent(wiki)}/attachments?name=${encodeURIComponent(a.name)}`,
              { body: a.bytes, contentType: "application/octet-stream" });
    say(`  attached ${a.name}`);
  }
  const content = rewriteImages(markdown, attachments);

  // Does the page exist? The ETag is what an update needs, and it only comes
  // back on the raw response.
  const pathQuery = `path=${encodeURIComponent(pagePath)}`;
  const existing = await api("GET", `/wiki/wikis/${encodeURIComponent(wiki)}/pages?${pathQuery}`, { raw: true });
  const etag = existing && existing.status === 200 ? existing.headers.get("etag") : null;

  // An If-Match on a create is rejected; a create-shaped PUT on an existing
  // page returns 409. So the header is present exactly when the page is.
  await api("PUT", `/wiki/wikis/${encodeURIComponent(wiki)}/pages?${pathQuery}`, {
    body: { content },
    ...(etag ? { headers: { "If-Match": etag } } : {}),
  });
  say(etag ? `  updated ${pagePath}` : `  created ${pagePath}`);

  return { url: wikiPageUrl(org, project, wiki, pagePath), pagePath, content };
}

// ------------------------------------------------------------------ CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const has = (n) => args.includes(`--${n}`);

  const file = args[0];
  if (!file || file.startsWith("--")) {
    fail(`usage: node scripts/ado-publish.mjs <file.md> --org O --project P --wiki W --path "/A/B"`);
  }
  const creds = await loadCredentials();
  const org = flag("org") ?? creds.org;
  const project = flag("project");
  const wiki = flag("wiki");
  const pagePath = flag("path");
  for (const [name, v] of [["org", org], ["project", project], ["wiki", wiki], ["path", pagePath]]) {
    if (!v) fail(`--${name} is required`);
  }

  const JSON_ONLY = has("json");
  const say = (m) => { if (!JSON_ONLY) console.log(m); };

  let markdown = await fs.readFile(path.resolve(file), "utf8").catch(() => fail(`File not found: ${file}`));
  const attachments = [];

  if (has("render-mermaid")) {
    const { renderMermaidToPngs } = await import("./lib/mermaid.mjs");
    const r = await renderMermaidToPngs(markdown);
    markdown = r.markdown;
    for (const f of r.files) attachments.push({ name: path.basename(f), bytes: await fs.readFile(f) });
    say(`  rendered ${r.files.length} diagram(s)`);
  }

  const api = makeApi({ org, project, auth: creds.auth });
  const out = await publish({
    org, project, wiki, pagePath, markdown, api, attachments, verify: has("verify"), say,
  });

  const publishedJson = flag("published-json");
  const artefactKey = flag("artefact-key");
  if (publishedJson && artefactKey) {
    // Written here rather than left to the agent: it is the record that makes
    // the NEXT revision an update, and a step the model can forget is a step
    // that eventually gets forgotten.
    const p = path.resolve(publishedJson);
    let existing = {};
    try { existing = JSON.parse(await fs.readFile(p, "utf8")); } catch { /* first publish */ }
    existing[artefactKey] = { wikiPath: pagePath, url: out.url, wiki, project, org };
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(existing, null, 2) + "\n");
    say(`  recorded ${artefactKey} in ${publishedJson}`);
  }

  if (JSON_ONLY) console.log(JSON.stringify({ url: out.url, pagePath: out.pagePath }));
  else console.log(out.url);
}
```

- [ ] **Step 4: Move the mermaid renderer into a shared lib**

`renderMermaid` currently lives inside `scripts/confluence-publish.mjs:101`. Move it to `scripts/lib/mermaid.mjs`, exported as `renderMermaidToPngs(md)` returning `{ markdown, files }`, with its comments intact. The old script is archived in Task 8, so this must happen before it moves.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:scripts`
Expected: PASS, all six cases.

- [ ] **Step 6: Checkpoint**

Stop.

---

### Task 3: Push stories as work items

**Files:**
- Create: `scripts/ado-workitems.mjs`
- Test: `scripts/ado-workitems.test.mjs`

**Interfaces:**
- Consumes: `makeApi`, `loadCredentials` from `scripts/lib/ado.mjs`.
- Produces: `export async function pushStories({ stories, org, project, api, parentId, summaryUrl })` → `Array<{ storyNumber, id, url }>`.

**Input shape.** `stories.json` is a flat array of Jira REST payloads: `[{ fields: { summary, description, issuetype: { name } } }]` — confirmed against `projects/SAPN_DEMO/interiam-benifits/outputs/stories.json`. It is **not** being changed: `render-companion-app.mjs:619` already reads `s?.fields?.summary ?? s?.summary`, the BA skill and its examples stay untouched, and the container shape carries no Jira semantics this script cannot map. The story number is the leading token of `fields.summary` (house style: `<L4.N.M> As a …`).

- [ ] **Step 1: Write the failing test**

Create `scripts/ado-workitems.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { pushStories, toPatch, storyNumberOf } from "./ado-workitems.mjs";

const story = {
  fields: {
    summary: "2.4.1.1 As an Eligibility Officer, I want to review evidence, So that claims are assessed.",
    description: "As an EO...\n\n*Acceptance Criteria (AC):*\n* The officer can open the evidence.",
  },
};

describe("toPatch", () => {
  it("maps the Jira container onto work item fields", () => {
    const ops = toPatch(story, { summaryUrl: "https://dev.azure.com/x" });
    const byPath = Object.fromEntries(ops.map(o => [o.path, o.value]));
    expect(byPath["/fields/System.Title"]).toContain("2.4.1.1 As an Eligibility Officer");
    expect(byPath["/fields/System.Description"]).toContain("evidence");
    expect(ops.every(o => o.op === "add")).toBe(true);
  });

  it("substitutes the summary URL rather than leaving the placeholder in the client's backlog", () => {
    // The engine's interpolator once matched the inner {PRODUCT_SUMMARY_URL} of
    // the doubled brace and blocked every requirements run at publish, right
    // after a human had approved its gate. Doing the replace here takes the
    // whole class of failure away from the model.
    const withPlaceholder = {
      fields: { summary: "1.1 As a user...", description: "See {{PRODUCT_SUMMARY_URL}} for detail." },
    };
    const ops = toPatch(withPlaceholder, { summaryUrl: "https://dev.azure.com/scyne/_wiki/x" });
    const desc = ops.find(o => o.path === "/fields/System.Description").value;
    expect(desc).toContain("https://dev.azure.com/scyne/_wiki/x");
    expect(desc).not.toContain("PRODUCT_SUMMARY_URL");
  });

  it("links to the parent epic only when one is given", () => {
    expect(toPatch(story, {}).some(o => o.path === "/relations/-")).toBe(false);
    const linked = toPatch(story, { org: "scyne", parentId: "77" });
    const rel = linked.find(o => o.path === "/relations/-").value;
    expect(rel.rel).toBe("System.LinkTypes.Hierarchy-Reverse");
    expect(rel.url).toBe("https://dev.azure.com/scyne/_apis/wit/workItems/77");
  });
});

describe("storyNumberOf", () => {
  it("takes the leading house-style number off the summary", () => {
    expect(storyNumberOf(story)).toBe("2.4.1.1");
  });
  it("returns null when the summary carries no number", () => {
    expect(storyNumberOf({ fields: { summary: "As a user, I want..." } })).toBeNull();
  });
});

describe("pushStories", () => {
  it("creates one work item per story with the JSON-Patch content type", async () => {
    const calls = [];
    const api = async (method, urlPath, opts) => {
      calls.push({ method, urlPath, opts });
      return { id: calls.length, _links: { html: { href: `https://ado/wi/${calls.length}` } } };
    };
    const out = await pushStories({ stories: [story, story], org: "s", project: "P", api });
    expect(out).toHaveLength(2);
    expect(calls[0].urlPath).toContain("/wit/workitems/$User%20Story");
    expect(calls[0].opts.contentType).toBe("application/json-patch+json");
  });

  it("updates an existing work item instead of duplicating on a re-run", async () => {
    const withId = { ...story, adoWorkItemId: 42 };
    const calls = [];
    const api = async (method, urlPath, opts) => {
      calls.push({ method, urlPath, opts });
      return { id: 42, _links: { html: { href: "https://ado/wi/42" } } };
    };
    await pushStories({ stories: [withId], org: "s", project: "P", api });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].urlPath).toContain("/wit/workitems/42");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:scripts`
Expected: FAIL — `Cannot find module './ado-workitems.mjs'`.

- [ ] **Step 3: Write the script**

Create `scripts/ado-workitems.mjs`:

```js
#!/usr/bin/env node
/**
 * Push a feature's user stories into Azure DevOps as User Story work items.
 *
 * Replaces the per-story MCP tool-call loop the publish prompt used to
 * describe. Stories are small enough to pass through a tool call — the reason
 * this is a script anyway is the placeholder substitution: the prompt used to
 * tell the model to replace `{{PRODUCT_SUMMARY_URL}}` in each description, and
 * that doubled brace exists ONLY because the engine's interpolator once matched
 * the inner `{PRODUCT_SUMMARY_URL}`, missed, and threw — blocking every
 * requirements run at publish, immediately after a human had approved its gate.
 * A string replace in a script cannot forget, and cannot be interpolated by
 * accident.
 *
 * INPUT is `outputs/stories.json` as the BA writes it: a flat array of Jira
 * REST payloads. That shape is not being changed — it is a container, the
 * companion app already reads it defensively, and rewriting it would mean
 * touching the skill, its examples and the renderer to gain nothing.
 *
 * IDEMPOTENT: the work item id is written back into stories.json, so a re-run
 * updates rather than creating a second backlog.
 *
 * USAGE
 *   node scripts/ado-workitems.mjs <stories.json> --org O --project P \
 *        [--parent <epicId>] [--summary-url <url>] [--json]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { loadCredentials, makeApi, fail } from "./lib/ado.mjs";

/** House style: `<L4.N.M> As a <role>, I want …`. */
export function storyNumberOf(story) {
  const m = /^([\d.]+)\s/.exec(story?.fields?.summary ?? "");
  return m ? m[1] : null;
}

/**
 * One story → a JSON-Patch document.
 *
 * `System.Description` takes HTML, which is ADO's rich-text format — not
 * Atlassian Document Format, and not markdown. The BA's descriptions are plain
 * text with light wiki markup, so newlines become `<br>` and nothing else is
 * interpreted: inventing a markdown parse here would silently mangle a
 * client's acceptance criteria.
 */
export function toPatch(story, { summaryUrl, parentId, org } = {}) {
  const f = story.fields ?? {};
  const sub = (s) => String(s ?? "").replaceAll("{{PRODUCT_SUMMARY_URL}}", summaryUrl ?? "");
  const html = (s) => sub(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  const ops = [
    { op: "add", path: "/fields/System.Title", value: sub(f.summary).slice(0, 255) },
    { op: "add", path: "/fields/System.Description", value: html(f.description) },
  ];
  if (f.acceptanceCriteria) {
    ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria",
               value: html(f.acceptanceCriteria) });
  }
  if (parentId) {
    ops.push({ op: "add", path: "/relations/-", value: {
      rel: "System.LinkTypes.Hierarchy-Reverse",
      url: `https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workItems/${parentId}`,
    }});
  }
  return ops;
}

export async function pushStories({ stories, org, project, api, parentId, summaryUrl, say = () => {} }) {
  const results = [];
  for (const story of stories) {
    const ops = toPatch(story, { summaryUrl, parentId, org });
    const existingId = story.adoWorkItemId;

    // PATCH an existing item, POST a new one. Same body either way — JSON-Patch
    // `add` on a field is an upsert.
    const res = existingId
      ? await api("PATCH", `/wit/workitems/${existingId}`,
                  { body: ops, contentType: "application/json-patch+json" })
      : await api("POST", `/wit/workitems/${encodeURIComponent("$User Story")}`,
                  { body: ops, contentType: "application/json-patch+json" });

    story.adoWorkItemId = res.id;
    const url = res?._links?.html?.href ?? `https://dev.azure.com/${org}/${project}/_workitems/edit/${res.id}`;
    results.push({ storyNumber: storyNumberOf(story), id: res.id, url });
    say(`  ${existingId ? "updated" : "created"} #${res.id}  ${storyNumberOf(story) ?? ""}`);
  }
  return results;
}

// ------------------------------------------------------------------ CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const has = (n) => args.includes(`--${n}`);

  const file = args[0];
  if (!file || file.startsWith("--")) {
    fail(`usage: node scripts/ado-workitems.mjs <stories.json> --org O --project P [--parent <id>]`);
  }
  const creds = await loadCredentials();
  const org = flag("org") ?? creds.org;
  const project = flag("project");
  if (!project) fail("--project is required");

  const JSON_ONLY = has("json");
  const say = (m) => { if (!JSON_ONLY) console.log(m); };

  const p = path.resolve(file);
  const stories = JSON.parse(await fs.readFile(p, "utf8").catch(() => fail(`File not found: ${file}`)));
  const api = makeApi({ org, project, auth: creds.auth });

  const out = await pushStories({
    stories, org, project, api, parentId: flag("parent"), summaryUrl: flag("summary-url"), say,
  });

  // Write the ids back so the next run updates rather than duplicating.
  await fs.writeFile(p, JSON.stringify(stories, null, 2) + "\n");

  if (JSON_ONLY) { console.log(JSON.stringify(out)); }
  else {
    console.log(`\n| story_number | work_item_id | url |`);
    console.log(`|---|---|---|`);
    for (const r of out) console.log(`| ${r.storyNumber ?? "—"} | ${r.id} | ${r.url} |`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:scripts`
Expected: PASS, all six cases.

- [ ] **Step 5: Checkpoint**

Stop.

---

### Task 4: Rewrite the publish prompt

**Files:**
- Modify: `orchestrator.workflows.ts:43,73-153` (`primaryDoc`, `approvalSummary`, `publishPrompt`)
- Create: `orchestrator.workflows.test.ts` (repo root — see below)

> **The test lives at the repo root, not in `packages/orchestrator/test/`.**
> Nothing under `packages/orchestrator/` may import `orchestrator.workflows.ts`
> — that boundary is what keeps the library generic and this repo merely its
> first consumer. A test is not an exception. Task 1 added a root vitest suite;
> widen its `include` to collect this file:
>
> ```ts
> include: ["scripts/**/*.test.mjs", "*.test.ts"],
> ```

**Interfaces:**
- Consumes: the CLI contracts of Tasks 2 and 3.
- Produces: workflow params `adoOrg`, `adoProject`, `adoWiki`, `adoParentEpicId` in place of `confluenceSpace`, `jiraProjectKey`, `parentEpicKey`. `workflowParams()` derives these by scanning, so nothing else declares them.

- [ ] **Step 1: Write the failing test**

Create `orchestrator.workflows.test.ts` at the repo root:

```ts
import { describe, it, expect } from "vitest";
import { buildWorkflows } from "./orchestrator.workflows.js";
import { workflowParams } from "./packages/orchestrator/src/config.js";

describe("publish prompts", () => {
it("asks for the Azure DevOps params, and no Atlassian ones", () => {
  const wf = buildWorkflows().find(w => w.key === "requirements")!;
  const params = workflowParams(wf);
  expect(params).toContain("adoProject");
  expect(params).toContain("adoWiki");
  expect(params).not.toContain("confluenceSpace");
  expect(params).not.toContain("jiraProjectKey");
});

it("keeps the doubled brace out of the publish prompt entirely", () => {
  // `{{PRODUCT_SUMMARY_URL}}` only ever existed to survive interpolation. The
  // substitution now happens in ado-workitems.mjs, so the prompt must not
  // mention it — and workflowParams must not surface it as something to ask a
  // caller for.
  const wf = buildWorkflows().find(w => w.key === "requirements")!;
  const publish = wf.steps.find(s => s.type === "agent" && s.phase === "publish") as any;
  expect(publish.prompt).not.toContain("PRODUCT_SUMMARY_URL");
  expect(workflowParams(wf)).not.toContain("PRODUCT_SUMMARY_URL");
});

it("names the scripts rather than describing the steps to a model", () => {
  for (const wf of buildWorkflows()) {
    const publish = wf.steps.find(s => s.type === "agent" && (s as any).phase === "publish") as any;
    if (!publish) continue;
    expect(publish.prompt).toContain("ado-publish.mjs");
    expect(publish.prompt).not.toMatch(/Confluence|Jira/i);
  }
});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:scripts`
Expected: FAIL — `confluenceSpace` is still in the param list.

- [ ] **Step 3: Rewrite `publishPrompt`**

Replace `publishPrompt` in `orchestrator.workflows.ts` (currently lines 89-153):

```ts
function publishPrompt(key: string, s: Stage): string {
  const stories = key === "requirements";
  return [
    `A human has APPROVED the ${s.label} for ${scope(s)}. Publish it to Azure DevOps.`,
    ``,
    `## Do it with one command`,
    ``,
    `From the workspace root:`,
    ``,
    `    node scripts/ado-publish.mjs \\`,
    `      ${primaryDoc(s)} \\`,
    `      --org <ORG> --project <PROJECT> --wiki <WIKI> --verify \\`,
    `      --path "<PAGE PATH>" \\`,
    `      --published-json projects/{project}/.published.json \\`,
    `      --artefact-key "${artefactKeyTpl(key, s)}"`,
    ``,
    `That single command uploads any diagrams, creates or updates the page, and`,
    `records where it went. **Do not do any of those steps yourself.** In`,
    `particular, never read the document in order to pass it to a tool as a page`,
    `body: these documents run to 110 KB, and doing that burns the context`,
    `window, triggers a compaction mid-task, and ends in a loop that publishes`,
    `nothing. That is measured behaviour, not a caution.`,
    ``,
    `Leave \`\`\`mermaid fences alone — ADO Wiki renders them. Add`,
    `\`--render-mermaid\` only if the page comes back reporting a diagram it`,
    `could not parse.`,
    ``,
    `## The values you choose`,
    ``,
    `- **ORG**: the \`adoOrg\` parameter if one is listed, otherwise \`ADO_ORG\``,
    `  from the environment — omit the flag and the script reads it.`,
    `- **PROJECT**: the \`adoProject\` parameter if listed, otherwise the project`,
    `  name. **WIKI**: the \`adoWiki\` parameter if listed, otherwise`,
    `  \`<PROJECT>.wiki\`, which is what ADO names a project wiki by default.`,
    `- If \`--verify\` reports the project or wiki does not exist, report that`,
    `  verbatim and stop. Do not substitute another one: publishing a client's`,
    `  document into the wrong place is worse than not publishing it.`,
    `- **PAGE PATH**: \`/Scyne/{project}/${s.label}\`${isProject(s) ? "." : ' with "/{feature}" before the label.'}`,
    `  Keep it identical between runs — the path IS the page's identity, and`,
    `  that is what stops a revision creating a second copy.`,
    ...(stories ? [
      ``,
      `## Then push the stories`,
      ``,
      `    node scripts/ado-workitems.mjs \\`,
      `      projects/{project}/{feature}/outputs/stories.json \\`,
      `      --org <ORG> --project <PROJECT> \\`,
      `      --summary-url <the URL the first command printed>`,
      ``,
      `Add \`--parent <id>\` ONLY if the \`adoParentEpicId\` parameter is listed`,
      `and non-empty. The script writes each work item id back into stories.json,`,
      `so running it twice updates the backlog rather than duplicating it.`,
    ] : []),
    ``,
    `## Finish`,
    ``,
    `Print the wiki URL on a line of its own as the last thing you`,
    `output${stories ? ", preceded by the story table the second command printed" : ""}.`,
    `Do not change any issue status — the orchestrator moves the issue on when`,
    `you exit cleanly.`,
  ].join("\n");
}
```

Update `approvalSummary` (line 82) and the comment at line 43:

```ts
      ? `Approving publishes it to Azure DevOps. Rejecting sends it back to the ${s.agentKey} to regenerate.`
```

```ts
/** The primary document of a stage — the one that becomes a wiki page. */
```

And the revise gate summary (line 243):

```ts
        ? `Approving UPDATES the existing wiki page rather than creating a second one.`
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Read one generated prompt back**

```bash
npm run serve &
sleep 5
curl -s http://127.0.0.1:3100/workflows/requirements | python3 -m json.tool | head -60
kill %1
```
Expected: the publish step's prompt names `ado-publish.mjs`, and no occurrence of "Confluence", "Jira" or "PRODUCT_SUMMARY_URL".

- [ ] **Step 6: Checkpoint**

Stop.

---

### Task 5: Route the new params through the chatbot

**Files:**
- Modify: `scyne-chatbot/server/orchestrator.ts:33-46`
- Modify: `scyne-chatbot/server/index.ts` (the description blocks naming Confluence/Jira)
- Modify: `scripts/check-routing.mts`
- Modify: `.env`, `scyne-chatbot/.env`

**Interfaces:**
- Consumes: the param names Task 4 introduced.
- Produces: `PARAM_LABELS` entries `"ado org" → adoOrg`, `"ado project" → adoProject`, `"ado wiki" → adoWiki`, `"ado parent epic id" → adoParentEpicId`.

- [ ] **Step 1: Write the failing check**

In `scripts/check-routing.mts`, replace the requirements case's description and add an assertion:

```ts
  ["Generate requirements — Review & Verify Evidence (SADA/interim-benefit)",
   "## Project + Feature\n- Project: SADA\n- Feature: interim-benefit\n\n## Parameters\n- Process L3: 2.4 Review\n- ADO parent epic id: (none — create stories without a parent epic)\n- ADO project: SADA\n- ADO wiki: SADA.wiki",
   "requirements"],
```

and, beside the existing assertions, add:

```ts
// The Atlassian param names are gone. A leftover would parse into a param no
// workflow interpolates, which `workflowParams` would not surface and nothing
// would reject — it would simply never reach the prompt.
for (const [title, description] of cases) {
  const params = parseParams(description);
  for (const dead of ["confluenceSpace", "jiraProjectKey", "parentEpicKey", "confluencePageTitle"]) {
    if (dead in params) throw new Error(`${title}: still parses the retired param '${dead}'`);
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run check:routing`
Expected: FAIL — the ADO labels are not in `PARAM_LABELS`, so `adoProject` never appears.

- [ ] **Step 3: Update the label map**

In `scyne-chatbot/server/orchestrator.ts`, replace the four Atlassian entries:

```ts
  "ado org": "adoOrg",
  "ado project": "adoProject",
  "ado wiki": "adoWiki",
  "ado parent epic id": "adoParentEpicId",
```

Update the doc comment above it:

```ts
/** `- ADO project: Delivery` → `adoProject: "Delivery"`. */
```

- [ ] **Step 4: Update the descriptions the chatbot builds**

In `scyne-chatbot/server/index.ts`, find every description block containing "Confluence space key" / "Jira project key" / "Parent epic key" and replace with the ADO labels. Defaults follow the existing per-project rule: the ADO project defaults to the project name, the wiki to `<project>.wiki`, and the parent epic is omitted unless configured.

In both `.env` files, replace the Atlassian defaults:

```
ADO_ORG=<your org>
ADO_PAT=<PAT with Wiki read/write + Work Items read/write>
DEFAULT_ADO_PROJECT=SADA
DEFAULT_ADO_WIKI=SADA.wiki
DEFAULT_ADO_PARENT_EPIC_ID=
```

Delete `DEFAULT_PARENT_EPIC_KEY`, `DEFAULT_JIRA_PROJECT_KEY`, `DEFAULT_CONFLUENCE_SPACE_KEY`, `DEFAULT_CONFLUENCE_PAGE_TITLE`, and the `ATLASSIAN_*` block.

- [ ] **Step 5: Run the check to verify it passes**

Run: `npm run check:routing`
Expected: PASS, every case, with no retired param parsed.

- [ ] **Step 6: Checkpoint**

Stop.

---

### Task 6: Verify the ADO target at approval time, and never create one

`atlassianProvision.ts` CREATES a missing Jira project or Confluence space at approval. ADO project creation is a long-running async operation, and a half-created project is worse than a clear refusal — so the replacement verifies and reports.

**Files:**
- Create: `scyne-chatbot/server/services/adoVerify.ts`
- Delete: `scyne-chatbot/server/services/atlassianProvision.ts`
- Modify: the `/api/approve/:approvalId` handler in `scyne-chatbot/server/index.ts`

**Interfaces:**
- Consumes: `loadCredentials`, `makeApi` from `scripts/lib/ado.mjs`.
- Produces: `export async function verifyAdoTargets(params: { adoOrg?: string; adoProject?: string; adoWiki?: string }): Promise<{ ok: true } | { ok: false; reason: string }>`.

- [ ] **Step 1: Write the verifier**

```ts
// Confirm an approval's Azure DevOps target exists, before the publish step runs.
//
// The Atlassian version of this CREATED missing targets. This one does not, and
// the difference is deliberate: creating an ADO project is a long-running async
// operation whose half-finished state is worse than a clear refusal, and a
// client's org is not a place to make things speculatively.
//
// SOFT-FAIL, exactly as the Atlassian version did: an auth or lookup problem
// skips verification and lets the publish step report the real error. Only a
// definitive "the target is not there" holds the gate. A stale credential must
// never block an approval whose target exists.
export async function verifyAdoTargets(
  params: { adoOrg?: string; adoProject?: string; adoWiki?: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const creds = await loadCredentials();
    const org = params.adoOrg ?? creds.org;
    const project = params.adoProject;
    if (!org || !project) return { ok: true };   // nothing named — the prompt defaults it

    const api = makeApi({ org, project, auth: creds.auth });
    const wikis = await api("GET", "/wiki/wikis");
    if (wikis === null) {
      return { ok: false, reason: `Azure DevOps project '${org}/${project}' does not exist.` };
    }
    const wiki = params.adoWiki ?? `${project}.wiki`;
    const names = (wikis.value ?? []).map((w: { name: string }) => w.name);
    if (!names.includes(wiki)) {
      return { ok: false,
        reason: `Wiki '${wiki}' does not exist in ${org}/${project}. Wikis present: ${names.join(", ") || "(none)"}. ` +
                `Create it in Azure DevOps — this pipeline will not create one.` };
    }
    return { ok: true };
  } catch {
    // Auth or network. Let the publish step produce the real error.
    return { ok: true };
  }
}
```

- [ ] **Step 2: Swap the call site**

In `/api/approve/:approvalId`, replace the `ensureAtlassianTargets` call with `verifyAdoTargets`, keeping the same failure shape (a definitive miss holds the gate with `502`; anything else proceeds). Delete `atlassianProvision.ts`.

- [ ] **Step 3: Verify by hand**

```bash
cd scyne-chatbot && npx tsx -e "
import { verifyAdoTargets } from './server/services/adoVerify.ts';
console.log(await verifyAdoTargets({ adoProject: 'DefinitelyNotAProject' }));
console.log(await verifyAdoTargets({}));
"
```
Expected: the first reports `ok: false` with a reason naming the project (or `ok: true` if no PAT is configured — the soft-fail path); the second `ok: true`.

- [ ] **Step 4: Checkpoint**

Stop.

---

### Task 7: Rewrite the agent bundles

Eight `agent-instructions/*.thin.md` files name Confluence or Jira. They are read from disk at spawn time, so an edit is live with nothing to re-push.

**Files:**
- Modify: `agent-instructions/{ba,architect-lead,qa-architect,capabilities-process-architect,service-designer,data-modeler,solution-architect,ux-designer}.thin.md`

- [ ] **Step 1: Find every mention**

```bash
grep -rln "Confluence\|Jira\|confluence-publish\|confluence-attach\|atlassian" agent-instructions/*.thin.md
```

- [ ] **Step 2: Rewrite each, one at a time**

For each file, replace the publishing paragraph with:

```markdown
Publishing goes to **Azure DevOps**, and always through the scripts:
`node scripts/ado-publish.mjs` for a wiki page, `node scripts/ado-workitems.mjs`
for the backlog. Never read a document in order to pass it to a tool as a page
body — these run to 110 KB and it ends in a compaction loop that publishes
nothing.

Leave ```mermaid fences as they are. ADO Wiki renders them.
```

Do NOT touch anything else in these files — the domain instructions are the
point of them and are unrelated to where output lands.

- [ ] **Step 3: Verify nothing is left**

```bash
grep -rn "Confluence\|Jira\|atlassian" agent-instructions/*.thin.md
```
Expected: no output. (`agent-instructions/legacy/` is excluded — it is the archived Paperclip-era record and stays as it is.)

- [ ] **Step 4: Checkpoint**

Stop.

---

### Task 8: Archive Atlassian, and document the swap

**Files:**
- Move: `scripts/confluence-publish.mjs`, `scripts/confluence-attach.mjs`, `scripts/lib/atlassian.mjs` → `scripts/legacy-atlassian/`
- Create: `scripts/legacy-atlassian/README.md`
- Modify: `.mcp.json`, `package.json` (the `oauth` script), `CLAUDE.md`

- [ ] **Step 1: Archive rather than delete**

```bash
mkdir -p scripts/legacy-atlassian
git mv scripts/confluence-publish.mjs scripts/confluence-attach.mjs scripts/legacy-atlassian/
git mv scripts/lib/atlassian.mjs scripts/legacy-atlassian/
```

Create `scripts/legacy-atlassian/README.md`:

```markdown
# Atlassian publishing — retired 20 Aug 2026

Replaced by `scripts/ado-publish.mjs` and `scripts/ado-workitems.mjs` when
delivery moved to Azure DevOps.

Kept, not deleted, following the `legacy-react-scaffold/` precedent: these are
the only remaining record of two things worth not re-learning.

**The MCP has no attachment scope, and never will.** The OAuth grant
`mcp-remote` obtains carries 20 scopes, 8 of them Confluence, none for
attachments — so `POST .../child/attachment` returns `401 scope does not match`,
and a raw curl reusing that token fails the same way. `confluence-attach.mjs`
existed entirely because of that. Azure DevOps has no equivalent problem: the
PAT covers wiki attachments directly.

**A document must not travel through a model to reach a page.** Measured on
SCY-6, 18 Aug 2026: 110 KB read three times, compaction at thirteen minutes,
$2.73 spent, no page created. `ado-publish.mjs` is shaped by that measurement.
```

- [ ] **Step 2: Drop the Atlassian MCP**

Replace `.mcp.json` with:

```json
{
  "mcpServers": {}
}
```

No ADO MCP is registered. Both publishing scripts use the REST API with the
PAT, so an MCP would add only lookups, which `--verify` answers more cheaply —
and the official `@azure-devops/mcp` authenticates through Azure CLI login
rather than a PAT, so `ADO_PAT` would not be what it used. `mcpEnabled` stays on
the agent specs and in both runners, so wiring one later is configuration.

Remove the `oauth` script from the root `package.json`.

- [ ] **Step 3: Update CLAUDE.md**

Rewrite these sections, each of which currently asserts something now false:

1. The blockquote under "What this project is" about Mermaid → PNG and the MCP attachment scope → replace with a note that ADO Wiki renders mermaid natively and attachments go through the PAT.
2. "Publishing" under How it runs → `ado-publish.mjs`, path identity, `.published.json`'s new shape.
3. "The Atlassian MCP" section → delete, replaced by a short "Azure DevOps" section covering the PAT, the two scripts and the no-MCP decision.
4. The endpoint/param tables mentioning `confluenceSpace` / `jiraProjectKey`.
5. Helper-scripts list → `ado-publish.mjs`, `ado-workitems.mjs`, `lib/ado.mjs`, `lib/mermaid.mjs`; `confluence-*` moved to legacy.
6. Troubleshooting table → replace the "Published Confluence page has no diagrams" and "Atlassian MCP OAuth fails" rows with:

```markdown
| `Azure DevOps did not authenticate the request` | The PAT is missing, expired (ADO PATs last at most a year), or lacks scope. | Regenerate at `https://dev.azure.com/<org>/_usersSettings/tokens` with Wiki (Read & Write) and Work Items (Read, write & manage); update `ADO_PAT` in the root `.env`. |
| A wiki page publishes but a diagram shows as raw code | ADO Wiki's Mermaid build rejected that diagram type. | Re-run the publish with `--render-mermaid`, which renders to PNG and attaches instead. |
| A revision created a second wiki page | The `--path` differed between runs — the path IS the page's identity. | Check `projects/<p>/.published.json` for the recorded `wikiPath` and republish with it. |
```

- [ ] **Step 4: Verify nothing still calls the archived scripts**

```bash
grep -rn "confluence-publish\|confluence-attach\|lib/atlassian" \
  --include="*.ts" --include="*.mts" --include="*.mjs" --include="*.md" . \
  | grep -v node_modules | grep -v "scripts/legacy-atlassian" | grep -v "docs/superpowers"
```
Expected: no output.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run check:routing`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Stop.

---

### Task 9: End-to-end acceptance

**Files:** none — verification. Anything it uncovers is fixed in the task that owns the file.

**Prerequisite:** the real org, project and wiki names, and a PAT with Wiki read/write and Work Items read/write in the root `.env`.

- [ ] **Step 1: Verify the target before spending a run**

```bash
node scripts/ado-publish.mjs README.md --org <ORG> --project <PROJECT> \
     --wiki <WIKI> --path "/Scyne/_scratch" --verify
```
Expected: prints a wiki URL. If it refuses, it names which of org/project/wiki was wrong — fix that before going further.

- [ ] **Step 2: Publish a real stage**

```bash
npm run orch -- run datamodel --project SADA --feature interim-benefit \
  --adoProject <PROJECT> --adoWiki <WIKI>
npm run orch -- gate list
npm run orch -- gate approve <id>
```

- [ ] **Step 3: Verify each claim, with output**

| Claim | How | Expected |
|---|---|---|
| The page exists | open the URL the publish step printed | the data model, headings intact |
| Mermaid rendered | look at the ER diagram on the page | a diagram, not a code fence |
| Identity was recorded | `cat projects/SADA/.published.json` | an entry with `wikiPath`, `url`, `wiki`, `project`, `org` |
| A revision updates in place | `npm run orch -- run revise-datamodel --project SADA --feature interim-benefit --instruction "Add an SLA breach field."` then approve | the SAME URL, one page, new content |
| Stories reach the backlog | run `requirements` end to end | one User Story work item per story, under the epic if one was given |
| Re-running does not duplicate | run `ado-workitems.mjs` again on the same file | every line says `updated`, no new ids |

- [ ] **Step 4: Report honestly**

Write down what happened, including anything that failed or was skipped.

- [ ] **Step 5: Checkpoint**

Stop. Hand back for review and commit.
