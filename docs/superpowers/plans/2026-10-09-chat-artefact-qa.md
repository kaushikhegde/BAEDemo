# Chat Artefact Q&A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The chat answers questions about any generated artefact from the real file, and a revision it proposes starts only when the user clicks **Start change**.

**Architecture:** A new server module resolves `(project, feature, artefact)` to a fixed list of files and reads them, scoped to the projects the caller can see. A second module runs a small loop over a Gemini chat session: while the model only asks to read artefacts, the server reads them and sends the results back, at most three rounds, then the final turn goes to the browser as today. In the browser, `revise_artefact` becomes a confirmation card instead of an immediate call.

**Tech Stack:** TypeScript, Express, `@google/generative-ai` 0.21 (`ChatSession.sendMessage` with `functionResponse` parts), React + Vite, vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-chat-artefact-qa-design.md`

## Global Constraints

- All paths below are relative to `scyne-chatbot/` unless they start with `docs/` or `scripts/`.
- Run tests from `scyne-chatbot/`: `npx vitest run <file>`. Full suite: `npm test`. Types: `npm run typecheck`.
- Read only these files, never a path from the model: the table in Task 1.
- Content cap: `MAX_ARTEFACT_BYTES = 200_000`.
- Read rounds cap: `MAX_READ_ROUNDS = 3`.
- Card copy: "about 15 min, about $1.50".
- After touching `server/llm.ts`: `npm run check:routing` from the workspace root must pass.
- Commit after each task. Never push. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Code comments follow the repo's style: explain why, in full sentences, like the surrounding code.

## Review Focus

1. **Feature-level question with no feature chosen** ("what tests do we have?" on a project-only target). Expected: the bot asks which feature, it does not guess one. Pinned by Task 1's "feature-level artefact without a feature" test.
2. **Gemini refusing text after an unanswered function call.** Expected: at the round limit the server answers the pending calls with a `limit` function response instead of sending plain text. Pinned by Task 2's "stops after three rounds" test.
3. **A turn that mixes a read with prose** ("Let me check…" + `read_artefact`). Expected: the prose is dropped and the answer arrives after the read. Pinned by Task 2's "drops text that came with a read" test.
4. **Double-click on Start change.** Expected: one revision. Pinned by Task 4's `claimProposal` test (only a `pending` card can be claimed).
5. **A name like `../Secret` or `__proto__`.** Expected: `invalid`, nothing read. Pinned by Task 1's path and prototype tests.

---

### Task 1: Artefact reader

**Files:**
- Create: `server/artefact-reader.ts`
- Test: `server/artefact-reader.test.ts`

**Interfaces:**
- Consumes: `pipeline.SAFE_NAME`, `pipeline.RESERVED_FEATURE_NAMES` from `../../scripts/pipeline.mjs` (typed by `server/pipeline.d.ts`).
- Produces:
  - `ARTEFACTS: Record<ArtefactKey, { level: "project" | "feature"; files: readonly string[] }>`
  - `type ArtefactKey = "capabilities" | "personas" | "requirements" | "ui" | "datamodel" | "architecture" | "qa" | "design"`
  - `MAX_ARTEFACT_BYTES = 200_000`
  - `type ArtefactRead = { state: "ok"; artefact: ArtefactKey; files: string[]; content: string; truncated: boolean } | { state: "not_generated"; artefact: ArtefactKey; files: string[] } | { state: "invalid"; reason: string }`
  - `interface ReadScope { workspace: string; visible: Record<string, { name: string }[]> }`
  - `readArtefact(args: { project?: unknown; feature?: unknown; artefact?: unknown }, scope: ReadScope): Promise<ArtefactRead>`

- [ ] **Step 1: Write the failing test**

```ts
// server/artefact-reader.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readArtefact, MAX_ARTEFACT_BYTES, type ReadScope } from "./artefact-reader.js";

/**
 * The chat reads generated artefacts to answer questions about them. It may
 * only read the fixed files a stage produces, only for a project the caller
 * can already see, and never a path the model made up.
 */

let ws: string;
const visible = { BAE: [{ name: "intake" }], Empty: [] };
const scope = (): ReadScope => ({ workspace: ws, visible });

async function put(rel: string, body: string) {
  const file = path.join(ws, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "artefact-reader-"));
  await put("projects/BAE/solutions/Capabilities/outputs/capability-process.md", "# Capabilities\nL1.1 Source to Pay");
  await put("projects/BAE/intake/outputs/product-summary.md", "# Summary");
  await put("projects/BAE/intake/outputs/stories.md", "# Stories");
  await put("projects/BAE/intake/solutions/QA/outputs/test-cases.md", "x".repeat(MAX_ARTEFACT_BYTES + 10));
  await put("projects/Secret/solutions/Capabilities/outputs/capability-process.md", "secret");
});

afterAll(() => fs.rm(ws, { recursive: true, force: true }));

describe("readArtefact", () => {
  it("reads a project-level artefact", async () => {
    const r = await readArtefact({ project: "BAE", artefact: "capabilities" }, scope());
    expect(r).toMatchObject({ state: "ok", files: ["solutions/Capabilities/outputs/capability-process.md"], truncated: false });
    expect(r.state === "ok" && r.content).toContain("L1.1 Source to Pay");
  });

  it("joins every file of a multi-file artefact", async () => {
    const r = await readArtefact({ project: "BAE", feature: "intake", artefact: "requirements" }, scope());
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.files).toEqual(["outputs/product-summary.md", "outputs/stories.md"]);
    expect(r.content).toContain("# Summary");
    expect(r.content).toContain("# Stories");
  });

  it("says not_generated when the stage has not run", async () => {
    const r = await readArtefact({ project: "BAE", artefact: "personas" }, scope());
    expect(r).toEqual({ state: "not_generated", artefact: "personas", files: ["solutions/Experience/outputs/personas-journeys.md"] });
  });

  it("asks for a feature when a feature-level artefact has none", async () => {
    const r = await readArtefact({ project: "BAE", artefact: "qa" }, scope());
    expect(r.state).toBe("invalid");
    expect(r.state === "invalid" && r.reason).toMatch(/which feature/i);
  });

  it("refuses a project the caller cannot see", async () => {
    const r = await readArtefact({ project: "Secret", artefact: "capabilities" }, scope());
    expect(r.state).toBe("invalid");
    expect(r).not.toHaveProperty("content");
  });

  it("refuses path tricks in either name", async () => {
    for (const args of [
      { project: "../Secret", artefact: "capabilities" },
      { project: "BAE", feature: "../../Secret", artefact: "qa" },
      { project: "BAE", feature: "..", artefact: "qa" },
    ]) {
      expect((await readArtefact(args, scope())).state).toBe("invalid");
    }
  });

  it("refuses a feature the project does not have", async () => {
    expect((await readArtefact({ project: "BAE", feature: "nope", artefact: "qa" }, scope())).state).toBe("invalid");
  });

  it("refuses an unknown artefact, including prototype keys", async () => {
    for (const artefact of ["wiki", "__proto__", "toString", ""]) {
      const r = await readArtefact({ project: "BAE", artefact }, scope());
      expect(r.state).toBe("invalid");
    }
  });

  it("caps a large artefact and says so", async () => {
    const r = await readArtefact({ project: "BAE", feature: "intake", artefact: "qa" }, scope());
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.content)).toBeLessThanOrEqual(MAX_ARTEFACT_BYTES);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/artefact-reader.test.ts`
Expected: FAIL, `Failed to load url ./artefact-reader.js` (module does not exist).

- [ ] **Step 3: Write the implementation**

```ts
// server/artefact-reader.ts
import fs from "node:fs/promises";
import path from "node:path";
import * as pipeline from "../../scripts/pipeline.mjs";

/**
 * What the chat may read to answer a question about a generated artefact.
 *
 * One fixed list of files per artefact, never a path from the model: the model
 * names WHICH artefact, and this table decides which files that is. The `.md`
 * renderings are preferred over the `.json` they come from because they carry
 * the same content at about half the size, in a form the model reads more
 * reliably. The UI mockups are JSON only, so that is what is read for them.
 */
export const ARTEFACTS = {
  capabilities: { level: "project", files: ["solutions/Capabilities/outputs/capability-process.md"] },
  personas: { level: "project", files: ["solutions/Experience/outputs/personas-journeys.md"] },
  requirements: { level: "feature", files: ["outputs/product-summary.md", "outputs/stories.md"] },
  ui: { level: "feature", files: ["solutions/UI/outputs/mockups.json"] },
  datamodel: { level: "feature", files: ["solutions/DataModel/outputs/salesforce-data-model.md"] },
  architecture: { level: "feature", files: ["solutions/Architecture/outputs/solution-architecture.md"] },
  qa: { level: "feature", files: ["solutions/QA/outputs/test-cases.md"] },
  design: { level: "feature", files: ["solutions/Design/outputs/solution-design.md"] },
} as const satisfies Record<string, { level: "project" | "feature"; files: readonly string[] }>;

export type ArtefactKey = keyof typeof ARTEFACTS;

/** Large enough for every artefact measured so far (the biggest is ~70 KB). */
export const MAX_ARTEFACT_BYTES = 200_000;

export type ArtefactRead =
  | { state: "ok"; artefact: ArtefactKey; files: string[]; content: string; truncated: boolean }
  | { state: "not_generated"; artefact: ArtefactKey; files: string[] }
  | { state: "invalid"; reason: string };

export interface ReadScope {
  workspace: string;
  /** The caller's projects and each one's features — `store.available(token)`. */
  visible: Record<string, { name: string }[]>;
}

const isArtefact = (a: string): a is ArtefactKey => Object.prototype.hasOwnProperty.call(ARTEFACTS, a);

/** SAFE_NAME allows dots, so `..` has to be refused on its own. */
const isSafeName = (n: string) => pipeline.SAFE_NAME.test(n) && !n.includes("..") && !n.startsWith(".");

export async function readArtefact(
  args: { project?: unknown; feature?: unknown; artefact?: unknown },
  scope: ReadScope,
): Promise<ArtefactRead> {
  const artefact = String(args.artefact ?? "").trim();
  const project = String(args.project ?? "").trim();
  const feature = String(args.feature ?? "").trim();

  if (!isArtefact(artefact)) {
    return { state: "invalid", reason: `Unknown artefact "${artefact}". Use one of: ${Object.keys(ARTEFACTS).join(", ")}.` };
  }
  // Visibility is checked against the caller's own project list, so a question
  // about another organisation's project reads nothing — the same rule the
  // system prompt's project list already follows.
  if (!project || !isSafeName(project) || !Object.prototype.hasOwnProperty.call(scope.visible, project)) {
    return { state: "invalid", reason: `There is no project called "${project}" that this user can see.` };
  }

  const def = ARTEFACTS[artefact];
  let root = path.join(scope.workspace, "projects", project);
  if (def.level === "feature") {
    if (!feature) {
      return { state: "invalid", reason: `The ${artefact} belong to a feature. Ask the user which feature of ${project} they mean.` };
    }
    if (
      !isSafeName(feature) ||
      pipeline.RESERVED_FEATURE_NAMES.has(feature.toLowerCase()) ||
      !scope.visible[project].some((f) => f.name === feature)
    ) {
      return { state: "invalid", reason: `${project} has no feature called "${feature}".` };
    }
    root = path.join(root, feature);
  }

  const found: string[] = [];
  const bodies: string[] = [];
  for (const rel of def.files) {
    try {
      bodies.push(await fs.readFile(path.join(root, rel), "utf8"));
      found.push(rel);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
  if (found.length === 0) return { state: "not_generated", artefact, files: [...def.files] };

  let content = bodies.join("\n\n---\n\n");
  const truncated = Buffer.byteLength(content) > MAX_ARTEFACT_BYTES;
  if (truncated) content = Buffer.from(content).subarray(0, MAX_ARTEFACT_BYTES).toString("utf8");
  return { state: "ok", artefact, files: found, content, truncated };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/artefact-reader.test.ts`
Expected: PASS, 9 tests.

If "caps a large artefact" fails on `toBeLessThanOrEqual`: `toString("utf8")` turns a cut multi-byte character into U+FFFD (3 bytes). The fixture is ASCII, so it should pass; if it does not, trim with `content.slice(0, -1)` until it fits.

- [ ] **Step 5: Commit**

```bash
git add server/artefact-reader.ts server/artefact-reader.test.ts
git commit -m "Read a generated artefact for the chat, scoped to what the caller can see

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Read loop

**Files:**
- Create: `server/read-loop.ts`
- Test: `server/read-loop.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at the type level (the reader is passed in), so this task is testable alone.
- Produces:
  - `READ_TOOL = "read_artefact"`
  - `MAX_READ_ROUNDS = 3`
  - `ANSWER_NOW: string`
  - `interface ChatTurns { sendMessage(request: string | object[]): Promise<{ response: any }> }`
  - `answerWithReads(turns: ChatTurns, first: any, read: (args: Record<string, unknown>) => Promise<object>, maxRounds?: number): Promise<any>` returns a Gemini response object with every `read_artefact` call removed.

- [ ] **Step 1: Write the failing test**

```ts
// server/read-loop.test.ts
import { describe, it, expect, vi } from "vitest";
import { answerWithReads, READ_TOOL, MAX_READ_ROUNDS } from "./read-loop.js";

/**
 * The chat's tools used to be one-way: the model asked, the browser acted, and
 * nothing came back. Reading an artefact has to come back — the model cannot
 * answer a question about a file it never saw.
 */

const turn = (...parts: object[]) => ({ candidates: [{ content: { role: "model", parts } }] });
const read = (args: object) => ({ functionCall: { name: READ_TOOL, args } });
const text = (t: string) => ({ text: t });
const partsOf = (r: any) => r.candidates[0].content.parts;

function fakeTurns(replies: object[]) {
  const sent: any[] = [];
  return {
    sent,
    sendMessage: async (request: any) => {
      sent.push(request);
      return { response: replies.shift() ?? turn(text("(out of replies)")) };
    },
  };
}

describe("answerWithReads", () => {
  it("returns a turn with no tool calls untouched", async () => {
    const turns = fakeTurns([]);
    const first = turn(text("Hello"));
    expect(await answerWithReads(turns, first, vi.fn())).toEqual(first);
    expect(turns.sent).toHaveLength(0);
  });

  it("reads, sends the result back, and returns the answer", async () => {
    const turns = fakeTurns([turn(text("The closest is Procurement Officer (PO)."))]);
    const reader = vi.fn(async () => ({ state: "ok", content: "# Personas\nProcurement Officer (PO)" }));
    const out = await answerWithReads(turns, turn(read({ project: "BAE", artefact: "personas" })), reader);
    expect(reader).toHaveBeenCalledWith({ project: "BAE", artefact: "personas" });
    expect(turns.sent[0][0].functionResponse).toEqual({
      name: READ_TOOL,
      response: { state: "ok", content: "# Personas\nProcurement Officer (PO)" },
    });
    expect(partsOf(out)).toEqual([text("The closest is Procurement Officer (PO).")]);
  });

  it("answers two reads from one turn in one message", async () => {
    const turns = fakeTurns([turn(text("done"))]);
    const reader = vi.fn(async (a: any) => ({ state: "ok", content: a.artefact }));
    await answerWithReads(turns, turn(read({ artefact: "capabilities" }), read({ artefact: "personas" })), reader);
    expect(turns.sent).toHaveLength(1);
    expect(turns.sent[0].map((p: any) => p.functionResponse.response.content)).toEqual(["capabilities", "personas"]);
  });

  it("drops text that came with a read", async () => {
    const turns = fakeTurns([turn(text("answer"))]);
    const out = await answerWithReads(turns, turn(text("Let me check…"), read({ artefact: "qa" })), async () => ({ state: "ok" }));
    expect(partsOf(out)).toEqual([text("answer")]);
  });

  it("hands any other tool to the browser and removes the reads", async () => {
    const turns = fakeTurns([]);
    const revise = { functionCall: { name: "revise_artefact", args: { artefact: "personas" } } };
    const out = await answerWithReads(turns, turn(read({ artefact: "personas" }), revise), vi.fn());
    expect(turns.sent).toHaveLength(0);
    expect(partsOf(out)).toEqual([revise]);
  });

  it("stops after three rounds with a function response, never bare text", async () => {
    // Gemini rejects a plain-text turn after a function call it has not had a
    // response to, so the limit itself has to arrive as a function response.
    const always = () => turn(read({ artefact: "capabilities" }));
    const turns = fakeTurns([always(), always(), always(), turn(text("best I can say"))]);
    const reader = vi.fn(async () => ({ state: "ok" }));
    const out = await answerWithReads(turns, always(), reader);
    expect(reader).toHaveBeenCalledTimes(MAX_READ_ROUNDS);
    expect(turns.sent).toHaveLength(MAX_READ_ROUNDS + 1);
    const last = turns.sent.at(-1);
    expect(Array.isArray(last)).toBe(true);
    expect(last[0].functionResponse.response.state).toBe("limit");
    expect(partsOf(out)).toEqual([text("best I can say")]);
  });

  it("removes a read the model still asks for after the limit", async () => {
    const always = () => turn(read({ artefact: "capabilities" }));
    const turns = fakeTurns([always(), always(), always(), always()]);
    const out = await answerWithReads(turns, always(), async () => ({ state: "ok" }));
    expect(partsOf(out)).toEqual([]);
  });

  it("tells the model when a read throws, and carries on", async () => {
    const turns = fakeTurns([turn(text("could not read it"))]);
    await answerWithReads(turns, turn(read({ artefact: "qa" })), async () => { throw new Error("EACCES"); });
    expect(turns.sent[0][0].functionResponse.response).toEqual({ state: "invalid", reason: "Could not read it: EACCES" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/read-loop.test.ts`
Expected: FAIL, `Failed to load url ./read-loop.js`.

- [ ] **Step 3: Write the implementation**

```ts
// server/read-loop.ts

/**
 * Let the model read before it answers.
 *
 * Every other chat tool is one-way: the model names a tool, the browser runs it
 * and shows the result, and the result never returns to the model. That is
 * right for "run the data model", and it is why the model could not answer
 * "is there a supplier persona?" — it had no way to look. `read_artefact` is
 * the one tool the SERVER runs, on the same chat session, so the model sees
 * the file and answers from it.
 */
export const READ_TOOL = "read_artefact";

/** Enough for "compare the personas with the capability map", and a ceiling on a model that keeps asking. */
export const MAX_READ_ROUNDS = 3;

export const ANSWER_NOW =
  "You have read enough. Answer the user now from what you have already read. Do not call read_artefact again.";

export interface ChatTurns {
  sendMessage(request: string | object[]): Promise<{ response: any }>;
}

type Call = { name: string; args: Record<string, unknown> };

function callsOf(response: any): Call[] {
  const parts: any[] = response?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p?.functionCall)
    .map((p) => ({ name: String(p.functionCall.name), args: p.functionCall.args ?? {} }));
}

/** The browser has no handler for a read, so it never receives one. */
function withoutReads(response: any): any {
  const cand = response?.candidates?.[0];
  if (!Array.isArray(cand?.content?.parts)) return response;
  const parts = cand.content.parts.filter((p: any) => p?.functionCall?.name !== READ_TOOL);
  return { ...response, candidates: [{ ...cand, content: { ...cand.content, parts } }, ...response.candidates.slice(1)] };
}

export async function answerWithReads(
  turns: ChatTurns,
  first: any,
  read: (args: Record<string, unknown>) => Promise<object>,
  maxRounds = MAX_READ_ROUNDS,
): Promise<any> {
  let response = first;
  for (let round = 0; ; round++) {
    const calls = callsOf(response);
    // Anything other than a read is an ACTION, and actions belong to the
    // browser exactly as before. Any text alongside a read is dropped: it is
    // "let me check", and the answer comes after the read.
    if (calls.length === 0 || calls.some((c) => c.name !== READ_TOOL)) return withoutReads(response);

    // Gemini rejects a plain-text turn after a function call it has had no
    // response to, so the limit is delivered AS the function response.
    const atLimit = round >= maxRounds;
    const replies = await Promise.all(
      calls.map(async (c) => ({
        functionResponse: {
          name: READ_TOOL,
          response: atLimit
            ? { state: "limit", reason: ANSWER_NOW }
            : await read(c.args).catch((e: any) => ({ state: "invalid", reason: `Could not read it: ${e?.message ?? e}` })),
        },
      })),
    );
    response = (await turns.sendMessage(replies)).response;
    if (atLimit) return withoutReads(response);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/read-loop.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/read-loop.ts server/read-loop.test.ts
git commit -m "Let the chat model read an artefact and answer from it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the read tool into the chat

**Files:**
- Modify: `server/llm.ts` (imports at the top; `buildCompactPrompt` ~line 123; revision section of `buildSystemPrompt` ~lines 403–421; `triggerTool.functionDeclarations` ~line 463; `send` inside `chat()` ~line 840)
- Test: `server/llm-prompt.test.ts` (new)

**Interfaces:**
- Consumes: `readArtefact`, `ARTEFACTS` (Task 1); `answerWithReads`, `READ_TOOL` (Task 2); `store.available(token)` (existing, returns `Record<string, { name: string; counts: … }[]>`).
- Produces: no new exports. `chat()` keeps its signature and return shape.

- [ ] **Step 1: Write the failing test**

```ts
// server/llm-prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./llm.js";

/**
 * The prompt is what makes the model read before it answers. Without these
 * rules it answers from general knowledge, which is how it described a
 * capability map it had never seen.
 */
describe("system prompt — questions about generated artefacts", () => {
  const prompt = buildSystemPrompt("- BAE:\n    (no features)", { project: "BAE", feature: null });

  it("tells the model to read first and answer only from the file", () => {
    expect(prompt).toContain("read_artefact");
    expect(prompt).toMatch(/answer only from what it returns/i);
  });

  it("tells the model not to ask for confirmation of a revision itself", () => {
    expect(prompt).toMatch(/Start change/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/llm-prompt.test.ts`
Expected: FAIL on `toContain("read_artefact")`.

- [ ] **Step 3: Add the imports**

At the top of `server/llm.ts`, after the existing imports:

```ts
import { readArtefact, ARTEFACTS } from "./artefact-reader.js";
import { answerWithReads, READ_TOOL } from "./read-loop.js";
```

- [ ] **Step 4: Add the tool declaration**

In `triggerTool.functionDeclarations`, directly before the `revise_artefact` entry:

```ts
    {
      name: READ_TOOL,
      description: "Reads an artefact that has ALREADY BEEN GENERATED so you can answer a question about it — 'what personas do we have?', 'is there a capability for supplier onboarding?', 'which stories cover appeals?', 'what does the data model use for permits?', 'compare the journeys with the capability map'. Call it BEFORE answering any question about what a stage produced, and answer only from what it returns. Read-only and instant: it runs no specialist and changes nothing. Returns state 'ok' with the content, 'not_generated' if that stage has not run (offer to generate it), or 'invalid' with a reason (for a feature-level artefact with no feature, ask which feature).",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required for every artefact EXCEPT capabilities and personas, which are project-level." },
          artefact: {
            type: SchemaType.STRING,
            format: "enum",
            enum: Object.keys(ARTEFACTS),
            description: "capabilities = capability map + process model. personas = personas + journeys. requirements = product summary + user stories. ui = UI mockups. datamodel = Salesforce data model. architecture = Solution Architecture Document. qa = test pack. design = Solution Design Document.",
          },
        },
        required: ["project", "artefact"],
      },
    },
```

- [ ] **Step 5: Run the read loop inside `send`**

In `chat()`, replace the whole `const send = (system: string) => retryWithBackoff(async () => { … });` block with the version below. Keep the existing comment about the fresh history copy; it still applies.

```ts
  // The model may ask to read an artefact before it answers. Those reads run
  // here, on the server, against the caller's own project list — `tree` is
  // already `store.available(token)` — and only the final turn goes back to
  // the browser.
  const read = (args: Record<string, unknown>) => readArtefact(
    {
      project: args.project || target?.project,
      feature: args.feature || target?.feature,
      artefact: args.artefact,
    },
    { workspace: WORKSPACE, visible: tree },
  );

  const send = async (system: string) => {
    const m = genAI.getGenerativeModel({ model: MODEL_NAME, systemInstruction: system, tools: [triggerTool] });
    // Hand startChat a FRESH COPY, and drop any Content with no parts.
    // (existing comment kept as is)
    const safeHistory = history
      .filter((h: any) => Array.isArray(h?.parts) && h.parts.length > 0)
      .map((h: any) => ({ ...h, parts: [...h.parts] }));
    const session = m.startChat({ history: safeHistory });
    // Retry each message on its own. A failed sendMessage appends nothing to
    // the session's history, so resending the same request is safe, and a
    // transport error on the second round no longer restarts the first.
    const turns = { sendMessage: (request: any) => retryWithBackoff(() => session.sendMessage(request)) };
    const first = await turns.sendMessage(userText);
    return answerWithReads(turns, first.response, read);
  };
```

`normalize(await send(...))` below it is unchanged: `answerWithReads` returns a response of the same shape.

- [ ] **Step 6: Add the prompt rules**

In `buildSystemPrompt`, directly above `### Changing something already generated — the revision path`, insert:

```md
### Questions about what has been generated

When the user asks about an artefact that already exists — "what personas do we have?", "is there a capability for supplier onboarding?", "which stories cover appeals?", "what fields are on the permit object?" — call \`read_artefact\` first, then answer only from what it returns.

- **Name the item** your answer comes from: the persona's full name and abbreviation, the capability ID, the story number, the test ID.
- **If it is not in the file, say so.** "The capability map has no supplier onboarding capability." Never fill the gap from general knowledge or from what a similar organisation would have.
- **\`not_generated\`** means the stage has not run. Say so and offer to generate it.
- **\`invalid\`** asking which feature: ask the user, in one line, which feature they mean.
- **When the answer shows a gap, offer the change in one line** — "Want me to add a supplier persona?". On a yes, call \`revise_artefact\` with the user's request plus the gap you found, in their words.
- Keep answers short. Quote at most a few lines of the artefact; point to the item rather than pasting sections.
```

In the same section's "Rules" list, replace rule 3:

```md
3. **A question is not a revision.** "Why does the data model use Case?" is answered by reading the data model with \`read_artefact\`. Only call \`revise_artefact\` when they want something changed.
```

and add rule 6:

```md
6. **Do not ask "are you sure?" yourself.** The user is shown the change with a **Start change** button, and nothing runs until they press it.
```

In `buildCompactPrompt`, after the `- change something already generated -> revise_artefact` line, add:

```ts
    "- a question about something already generated -> read_artefact first, then answer only from it",
```

and change the last line to:

```ts
    "If the request is a question that is not about a generated artefact, answer it in one or two sentences.",
```

- [ ] **Step 7: Run the tests, types and routing check**

Run: `npx vitest run server/llm-prompt.test.ts server/read-loop.test.ts server/artefact-reader.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors. If `enum: Object.keys(ARTEFACTS)` is rejected by the SDK's schema type, use `enum: [...Object.keys(ARTEFACTS)] as string[]`.

Run (workspace root): `npm run check:routing`
Expected: passes, unchanged output.

- [ ] **Step 8: Smoke-test against real Gemini**

The chatbot server runs under `tsx watch`, so it has reloaded. With a signed-in token in `$T` (the `SCYNE_ORCH_TOKEN` in `.env` works):

```bash
curl -s localhost:4000/api/chat -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What personas does BAE have? Just the names."}],"target":{"project":"BAE","feature":null}}' | jq -r '.content[].text'
```

Expected: persona names that appear in `projects/BAE/solutions/Experience/outputs/personas-journeys.md` (check with `grep -n "^## \|^### " projects/BAE/solutions/Experience/outputs/personas-journeys.md`). The server log shows no `[llm] empty response`.

- [ ] **Step 9: Commit**

```bash
git add server/llm.ts server/llm-prompt.test.ts
git commit -m "Have the chat read an artefact before answering a question about it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Start-change card

**Files:**
- Modify: `src/types.ts` (`MessageKind`, `UIMessage`)
- Create: `src/lib/proposal.ts`
- Test: `src/lib/proposal.test.ts`
- Modify: `src/components/MessageBubble.tsx` (new `ProposalCard`, new optional prop)
- Modify: `src/App.tsx` (`revise_artefact` branch ~line 975; new `handleProposal` next to `handleApprove` ~line 1217; `<MessageBubble>` at ~line 1537)

**Interfaces:**
- Consumes: `reviseArtefact(project, artefact, instruction, feature?)` from `src/api.ts` (existing, returns `{ id, identifier }`).
- Produces:
  - `interface RevisionProposal { project: string; feature?: string; artefact: string; instruction: string; state: "pending" | "starting" | "started" | "cancelled"; issue?: string }`
  - `ARTEFACT_LABELS: Record<string, string>`
  - `proposalMessage(input: Record<string, unknown>, target: { project: string | null; feature: string | null }): UIMessage | { error: string }`
  - `claimProposal(messages: UIMessage[], id: string): { messages: UIMessage[]; proposal: RevisionProposal } | null`
  - `settleProposal(messages: UIMessage[], id: string, patch: Partial<RevisionProposal>): UIMessage[]`

- [ ] **Step 1: Add the types**

In `src/types.ts`:

```ts
export type MessageKind = "user" | "assistant" | "agent" | "decision" | "links" | "proposal";
```

and inside `UIMessage`, after `links`:

```ts
  /**
   * Set on `kind: "proposal"` — a revision the assistant proposed and the
   * person has not yet started. A revision is a fifteen-minute specialist run,
   * so the model proposes and the person commits. Persisted with the
   * transcript, so a card already started cannot be started again after a
   * reload.
   */
  proposal?: RevisionProposal;
```

and below `UIMessage`:

```ts
export interface RevisionProposal {
  project: string;
  feature?: string;
  artefact: string;
  instruction: string;
  state: "pending" | "starting" | "started" | "cancelled";
  issue?: string;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/proposal.test.ts
import { describe, it, expect } from "vitest";
import { proposalMessage, claimProposal, settleProposal } from "./proposal";
import type { UIMessage } from "../types";

describe("proposalMessage", () => {
  const target = { project: "BAE", feature: null };

  it("builds a pending card from the tool call", () => {
    const m = proposalMessage({ artefact: "personas", instruction: "add a supplier persona" }, target);
    expect("error" in m).toBe(false);
    if ("error" in m) return;
    expect(m.kind).toBe("proposal");
    expect(m.proposal).toEqual({ project: "BAE", artefact: "personas", instruction: "add a supplier persona", state: "pending" });
  });

  it("keeps the feature for a feature-level artefact", () => {
    const m = proposalMessage({ project: "BAE", feature: "intake", artefact: "qa", instruction: "x" }, target);
    expect(!("error" in m) && m.proposal?.feature).toBe("intake");
  });

  it("refuses a call with no instruction", () => {
    expect(proposalMessage({ artefact: "personas" }, target)).toHaveProperty("error");
  });

  it("refuses a call with no project and no target", () => {
    expect(proposalMessage({ artefact: "personas", instruction: "x" }, { project: null, feature: null })).toHaveProperty("error");
  });
});

describe("claimProposal", () => {
  const card = (state: any): UIMessage => ({
    id: "p1", role: "assistant", kind: "proposal", text: "",
    proposal: { project: "BAE", artefact: "personas", instruction: "x", state },
  });

  it("claims a pending card and marks it starting", () => {
    const r = claimProposal([card("pending")], "p1");
    expect(r?.proposal.state).toBe("pending");
    expect(r?.messages[0].proposal?.state).toBe("starting");
  });

  it("refuses a card that is not pending — a second click starts nothing", () => {
    for (const s of ["starting", "started", "cancelled"]) expect(claimProposal([card(s)], "p1")).toBeNull();
  });

  it("refuses an unknown id", () => {
    expect(claimProposal([card("pending")], "nope")).toBeNull();
  });
});

describe("settleProposal", () => {
  it("patches only the named card", () => {
    const other: UIMessage = { id: "t", role: "assistant", text: "hi" };
    const card: UIMessage = { id: "p1", role: "assistant", kind: "proposal", text: "", proposal: { project: "BAE", artefact: "personas", instruction: "x", state: "starting" } };
    const out = settleProposal([other, card], "p1", { state: "started", issue: "SCY-12" });
    expect(out[0]).toBe(other);
    expect(out[1].proposal).toMatchObject({ state: "started", issue: "SCY-12" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/proposal.test.ts`
Expected: FAIL, cannot resolve `./proposal`.

- [ ] **Step 4: Write the helpers**

```ts
// src/lib/proposal.ts
import type { RevisionProposal, UIMessage } from "../types";

/** What each artefact is called on the card. Matches the revise_artefact enum. */
export const ARTEFACT_LABELS: Record<string, string> = {
  capabilities: "capability map",
  personas: "personas and journeys",
  requirements: "product summary and stories",
  ui: "UI mockups",
  datamodel: "data model",
  architecture: "solution architecture",
  qa: "test pack",
  design: "solution design",
};

/** The card for a `revise_artefact` call, or what is missing from it. */
export function proposalMessage(
  input: Record<string, unknown>,
  target: { project: string | null; feature: string | null },
): UIMessage | { error: string } {
  const project = String(input.project || target.project || "").trim();
  const feature = String(input.feature || target.feature || "").trim();
  const artefact = String(input.artefact || "").trim();
  const instruction = String(input.instruction || "").trim();
  if (!project) return { error: "Which project is that change for?" };
  if (!artefact || !instruction) return { error: "I didn't catch what to change — say it once more?" };
  const proposal: RevisionProposal = { project, artefact, instruction, state: "pending" };
  if (feature) proposal.feature = feature;
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    kind: "proposal",
    text: `Change the ${ARTEFACT_LABELS[artefact] ?? artefact}: "${instruction}"`,
    proposal,
  };
}

/**
 * Take a pending card for starting. Null when it is not pending, so a second
 * click on Start change — or a click on a card already started before a
 * reload — starts nothing.
 */
export function claimProposal(
  messages: UIMessage[],
  id: string,
): { messages: UIMessage[]; proposal: RevisionProposal } | null {
  const card = messages.find((m) => m.id === id);
  if (!card?.proposal || card.proposal.state !== "pending") return null;
  return { messages: settleProposal(messages, id, { state: "starting" }), proposal: card.proposal };
}

export function settleProposal(messages: UIMessage[], id: string, patch: Partial<RevisionProposal>): UIMessage[] {
  return messages.map((m) => (m.id === id && m.proposal ? { ...m, proposal: { ...m.proposal, ...patch } } : m));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/proposal.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Render the card**

In `src/components/MessageBubble.tsx`, add imports:

```tsx
import { Button } from "@/components/ui/button";
import { ARTEFACT_LABELS } from "../lib/proposal";
```

Add this component above `MessageBubble`:

```tsx
function ProposalCard({ m, onProposal }: { m: UIMessage; onProposal?: (id: string, action: "start" | "cancel") => void }) {
  const p = m.proposal!;
  const label = ARTEFACT_LABELS[p.artefact] ?? p.artefact;
  const scope = p.feature && p.artefact !== "capabilities" && p.artefact !== "personas" ? `${p.project} / ${p.feature}` : p.project;
  return (
    <div className="flex justify-start gap-3 animate-slide-up">
      <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-transparent" />
      <div className="max-w-[88%] w-full min-w-0 rounded-lg border border-slate-200 bg-white/80 px-3 py-2.5">
        <div className="text-[12px] font-semibold text-slate-600">
          Change the {label} · <span className="font-normal">{scope}</span>
        </div>
        <div className="mt-1 border-l-2 border-slate-300 pl-2 text-[13.5px] italic text-slate-800 whitespace-pre-wrap">
          “{p.instruction}”
        </div>
        <div className="mt-1.5 text-[12px] text-slate-500">
          The specialist edits it (about 15 min, about $1.50), then you approve it before anything is published.
        </div>
        {p.state === "pending" ? (
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" onClick={() => onProposal?.(m.id, "start")}>Start change</Button>
            <Button size="sm" variant="outline" onClick={() => onProposal?.(m.id, "cancel")}>Cancel</Button>
          </div>
        ) : (
          <div className="mt-2 text-[12px] font-medium text-slate-600">
            {p.state === "starting" ? "Starting…" : p.state === "started" ? `Started${p.issue ? ` — ${p.issue}` : ""}` : "Cancelled"}
          </div>
        )}
      </div>
    </div>
  );
}
```

Change the `MessageBubble` signature and add the branch at the top:

```tsx
export function MessageBubble({ m, onProposal }: { m: UIMessage; onProposal?: (id: string, action: "start" | "cancel") => void }) {
  if (m.kind === "proposal" && m.proposal) return <ProposalCard m={m} onProposal={onProposal} />;
  if (m.kind === "decision" && m.decision) return <DecisionRecord m={m} />;
```

- [ ] **Step 7: Propose instead of starting**

In `src/App.tsx`, add `proposalMessage, claimProposal, settleProposal` to the imports:

```ts
import { proposalMessage, claimProposal, settleProposal } from "./lib/proposal";
```

Replace the whole `} else if (toolUse?.name === "revise_artefact") { … }` branch with:

```tsx
      } else if (toolUse?.name === "revise_artefact") {
        // The model PROPOSES; the person commits. A revision is a fifteen-minute,
        // dollar-and-a-half specialist run, and now that the chat answers
        // questions a loose "yes, nice" is easy to misread as "change it".
        const card = proposalMessage((toolUse.input ?? {}) as Record<string, unknown>, { project: targetProject, feature: targetFeature });
        if ("error" in card) {
          setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: card.error }]);
        } else {
          setTargetProject(card.proposal!.project);
          setMessages((m) => [...m, card]);
        }
```

Next to `handleApprove`, add:

```tsx
  // A ref, not state: two clicks in the same frame both see the card as
  // pending in `messages`, and only one of them may start a revision.
  const claimedProposals = useRef(new Set<string>());

  async function handleProposal(id: string, action: "start" | "cancel") {
    if (claimedProposals.current.has(id)) return;
    const claimed = claimProposal(messages, id);
    if (!claimed) return;
    claimedProposals.current.add(id);
    if (action === "cancel") {
      setMessages((m) => settleProposal(m, id, { state: "cancelled" }));
      return;
    }
    const p = claimed.proposal;
    setMessages(claimed.messages);
    try {
      const issue = await reviseArtefact(p.project, p.artefact, p.instruction, p.feature || undefined);
      setParentIssueId(issue.id);
      setChipsKey((k) => k + 1);
      setRightTab("activity");
      setMessages((m) => [
        ...settleProposal(m, id, { state: "started", issue: issue.identifier }),
        { id: crypto.randomUUID(), role: "assistant", text: `Issue **${issue.identifier}** raised. The specialist revises rather than regenerates, and you get an approval gate with the change before anything is published. Live progress on the right →` },
      ]);
    } catch (e: any) {
      // Back to pending so the person can try again once the cause is fixed.
      claimedProposals.current.delete(id);
      const msg = e?.code === "not_generated" ? `${e.message} Want me to generate it instead?` : `Couldn't start that change: ${e?.message ?? e}`;
      setMessages((m) => [...settleProposal(m, id, { state: "pending" }), { id: crypto.randomUUID(), role: "assistant", text: msg }]);
    }
  }
```

If `useRef` is not yet imported in `App.tsx`, add it to the `react` import.

Pass the handler at the render site (~line 1537):

```tsx
            {messages.map((m) => <MessageBubble key={m.id} m={m} onProposal={handleProposal} />)}
```

- [ ] **Step 8: Run tests and types**

Run: `npx vitest run src/lib/proposal.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/lib/proposal.ts src/lib/proposal.test.ts src/components/MessageBubble.tsx src/App.tsx
git commit -m "Ask before starting a revision the chat proposed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs and end-to-end check

**Files:**
- Modify: `docs/chatbot.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Document it**

In `docs/chatbot.md`, find the section that lists the chat tools (search for `revise_artefact`) and add, next to it:

```md
### Questions about generated artefacts — `read_artefact`

The one chat tool the SERVER runs. Every other tool is one-way: the model names
it, the browser runs it, and the result never returns to the model. A question
about an artefact needs the result back, so `chat()` runs `read_artefact` on the
same Gemini session (`server/read-loop.ts`), sends the file back as a function
response, and returns only the final turn. At most three rounds; at the limit
the pending calls are answered with `state: "limit"`, because Gemini rejects
plain text after an unanswered function call.

`server/artefact-reader.ts` maps each artefact to a fixed list of files (the
`.md` rendering where one exists), refuses any project not in
`store.available(token)` and any feature that project does not have, and caps
the content at 200 KB. The model never supplies a path.

File contents are not kept in the chat history, so a follow-up question reads
the file again. That keeps every later turn small, which matters: long prompts
are what cause Gemini's empty turns (see `llm.ts`).

### Revisions wait for a click

`revise_artefact` no longer starts a run. The browser shows a card with the
artefact, the instruction in quotes, and **Start change** / **Cancel**
(`src/lib/proposal.ts`, `MessageBubble.tsx`). Only a `pending` card can be
started, so a double click or a reload starts nothing twice.
```

- [ ] **Step 2: Full verification**

Run (in `scyne-chatbot/`): `npm test && npm run typecheck`
Expected: every suite passes (298 before this work, plus 27 new tests).

Run (workspace root): `npm run check:routing`
Expected: passes.

- [ ] **Step 3: Chrome check on BAE**

Open `http://localhost:5173`, sign in, choose project **BAE**. Then:

1. Ask "What personas does BAE have?" Expected: names that exist in `personas-journeys.md`.
2. Ask "Which capability covers paying suppliers?" Expected: a real capability ID and name from `capability-process.md`.
3. Ask "Is there a persona for an external auditor?" Expected: either a real persona named, or "not there" with an offer to add one. No invented persona.
4. Say "yes, add one". Expected: a **Change the personas and journeys** card with the instruction quoted and **Start change** / **Cancel**. No issue appears on the right.
5. Click **Cancel**. Expected: card reads "Cancelled"; buttons gone. Reload: still "Cancelled".

Do NOT click **Start change** in this check: it spends about $1.50.

- [ ] **Step 4: Commit**

```bash
git add docs/chatbot.md
git commit -m "Document the chat's artefact reads and the revision card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
