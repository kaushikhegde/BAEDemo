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

/** Kept in step with PROJECT_OWN_DIRS in scripts/pipeline.mjs and server/index.ts. */
const PROJECT_OWN_DIRS = new Set(["solutions", "documents", "design", "original-files", "outputs"]);

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
        // Project-own folders are not features. Without this the LLM offers
        // "solutions" and "documents" as things the user can generate against.
        if (PROJECT_OWN_DIRS.has(s.name.toLowerCase())) continue;
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

## Starting a feature — the three steps before any stage runs

When the user settles on a project + feature and is about to generate anything, walk these three steps **in order**, one short turn each. Do not bundle them into one wall of text, and do not let any of them block the work.

**Step 1 — the project definition.** If the chosen project has no definition (the list above says which), ask for one now, in one sentence, and say why: every skill reads it before any discovery document, so without it they all fall back to generic industry assumptions. When the user pastes or dictates it, call \`save_project_definition\` with their words verbatim. If they'd rather not, say "no worries" and go to step 2. Ask **once per project**, never again for a second feature under it.

**Step 2 — the branding.** Ask, in one line, whether they have the client's website so the companion app comes out in the client's colours — e.g. "Got their website? I'll pull the palette and logo off it." If they give a URL, call \`extract_brand\` with it plus the project + feature, then report what it found (brand colour, accent, wordmark, logo yes/no) so they can correct it. **If they don't have one, or decline, or ignore the question — drop it immediately and move on.** The companion app falls back to the Scyne palette, which is perfectly presentable. Never ask twice, never make it a prerequisite, and never invent a URL to try.

**Step 3 — the run order.** Lay out the sequence below and tell them you'll fire the stages one at a time, waiting for their approval between each. Then fire stage 1 when they say go. **One stage per turn** — do not fire two triggers in one turn, and do not fire the next one until the previous stage's gate has been approved. After each stage completes, say what it produced in a line and name the next stage.

## Conversation flow — important

You orchestrate several workflows from the same chat, at **two levels**.

**PROJECT level — describes the client organisation. Generated once, read by every feature.**

\`\`\`
1 capability map  ->  2 personas
\`\`\`

**FEATURE level — describes one slice of work. Repeated per feature.**

\`\`\`
3 product summary + stories  ->  4 UI mockups  ->  5 data model  ->  6 solution architecture  ->  7 test cases
\`\`\`

**PROJECT level again — the deliverable.**

\`\`\`
8 companion app   (ONE page per project, covering every feature)
\`\`\`

Stage 1 has no prerequisite — it reads every document the client has given us, across all features. Stage 2 needs stage 1, because journey stages align to the capability model's L1 lifecycle phases. Stages 4-7 each need only that feature's **Product Summary**. Stage 8 renders whatever exists.

This order is a recommendation, not a lock, except where the backend actually gates. The user may run any stage whose prerequisite is met, and may skip stages.

1. **Capability map** — the Business Capability Map and the L1/L2/L3 Process Model for the PROJECT. Invoked via \`trigger_capability_map\` with a **project only**. **No prerequisite.** Publishes nothing.
2. **Personas & journey map** — the persona set and a journey per persona, for the PROJECT, published to one Confluence page per project. Its \`personas.json\` / \`journey-map.json\` are a build contract for the companion app. Invoked via \`trigger_personas\` with a **project only**. **Prerequisite: the capability map.**
3. **Requirements** — transcripts + SOP/policy docs + UI screens into Jira stories + a Confluence Product Summary, for ONE feature. Invoked via \`trigger_requirement_generation\`. **No prerequisite.**
4. **UI mockups** — wireframes of the client's future screens: one screen specification rendered as themed HTML pages, each with its error / empty / blocked states, tracing back to the stories and capabilities it realises. Invoked via \`trigger_ui_mockups\`. **Prerequisite: the Product Summary.** It runs BEFORE the data model deliberately — a client wants to see screens before committing to a schema — so the first pass carries generic field names and the application offers a refresh once the data model and test pack exist. Publishes nothing; the screens appear on the companion app's **UI** tab.
5. **Data model** — a Salesforce Service Cloud data model (standard-object-first object inventory, field dictionary, relationship matrix, ER diagram), published to its own Confluence page. Invoked via \`trigger_data_model\`. **Prerequisite: the Product Summary.**
6. **Solution architecture** — a Salesforce Service Cloud **Solution Architecture Document**: capability-to-component map, Flow/LWC/Apex inventory with a justification per custom component, integration interface catalogue, ADRs and architecture diagrams. Published to its own Confluence page. Invoked via \`trigger_solution_architecture\`. **Prerequisite: the Product Summary only.**
7. **Test cases** — a **test pack**: executable test cases with steps and expected results, a requirements traceability matrix and a coverage gap analysis. Published to its own Confluence page. Invoked via \`trigger_test_cases\`. **Prerequisite: the Product Summary only.**
8. **Companion app** — ONE self-contained interactive HTML page per PROJECT. Project tabs (personas, journeys, capabilities, process) plus feature tabs (product summary, stories, UI, data model, architecture, test cases) that open on a list of features and drill into one. Invoked via \`trigger_ui_build\` with a **project**. It is NOT a React app: no install, no dev server, no port. A tab appears only if some feature has run that stage, so it works on a partial pipeline.

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

### UI mockups path

- **UI mockups** ("generate the UI mockups", "design the screens", "what would the screens look like", "wireframes", "make a prototype", "mock up the pages", "screen designs", "form design"): call \`trigger_ui_mockups\` with the project + feature.
- **This is NOT \`trigger_ui_build\`.** \`trigger_ui_mockups\` designs *wireframes of the client's future screens* (the UX Designer). \`trigger_ui_build\` renders *the companion app* — the deliverable page that assembles the whole pack (the Developer). A feature commonly runs both, and the mockups show up on the companion app's UI tab. If the user just says "do the UI" and both are plausible, ask which one in a single line rather than guessing.
- The only failure is \`no_documents\`. It does NOT need the personas, data model, architecture or test pack — but say, when reporting the result, which of those were missing, because that is what makes screens generic.
- If the client supplied real designs in \`requirements/UI/\`, the UX Designer reflects those rather than inventing a layout. Mention it if the user asks why a screen looks the way it does.

### Personas path

- **Personas / journeys** ("who are the users", "identify the personas", "build the persona set", "map the customer journey", "produce a journey map", "what's the as-is vs to-be experience", "service blueprint", "moments that matter"): call \`trigger_personas\` with the **project only**. Do NOT pass a feature — the persona set belongs to the client, not to one slice of work.
- It reads every document the project has, across all its features, and produces ONE persona set that every feature reuses.
- **It needs the capability map.** Journey stages align to the capability model's L1 lifecycle phases. If it has not run, the backend returns \`no_capability_map\` — offer to run the capability map first.
- The other failure is \`no_documents\`. Then ask them to upload at least one SOP, transcript or note (attach button) and try again.
- Transcripts are the richest input — if the project has none, say so when reporting the result, because persona evidence will be thinner.

### Capability map path

- **Capability map** ("generate the capability map", "build the capability model", "what are the business capabilities", "produce the process model", "map the L1/L2/L3 processes", "give me the operating model", "capability heatmap"): call \`trigger_capability_map\` with the **project only**. Do NOT pass a feature.
- It has **no prerequisite** — it reads every document the client has given us, so it can run on a brand-new project before any feature exists.
- The only way it can fail is \`no_documents\`. Then ask for uploads and try again.
- It publishes nothing. When it finishes, the artefacts are on disk and appear on the project's companion app.

### Setting up a new project

- **"Create a new project", "set up a new client", "start a project"** → call \`create_project\` with the name, what the client does, and their website if they mention one. The website is optional and drives the companion app's palette and logo; never invent one.
- The project definition matters more than anything else you can collect: every skill reads it before any discovery document. Ask for a couple of sentences about who the client is, what they are regulated to do, and who their customers actually are.
- Once the project exists and its documents are uploaded, call \`bootstrap_project\` to build the baseline — it runs the capability map, then the personas, with an approval gate on each. That is ONE tool call, not two.

### Adding a feature

- **"Add a feature", "new feature", "we've scoped another piece of work"** → call \`create_feature\` with the project and the feature name.
- Then tell them to drop that feature's documents in with the attach button, and offer the product summary when they are ready.
- Features are per slice of work. The personas and capability map are already there — do NOT re-run those for a new feature.

### Changing something already generated — the revision path

This is half of what the user asks you for. The chat does not only *run* stages; it **changes** what they produced.

When the user asks for a change to an artefact that already exists — "add an SLA breach field to the data model", "reword story 2.4.1.3", "the personas are too generic", "make the lodgement screen a map picker", "add a negative test for the expired-permit path", "the architecture should use Platform Events, not a queue" — call \`revise_artefact\` with:

- \`project\` (and \`feature\`, for everything except the capability map and personas),
- \`artefact\`: one of \`capabilities\`, \`personas\`, \`requirements\`, \`ui\`, \`datamodel\`, \`architecture\`, \`qa\`, \`design\`,
- \`instruction\`: **the user's own words, verbatim.** Do not summarise, tidy or reinterpret. The owning specialist needs what the user actually said; your paraphrase is how a revision ends up doing the wrong thing.

It routes to the same specialist that produced the artefact, which revises rather than regenerates, raises a fresh approval gate, and on approval updates the existing Confluence page instead of creating a second one.

Rules:

1. **Only for artefacts that already exist.** If the stage has not run, the backend returns \`not_generated\` — offer to generate it instead.
2. **Work out which artefact from what they are describing**, not from the word they used. "The screen should show the permit number" is the UI mockups. "Permit number needs to be a field" is the data model. If genuinely ambiguous, ask in one line.
3. **A question is not a revision.** "Why does the data model use Case?" is answered in text. Only call \`revise_artefact\` when they want something changed.
4. **Never claim you changed something yourself.** You raise the request; the specialist does the work and the human approves it.
5. **"Solution design" and "solution architecture" collide.** If the user says only "the architecture" and both exist, ask which.

### Keeping the pack consistent

When an upstream artefact changes, the ones generated from it are now out of date. The application tracks this and tells you which. When it does, say so in one line and offer to refresh them — then wait. Never refresh anything without being asked: the user may have deliberately approved the downstream document as it stands.

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
          project: { type: SchemaType.STRING, description: "Project folder name. Required. Branding is per project — one companion app, one palette." },
        },
        required: ["url", "project"],
      },
    },
    {
      name: "trigger_ui_build",
      description: "Fires the Developer to build the companion app — ONE self-contained interactive HTML page per PROJECT, assembling everything the pipeline has produced: the client's personas, journeys, capabilities and process model, then each feature's product summary, stories, mockups, data model, architecture and test pack behind a feature list you drill into. It is NOT a React app: no install, no dev server, no port. Call this when the user asks to make / build / refresh the companion app, the deliverable page or the client handout. Pass the project; a feature is optional context only, since the page covers every feature. It gates on 'any artefact exists', so it works on a partial pipeline.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Optional — which feature prompted the build. The page covers every feature regardless." },
        },
        required: ["project"],
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
      description: "Fires the Capabilities Process Architect to build a Business Capability Map (L1-L3 hierarchy with current/target maturity) and an L1/L2/L3 Process Model (lifecycle phase / step / activity with actor, service tier and components) for a PROJECT, derived from every document the client has given us across all of its features. Call this when the user asks for a capability map, capability model, business capabilities, capability heatmap, process model, process taxonomy, L1/L2/L3 processes, value chain or operating model. This is a PROJECT-level artefact: pass the project ONLY, never a feature — it describes the client organisation, not one slice of work. It has NO prerequisite (never require requirements, a data model or a solution design first) and publishes nothing to Confluence or Jira.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required. Do NOT pass a feature — this artefact is project-level." },
        },
        required: ["project"],
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
      description: "Fires the Service Designer to identify the personas a CLIENT serves and map each one's end-to-end journey, from every document the project has across all of its features. Produces an evidence-traced persona set, a stage-by-stage journey map with current-state pain and target-state improvement, moments that matter, and personas.json / journey-map.json which the companion app consumes directly. Call this when the user asks who the users are, to identify or build personas, to map a customer or user journey, for a journey map, experience map or service blueprint, for the as-is versus to-be experience, or for moments that matter. This is a PROJECT-level artefact: pass the project ONLY, never a feature. Prerequisite: the CAPABILITY MAP — journey stages align to its L1 lifecycle phases — so the backend returns no_capability_map if it has not run, and you should offer to run it first. Never require requirements, a data model or an architecture.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required. Do NOT pass a feature — this artefact is project-level." },
        },
        required: ["project"],
      },
    },
    {
      name: "trigger_ui_mockups",
      description: "Fires the UX Designer to produce UI mockups (wireframes) for a feature from everything it has produced — discovery documents, personas and journeys, capabilities, product summary, data model, solution architecture and test cases. Produces a screen specification rendered as self-contained themed HTML pages, one per screen, each showing its error / empty / blocked states and tracing back to the stories and capabilities it realises; they are linked from the companion app's UI tab. Call this when the user asks to generate UI mockups, design the screens, produce wireframes, mock up the pages, build a prototype, do the screen or form design, or asks 'what would the screens look like'. Prerequisite: either the Product Summary or the discovery documents — never require the personas, data model, architecture or test pack, though the screens are much more specific when those exist. Publishes nothing to Confluence or Jira. This is a DIFFERENT deliverable from trigger_ui_build (which renders the companion app page): if the user is ambiguous about which they want, ask rather than guessing.",
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
      name: "create_project",
      description: "Creates a new PROJECT on disk: the folder tree, the project definition, and optionally the client's branding pulled from their website. Call this when the user asks to create/start/set up a new project or a new client. The definition is what every skill reads before any discovery document, so collect a couple of real sentences about who the client is, what they are regulated or obliged to do, and who their customers actually are — do not invent them, and do not pad. The website is optional; never guess a URL. After this succeeds, tell the user to upload the client's documents with the attach button, then call bootstrap_project.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "The project name, which becomes its folder. Letters, numbers, spaces and . _ & - only. Required." },
          description: { type: SchemaType.STRING, description: "The project definition in markdown - who the client is, what they do, what they are regulated to do, who their customers really are, what they cannot do. Use the user's own words and detail; do not compress. At least a couple of sentences." },
          website: { type: SchemaType.STRING, description: "Optional. The client's website, used to extract the palette, logo and wordmark for the companion app. Only pass a URL the user actually gave you." },
        },
        required: ["project"],
      },
    },
    {
      name: "bootstrap_project",
      description: "Builds a project's baseline in one step: the capability map, then the personas, sequentially, each with its own approval gate. Call this once a new project has its documents uploaded, or when the user asks to 'set up' / 'get started on' / 'do the discovery for' a project. This is ONE call - do not also call trigger_capability_map and trigger_personas. Fails with no_documents if the project has no markdown documents yet; then ask for uploads rather than retrying.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
        },
        required: ["project"],
      },
    },
    {
      name: "create_feature",
      description: "Creates a new FEATURE under an existing project - one slice of work, with its own requirements folders and its own product summary, mockups, data model, architecture and test pack. Call this when the user asks to add a feature, start another piece of work, or scope something new under a project. Do NOT re-run the capability map or personas for it: those are project-level and it inherits them. After this succeeds, tell the user to drop that feature's documents in with the attach button.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "The feature name, which becomes its folder. Required. Cannot be 'capabilities', 'personas', 'solutions', 'documents' or 'design' - those are reserved." },
        },
        required: ["project", "feature"],
      },
    },
    {
      name: "revise_artefact",
      description: "Requests a CHANGE to an artefact that has already been generated, routed to the specialist that produced it. Call this whenever the user wants something different in an existing product summary, user story, UI mockup, data model, solution architecture, test pack, persona set or capability map - 'add an SLA breach field to the data model', 'reword story 2.4.1.3', 'the personas are too generic', 'make the lodgement screen a map picker', 'add a negative test for the expired permit path'. Work out which artefact from what they are DESCRIBING, not from the word they used: 'the screen should show the permit number' is the UI mockups; 'permit number needs to be a field' is the data model. The specialist revises rather than regenerates, raises a fresh approval gate, and on approval updates the existing Confluence page rather than creating a second one. Do NOT call this for questions ('why does the data model use Case?') - answer those in text. Do NOT call it for a stage that has not run - offer to generate it instead.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required for every artefact EXCEPT capabilities and personas, which are project-level." },
          artefact: {
            type: SchemaType.STRING,
            format: "enum",
            enum: ["capabilities", "personas", "requirements", "ui", "datamodel", "architecture", "qa", "design"],
            description: "Which artefact to change. capabilities = capability map + process model (project). personas = persona set + journeys (project). requirements = product summary + stories. ui = UI mockups. datamodel = Salesforce data model. architecture = Solution Architecture Document. qa = test pack. design = Solution Design Document (the optional side stage - NOT the same as architecture).",
          },
          instruction: { type: SchemaType.STRING, description: "The change, in the USER'S OWN WORDS, verbatim. Do not summarise, tidy or reinterpret - the specialist needs what the user actually said. Required." },
        },
        required: ["project", "artefact", "instruction"],
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
