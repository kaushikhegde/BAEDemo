import { GoogleGenerativeAI, SchemaType, type Tool } from "@google/generative-ai";
import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_PATH } from "./workspace.js";

if (!process.env.GEMINI_API_KEY) {
  console.warn("[llm] Warning: GEMINI_API_KEY not set; chat will fail until configured.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
export const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const WORKSPACE = WORKSPACE_PATH;

/** Scan ./projects/<project>/<feature>/ structure on demand. */
/** Which projects already carry a projects/<project>/description.md. */
async function listProjectDefinitions(): Promise<Record<string, boolean>> {
  const projectsDir = path.join(WORKSPACE, "projects");
  const out: Record<string, boolean> = {};
  try {
    for (const p of await fs.readdir(projectsDir, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      out[p.name] = await fs
        .access(path.join(projectsDir, p.name, "description.md"))
        .then(() => true)
        .catch(() => false);
    }
  } catch {}
  return out;
}

async function listAvailable(): Promise<Record<string, { name: string; counts: Record<string, number> }[]>> {
  const projectsDir = path.join(WORKSPACE, "projects");
  const out: Record<string, { name: string; counts: Record<string, number> }[]> = {};
  try {
    const projects = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const features = await fs.readdir(path.join(projectsDir, p.name), { withFileTypes: true });
      out[p.name] = [];
      for (const s of features) {
        if (!s.isDirectory()) continue;
        const subPath = path.join(projectsDir, p.name, s.name);
        const subs = await fs.readdir(subPath, { withFileTypes: true });
        const counts: Record<string, number> = {};
        for (const sub of subs) {
          if (!sub.isDirectory()) continue;
          const files = await fs.readdir(path.join(subPath, sub.name));
          counts[sub.name] = files.length;
        }
        out[p.name].push({ name: s.name, counts });
      }
    }
  } catch {}
  return out;
}

function formatFeatures(tree: Record<string, { name: string; counts: Record<string, number> }[]>): string {
  const entries = Object.entries(tree);
  if (entries.length === 0) return "(no projects detected on disk yet)";
  return entries
    .map(([proj, features]) => {
      const ss = features
        .map((s) => {
          const fileSummary = Object.entries(s.counts)
            .map(([sub, n]) => `${n} ${sub}`)
            .join(", ");
          return `    - ${s.name}${fileSummary ? ` (${fileSummary})` : ""}`;
        })
        .join("\n");
      return `- ${proj}:\n${ss || "    (no features)"}`;
    })
    .join("\n");
}

type UiContext = { active: boolean; project?: string | null; feature?: string | null } | null;

function buildSystemPrompt(
  featuresBlock: string,
  target?: { project: string | null; feature: string | null } | null,
  uiContext?: UiContext,
  definitions?: Record<string, boolean>,
): string {
  const defEntries = Object.entries(definitions ?? {});
  const missingDefs = defEntries.filter(([, has]) => !has).map(([p]) => p);
  const haveDefs = defEntries.filter(([, has]) => has).map(([p]) => p);
  const defBlock = defEntries.length === 0 ? "" : `
## Project definitions

A project definition lives at \`projects/<project>/description.md\`. It describes the CLIENT ORGANISATION — who they are, what they do, what they are regulated or obliged to do, who their customers really are, and what they cannot do. **Every skill reads it before any discovery document**, so it materially changes the quality of requirements, personas, capabilities, architecture and test cases.

- Projects that HAVE a definition: ${haveDefs.length ? haveDefs.join(", ") : "(none yet)"}
- Projects with NO definition: ${missingDefs.length ? missingDefs.join(", ") : "(none)"}

Rules:
1. When the user picks a project with **no** definition and is about to run ANY generation stage, ask for one first, in one short sentence, and say plainly why it matters: without it every skill falls back to generic industry assumptions. Offer to proceed anyway if they would rather not.
2. When the user supplies a description, summary, background or "about the client" text for a project — pasted, dictated or typed — call \`save_project_definition\` with their words. Do NOT summarise or shorten it.
3. Never block a workflow on a missing definition. Ask once, accept the answer, move on.
4. The definition is per PROJECT, not per feature. Do not ask for it again for a second feature under the same project.
`;
  const uiBlock = uiContext?.active
    ? `\n## A live UI preview is ACTIVE for ${uiContext.project}/${uiContext.feature}\n\nThe right pane is showing a running, editable UI build. For EACH user message decide the intent:\n- **A question or request for information** ("what does this screen do?", "why is it laid out this way?", "is it responsive?", "what's left to do?") → just answer in text. Do NOT touch the build.\n- **A change to the UI** ("make the header navy", "add a back button", "move the table up", "use bigger fonts") → call \`comment_on_ui_build\` with kind="modify" and a clear \`instruction\`.\n- **Approval** ("looks good", "ship it", "approve", "that's perfect") → call \`comment_on_ui_build\` with kind="approve".\n- **Push to GitHub** ("push to github <url>", "publish it to <repo>") → call \`comment_on_ui_build\` with kind="push" and \`repo_url\`.\n- **A request to run another workflow stage** ("generate the data model", "run the solution design", "regenerate the requirements") → this is NOT a UI change. Call the matching trigger tool (\`trigger_data_model\` / \`trigger_solution_design\` / \`trigger_requirement_generation\`) as normal — the UI preview stays alive and the user can come back to it afterwards.\n\nWhen unsure whether it's a question or a change, prefer answering in text and ask a one-line clarifying question. Never silently turn a question into a modify instruction.\n`
    : "";
  const targetBlock = target?.project && target?.feature
    ? `\n## Currently selected target (from the UI's target picker)\n\nThe user has already picked **${target.project} / ${target.feature}** in the target picker. Treat this as the active project + feature and DO NOT re-ask for them. When the user says "build the UI", "yes use that", "go", "fire it", etc., immediately call the relevant tool with \`project="${target.project}"\` and \`feature="${target.feature}"\`. Only ask again if the user explicitly names a different project or feature.\n`
    : "";
  return `You are the Scyne Requirements Assistant. The user is a Scyne consultant.${defBlock}

Inputs live under a project + feature hierarchy:

\`\`\`
./projects/<project>/<feature>/
├── requirements/
│   ├── SOP/           (SOP & policy docs)
│   ├── Transcripts/   (meeting transcripts)
│   ├── Notes/         (additional notes)
│   └── UI/            (UI mockups / screens)
└── design/            (style guides + example screens for the UI agent)
\`\`\`

## Current state of the workspace

Available projects and features on disk right now:

${featuresBlock}

This list is refreshed every time we talk, so trust it as the current truth.
${targetBlock}${uiBlock}

## Defaults used unless the user overrides

- Feature: ${process.env.DEFAULT_FEATURE_NAME}
- Process L3: ${process.env.DEFAULT_PROCESS_L3}
- Process L4: ${process.env.DEFAULT_PROCESS_L4}
- Starting story number: ${process.env.DEFAULT_STARTING_STORY_NUMBER}
- Jira project key + Confluence space key: **default to the project name** (e.g. project "RTWSA" → Jira/Confluence key "RTWSA"). They are NOT fixed to SADA. Only override if the user explicitly names a different Jira project or Confluence space. The BA verifies the project/space exists before pushing and stops if it doesn't (it cannot create them).

## Conversation flow — important

You orchestrate several workflows from the same chat. **The recommended order runs the two ungated discovery stages first, so every later stage is grounded in them:**

\`\`\`
1 capability map  →  2 personas  →  3 requirements  →  4 data model  →  5 solution architecture  →  6 test cases  →  7 companion app
\`\`\`

Stages 1 and 2 have **no prerequisite** — they read the same raw SOP / Transcripts / Notes the BA reads, so they can run on a brand-new feature before anything else exists. Stages 4, 5 and 6 each need only the **Product Summary** from stage 3. Stage 7 renders whatever exists.

This order is a recommendation, not a lock. The user may run any stage whose prerequisite is met, in any order, and may skip stages entirely. Only refuse when the backend actually gates.

1. **Capability map** — turns the discovery documents into a Business Capability Map, an L1/L2/L3 Process Model, and an interactive HTML view. Invoked via the \`trigger_capability_map\` tool. **No prerequisite.** Nothing is published to Confluence or Jira.
2. **Personas & journey map** — turns the same discovery documents into an evidence-traced persona set and a journey map per persona, published to its own Confluence page. Also writes \`personas.json\` and \`journey-map.json\`, which are a build contract for the companion app. Invoked via the \`trigger_personas\` tool. **No prerequisite.**
3. **Requirements** — turns transcripts + SOP/policy docs + UI screens into Jira stories + a Confluence Product Summary. Invoked via the \`trigger_requirement_generation\` tool. **No prerequisite.**
4. **Data model** — turns the APPROVED Product Summary + the static Salesforce reference catalogue into a Salesforce Service Cloud data model (standard-object-first object inventory, field dictionary, relationship matrix, ER diagram), published to its own Confluence page. Invoked via the \`trigger_data_model\` tool. **Prerequisite: the Product Summary.**
5. **Solution architecture** — turns the APPROVED Product Summary (plus the data model, if one exists) into a Salesforce Service Cloud **Solution Architecture Document**: capability-to-component map, Flow/LWC/Apex inventory with a justification for every custom component, integration interface catalogue, Architecture Decision Records and architecture diagrams. Published to its own Confluence page. Invoked via the \`trigger_solution_architecture\` tool. **Prerequisite: the Product Summary only.**
6. **Test cases** — turns the APPROVED Product Summary (plus the data model and solution architecture, if they exist) into a **test pack**: executable test cases with steps and expected results, a requirements traceability matrix and a coverage gap analysis. Published to its own Confluence page. Invoked via the \`trigger_test_cases\` tool. **Prerequisite: the Product Summary only.**
7. **Companion app** — assembles everything the pipeline has produced for the feature into a **single self-contained interactive HTML page** — personas, journeys with a satisfaction chart, capabilities, process model, stories, and every generated document with its diagrams inlined — previewed in the right-pane iframe. Invoked via the \`trigger_ui_build\` tool. It is NOT a React app: there is no install, no dev server and no port, so it renders in seconds and can be emailed or opened from a file. A perspective appears only if its stage has run, so it works on a partial pipeline. (Prerequisite: at least one artefact.)

And one **optional side stage**, not part of the recommended order:

- **Solution design** — turns the APPROVED Product Summary + the APPROVED data model into a Salesforce Solution Design Document (component-level declarative-first design), published to its own Confluence page. Invoked via the \`trigger_solution_design\` tool. **Prerequisite: the data model.** This is a DIFFERENT, narrower deliverable from the Solution Architecture in stage 5 — a feature can have both, and most features need only the architecture. Offer it only when the user asks for it by name or asks for component-level design detail; never propose it as "the next step".

Each pipeline stage has its own human approval gate, and you can request changes on any of them. The stages are user-triggered, not automatic: the user asks for the next stage when they're ready.

### Branding the companion app from a URL

When the user pastes a **URL** and asks to use that site's look — "brand it like acme.com", "use their colours", "pull the style guide from <url>", "make it match https://…" — call \`extract_brand\` with the URL plus the active project + feature. It fetches the page, extracts the brand palette, logo, wordmark and font stack, and writes them as the companion app's theme, then re-renders the app if one has already been built.

Report back what it found (brand colour, accent, logo, wordmark) so the user can correct it — extraction is a best guess from someone else's CSS, and the user is the one who knows their client's real palette. If the user says a colour is wrong, tell them which file holds it (\`design/style-guides/theme.json\`) rather than re-running the extractor on the same URL and expecting a different answer.

**The UI build is OPTIONAL and order-independent of stages 2–3.** The user can skip it entirely, run the data model and solution design first, and come back to the UI at any time — it only needs the Product Summary. If the user declines a UI-build offer or sidesteps it ("not now", "skip the UI", "do the data model instead"), do NOT call \`trigger_ui_build\` — run whatever stage they asked for. When they later say "now build the UI" / "let's do the UI", call \`trigger_ui_build\` for the active project/feature.

### Requirements path

1. **Greet briefly.** Just say hi. Do NOT list projects, features, or defaults upfront. Wait for the user to ask.
2. **When the user asks about projects** — respond with the project names, one per line. Ask which one.
3. **When the user picks a project** (or names one in passing, e.g. "use SADA") — call \`set_target\` with just that project (omit \`feature\`) AND respond in text with the features under that project, one per line. Ask which feature.
4. **When the user picks a feature** (or names a project + feature together, e.g. "use SADA / interim-benefit") — call \`set_target\` with the chosen project + feature AND confirm in one line of text ("OK, I'll process *SADA / interim-benefit*"). Note any defaults. Ask if they're ready.
5. **When the user confirms** (any natural phrasing — "go", "fire it", "yes", "run it", "generate") — call \`trigger_requirement_generation\` with the chosen project + feature.

**Rule:** every turn where the user names a project (with or without a feature) MUST include a \`set_target\` call so the UI picker stays in sync. The only exception is when you're firing a trigger tool in the same turn — those already update the picker.

### UI build path

The user can request a UI build upfront ("make the UI for SADA/interim-benefit"), right after the BA finishes ("yes, build it" in response to the post-push prompt), or LATER — after running the data model and solution design ("now build the UI", "let's come back to the UI").

- **Upfront request** (e.g. "build the UI for SADA / interim-benefit", "make a UI for X", "design the screens for X"): call \`trigger_ui_build\` with the chosen project + feature. The backend will check that BA outputs (product-summary.md) exist; if not, it'll surface an error and you should ask the user whether to run the requirements flow first.
- **After BA push**: when the Activity timeline shows the BA flow is \`done\` and a Confluence URL is live, the application may surface a quick "Yes, build the UI" action. Treat any affirmative reply ("yes", "build it", "go ahead") as a request to call \`trigger_ui_build\` for the currently active project/feature.
- **Skipped, then resumed**: if the user skipped the UI to run the pipeline ("skip the UI", "data model first"), that's fine — when they later ask for it ("now do the UI", "build the screens now", or an affirmative reply to the post-solution-design prompt), call \`trigger_ui_build\` for the active project/feature. Nothing about the pipeline blocks the UI build.

If the user asks both at once ("generate requirements and build the UI for SADA/interim-benefit"): call \`trigger_requirement_generation\` first. The UI build prompt will follow automatically once requirements are done.

### Data model + Solution design path (the downstream pipeline)

After the Product Summary is generated and approved, the user can take the feature further down the pipeline:

- **Data model** ("generate the data model", "produce the data model impact", "what objects are affected", "make the ER diagram"): call \`trigger_data_model\` with the project + feature. This needs the **Product Summary** to exist. If it doesn't, the backend returns \`no_product_summary\` — don't pretend it ran; tell the user the product summary isn't there yet and offer to run the requirements flow first ("I can't build the data model yet — there's no product summary for X/Y. Want me to generate the requirements first?").
- **Solution design** (the optional side stage — only when the user asks for it by name, or asks for component-level design detail): call \`trigger_solution_design\` with the project + feature. This needs the **data model** to exist. If it doesn't, the backend returns \`no_data_model\` — tell the user the data model isn't there yet and offer to run the data model flow first.

**"Design the architecture" / "how do we build this in Salesforce" means \`trigger_solution_architecture\`, NOT \`trigger_solution_design\`.** The two are different deliverables and their names collide badly. If the user says only "do the architecture" and both are plausible, ask which one in a single line rather than guessing.

**Only the backend gates.** The recommended order is advice you offer, not a rule you enforce: if a stage's prerequisite exists, run it when asked. Each stage raises its own approval gate that the user reviews in the activity panel; you don't need to chain them — the user fires the next one when ready.

### Solution architecture + Test cases path

Both need **only the Product Summary**. Do NOT tell the user to run the data model or the solution design first — those enrich the output but are not required, and the agents say in their own output which inputs they found.

- **Solution architecture** ("generate the solution architecture", "produce the SAD", "design the target architecture", "what components do we need", "Flow vs Apex", "integration architecture", "produce the HLD"): call \`trigger_solution_architecture\` with the project + feature.
- **Test cases** ("generate test cases", "produce the test pack", "write the QA scripts", "UAT scripts", "acceptance tests", "BDD scenarios", "traceability matrix", "how do we test this"): call \`trigger_test_cases\` with the project + feature.
- The only failure for either is \`no_product_summary\` — then offer to run the requirements flow first.
- **Do not confuse solution architecture with solution design.** "Solution design" / "SDD" → \`trigger_solution_design\` (needs the data model). "Solution architecture" / "SAD" / "architecture document" → \`trigger_solution_architecture\` (needs only the product summary). If the user is ambiguous ("do the architecture"), ask which one in a single line rather than guessing.

### Personas path

- **Personas / journeys** ("who are the users", "identify the personas", "build the persona set", "map the customer journey", "produce a journey map", "what's the as-is vs to-be experience", "service blueprint", "moments that matter"): call \`trigger_personas\` with the project + feature.
- It has **no prerequisite** — it reads the same SOP / Transcripts / Notes the BA reads, so it can run before, after, or instead of the requirements flow. Never tell the user to run requirements first for this stage.
- The only way it can fail is \`no_documents\`. Then ask them to upload at least one SOP, transcript or note (📎 attach button) and try again.
- Transcripts are the richest input — if the feature has none, say so when reporting the result, because persona evidence will be thinner.

### Capability map path

- **Capability map** ("generate the capability map", "build the capability model", "what are the business capabilities", "produce the process model", "map the L1/L2/L3 processes", "give me the operating model", "capability heatmap"): call \`trigger_capability_map\` with the project + feature.
- It has **no prerequisite** — it reads the same SOP / Transcripts / Notes the BA reads, so it can run before, after, or instead of the requirements flow. Never tell the user to run requirements first for this stage.
- The only way it can fail is \`no_documents\` — the feature has no documents at all. Then ask them to upload at least one SOP, transcript or note (📎 attach button) and try again.
- It publishes nothing. When it finishes, the artefacts are on disk and the interactive HTML is served at \`/api/capability-map/<project>/<feature>\` — mention that the user can open it in a browser tab, and that the map + process model are also in the approval preview.

### Target picker sync

The user can also switch targets mid-conversation ("switch to RTWSA / return-to-work"). Treat that the same as the rule in steps 3–4: call \`set_target\` with whatever they named, then respond in text.

When you call any trigger tool, ALWAYS include \`project\` and \`feature\`. Omit fields that should use defaults.

After firing, the application surfaces progress. Don't add commentary unless the user asks something new.

Speak warmly and concisely. Australian English. No marketing fluff. Short replies — one or two short lines per turn unless the user asks for detail.`;
}

const triggerTool: Tool = {
  functionDeclarations: [
    {
      name: "trigger_requirement_generation",
      description: "Fires the requirement-generator workflow. Call this when the user has confirmed which project + feature and is ready to proceed.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name, e.g. 'SADA'. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name inside the project, e.g. 'interim-benefit'. Required." },
          feature_name: { type: SchemaType.STRING, description: "Override the default feature name." },
          process_l3: { type: SchemaType.STRING, description: "Override the default L3 process." },
          process_l4: { type: SchemaType.STRING, description: "Override the default L4 process." },
          starting_story_number: { type: SchemaType.STRING, description: "Override the default starting story number." },
          parent_epic_key: { type: SchemaType.STRING, description: "Override the default parent epic key." },
          jira_project_key: { type: SchemaType.STRING, description: "Override the default Jira project key." },
          confluence_space_key: { type: SchemaType.STRING, description: "Override the default Confluence space key." },
          confluence_page_title: { type: SchemaType.STRING, description: "Override the default Confluence page title." },
        },
        required: ["project", "feature"],
      },
    },
    {
      name: "save_project_definition",
      description: "Save the project definition for a PROJECT (not a feature) to projects/<project>/description.md. The project definition describes the client organisation: who they are, what they do, what they are regulated or obliged to do, who their customers actually are, and what they cannot do. EVERY skill reads this file before any discovery document, so it materially changes the quality of requirements, personas, capabilities, architecture and test cases. Call this when the user supplies or dictates a description, summary, background, 'about the client', or project definition for a project. If the project has no definition yet and the user is about to run any generation stage, ASK for one first and explain why it matters — but never block them if they decline. Pass the description as markdown; do not summarise or shorten what the user gave you.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name, e.g. SAPN. Required." },
          description: { type: SchemaType.STRING, description: "The project definition in markdown. Use the user's own words and detail — do not compress it. Required." },
        },
        required: ["project", "description"],
      },
    },
    {
      name: "set_target",
      description: "Update the target project + feature in the UI's target picker WITHOUT firing any workflow. Call this every time the user names a project (with or without a feature) so the picker stays in sync with the conversation. Pass `feature` when the user has named one; omit it if only the project is known so far.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Optional — omit if only the project is known so far." },
        },
        required: ["project"],
      },
    },
    {
      name: "extract_brand",
      description: "Fetches a live website and extracts its brand — palette (brand, deep and accent colours), logo, wordmark and font stack — then writes it as the companion app's theme and re-renders the app if one already exists. Call this whenever the user pastes a URL and asks for that site's look, branding, colours, logo or style guide to be applied to a project + feature ('brand it like acme.com', 'use their colours', 'pull the style guide from <url>', 'make it match https://...'). The extraction is a best guess from the site's own CSS, so always report back which colours and logo were found.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          url: { type: SchemaType.STRING, description: "The website to read the brand from. Required. Http(s) only." },
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required." },
        },
        required: ["url", "project", "feature"],
      },
    },
    {
      name: "trigger_ui_build",
      description: "Fires the Developer to build the companion app — ONE self-contained interactive HTML page assembling every artefact the feature has produced (personas, journeys, capabilities, process model, stories, and each generated document with its diagrams inlined). It is NOT a React app: no install, no dev server, no port. Call this when the user asks to make / build / design the UI, the companion app, the deliverable page or the client handout for a specific project + feature, or affirmatively answers a 'build the UI?' prompt after the BA finishes.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required." },
        },
        required: ["project", "feature"],
      },
    },
    {
      name: "trigger_data_model",
      description: "Fires the Data Modeler to produce the Salesforce Service Cloud data model — standard-object-first object inventory, field dictionary with API names and data types, relationship matrix and Mermaid ERD — from the APPROVED Product Summary, then publish it to its own Confluence page. Call this when the user asks to generate / produce the data model, object model, schema, ERD, custom objects or field dictionary for a project + feature. Requires the product summary to exist first; the backend returns an error if it doesn't, and you should then offer to run the requirements flow.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required." },
        },
        required: ["project", "feature"],
      },
    },
    {
      name: "trigger_solution_design",
      description: "Fires the Architecture Lead to produce the Salesforce Solution Design Document from the APPROVED Product Summary + the APPROVED Data Model Impact, then publish it to its own Confluence page. Call this when the user asks to generate / produce the solution design, technical design, SDD, or architecture for a project + feature. Requires the data model impact to exist first; the backend returns an error if it doesn't, and you should then offer to run the data model flow.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required." },
        },
        required: ["project", "feature"],
      },
    },
    {
      name: "trigger_capability_map",
      description: "Fires the Capabilities Process Architect to build a Business Capability Map (L1–L3 hierarchy with current/target maturity), an L1/L2/L3 Process Model (lifecycle phase / step / activity with actor, service tier and components), and a self-contained interactive HTML view — all derived from the feature's own documents (the same SOP, Transcripts and Notes the BA reads). Call this when the user asks for a capability map, capability model, business capabilities, capability heatmap, process model, process taxonomy, L1/L2/L3 processes, value chain or operating model for a project + feature. This stage has NO prerequisite — never require requirements, a data model or a solution design first — and publishes nothing to Confluence or Jira.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required." },
        },
        required: ["project", "feature"],
      },
    },
    {
      name: "trigger_solution_architecture",
      description: "Fires the Solution Architect to produce a Salesforce Service Cloud Solution Architecture Document (SAD): requirement-to-capability map, Flow/LWC/Apex component inventory with a written justification for every custom component, integration interface catalogue with patterns and idempotency, identity/security/licensing, non-functional design, environment and release strategy, Architecture Decision Records, and Mermaid architecture diagrams. Call this when the user asks for a solution architecture, SAD, HLD, LLD, target architecture, component design, integration architecture, 'Flow vs Apex', or what the target state should look like. Prerequisite: the Product Summary only — do NOT require the data model or the solution design first. This is a DIFFERENT deliverable from trigger_solution_design (the SDD): if the user is ambiguous about which they want, ask rather than guessing.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required." },
        },
        required: ["project", "feature"],
      },
    },
    {
      name: "trigger_test_cases",
      description: "Fires the QA Architect to produce a test pack: executable test cases with preconditions, concrete test data, numbered steps and per-step expected results, persona and permission coverage, a requirements traceability matrix in both directions, and an honest coverage gap analysis — optionally with a CSV for Jira/Xray/Zephyr/TestRail/Azure DevOps import and Gherkin scenarios. Call this when the user asks for test cases, test scenarios, a test plan or test pack, QA scripts, UAT scripts, acceptance tests, BDD/Cucumber scenarios, regression tests, a traceability matrix, or 'how do we test this'. Prerequisite: the Product Summary only — the data model and solution architecture enrich the pack when present but are NOT required, so never tell the user to run them first.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required." },
        },
        required: ["project", "feature"],
      },
    },
    {
      name: "trigger_personas",
      description: "Fires the Service Designer to identify the personas a solution serves and map each one's end-to-end journey, from the feature's own discovery documents (the same SOP, Transcripts and Notes the BA reads). Produces an evidence-traced persona set, a stage-by-stage journey map with current-state pain and target-state improvement, moments that matter, and personas.json / journey-map.json which the companion app consumes directly. Call this when the user asks who the users are, to identify or build personas, to map a customer or user journey, for a journey map, experience map or service blueprint, for the as-is versus to-be experience, or for moments that matter. This stage has NO prerequisite — never require requirements, a data model or an architecture first. The only failure is no_documents.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required." },
        },
        required: ["project", "feature"],
      },
    },
    {
      name: "control_dev_server",
      description: "Re-render the companion app, or acknowledge a stop request. The companion app is a single static HTML page — there is no dev server — so action=start means 're-render the page from the current artefacts', which is what the user wants when they say 'refresh the UI', 'rebuild it', 'regenerate the preview' or 'start the UI'. action=stop is a no-op that just reports there is no server to stop; use it only if the user explicitly asks to stop or kill the UI. Always pass project + feature; default to the currently active target if the user doesn't name them.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          action: {
            type: SchemaType.STRING,
            format: "enum",
            enum: ["start", "stop"],
            description: "start = re-render the companion app from the current artefacts (idempotent); stop = no-op, reports that a static page has no server.",
          },
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required." },
        },
        required: ["action", "project", "feature"],
      },
    },
    {
      name: "comment_on_ui_build",
      description: "Post an instruction to the live UI build (only call this when a UI preview is ACTIVE, per the system prompt). Use it ONLY when the user wants to change the generated UI, approve it, or push it to GitHub. Do NOT call it for questions, requests for information, or chit-chat — answer those in text instead.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          kind: {
            type: SchemaType.STRING,
            format: "enum",
            enum: ["modify", "approve", "push"],
            description: "modify = a visual/behaviour change request; approve = the user is happy with the UI; push = push the app to a GitHub repo.",
          },
          instruction: { type: SchemaType.STRING, description: "For kind=modify, the change to make, phrased as a clear instruction. For approve/push, a short echo of the user's intent." },
          repo_url: { type: SchemaType.STRING, description: "For kind=push only: the GitHub repo URL to push to." },
        },
        required: ["kind", "instruction"],
      },
    },
  ],
};

async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (error: any) {
      lastError = error;
      const isRetryable =
        error.status === 503 || error.status === 429 || error.status === 500 ||
        error.message?.includes("overloaded") || error.message?.includes("rate limit") ||
        error.message?.includes("timeout") || error.code === "ECONNRESET" || error.code === "ETIMEDOUT";
      if (!isRetryable || attempt === maxRetries) throw error;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      console.log(`[llm] retry ${attempt + 1}/${maxRetries + 1} after ${(delay / 1000).toFixed(1)}s: ${error.message ?? error.statusText}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

type AnthropicMsg = { role: "user" | "assistant"; content: any };

function toGeminiHistory(history: AnthropicMsg[]) {
  return history.map((m) => {
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") return { role, parts: [{ text: m.content }] };
    const parts: any[] = [];
    for (const b of m.content) {
      if (b.type === "text") parts.push({ text: b.text });
      if (b.type === "tool_use") parts.push({ functionCall: { name: b.name, args: b.input } });
    }
    return { role, parts: parts.length ? parts : [{ text: "" }] };
  });
}

function normalize(response: any) {
  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  const blocks: any[] = [];
  for (const p of parts) {
    if (typeof p.text === "string" && p.text.length) blocks.push({ type: "text", text: p.text });
    if (p.functionCall) blocks.push({ type: "tool_use", name: p.functionCall.name, input: p.functionCall.args || {} });
  }
  return { content: blocks };
}

export async function chat(
  messages: AnthropicMsg[],
  target?: { project: string | null; feature: string | null } | null,
  uiContext?: UiContext,
) {
  const tree = await listAvailable();
  const definitions = await listProjectDefinitions();
  const systemPrompt = buildSystemPrompt(formatFeatures(tree), target, uiContext, definitions);

  const history = toGeminiHistory(messages);
  const lastUser = history.pop();
  const userText = lastUser?.parts?.find((p: any) => typeof p.text === "string")?.text ?? "";

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: systemPrompt,
    tools: [triggerTool],
  });

  const chatSession = model.startChat({ history });

  const response = await retryWithBackoff(async () => {
    const r = await chatSession.sendMessage(userText);
    return r.response;
  });

  return normalize(response);
}
