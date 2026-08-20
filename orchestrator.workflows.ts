// Compiles `scripts/pipeline.mjs` into orchestrator workflows.
//
// Consumer space, deliberately: the library must not know what a "project" or a
// "feature" is, and `pipeline.mjs` stays the single source of truth for what a
// stage requires, produces and validates. Everything here is a mechanical
// transform of that graph — adding a stage there adds a workflow here.

import { STAGES, LEVEL, RENDER_CMD } from "./scripts/pipeline.mjs";
import type { AgentSpec, Step, WorkflowDef } from "./packages/orchestrator/src/index.js";

interface Stage {
  level: string; label: string; agentKey: string; skill?: string; script?: string;
  publishes: boolean; produces: string[]; producesInWorkspace?: string[];
  then?: string; optional?: boolean;
}

const S = STAGES as unknown as Record<string, Stage>;

/**
 * `produces[]` is relative to the stage's OWN level root — the single most
 * expensive convention in this file to get wrong. A feature stage that resolved
 * its outputs against the workspace root blocked a completed run in the
 * prototype: the agent had written every file correctly and the attach step was
 * looking one directory tree too high.
 */
const root = (s: Stage): string =>
  s.level === LEVEL.PROJECT ? "projects/{project}/" : "projects/{project}/{feature}/";

/** `pipeline.mjs` writes commands with `<angle>` placeholders; the engine interpolates `{brace}` ones. */
const swap = (cmd: string): string =>
  cmd.replaceAll("<project>", "{project}").replaceAll("<feature>", "{feature}");

const isProject = (s: Stage): boolean => s.level === LEVEL.PROJECT;

/** `stage.mjs` resolves the LEVEL before the name, so a project stage passes no feature. */
const stageArgs = (s: Stage, key: string): string =>
  isProject(s) ? `{project} ${key}` : `{project} "{feature}" ${key}`;

const scope = (s: Stage): string => (isProject(s) ? "{project}" : "{project} / {feature}");

const MINUTES = 60_000;

/** The primary document of a stage — the one that becomes a wiki page. */
const primaryDoc = (s: Stage): string =>
  `${root(s)}${s.produces.find(f => f.endsWith(".md")) ?? s.produces[0]}`;

const artefactKeyTpl = (key: string, s: Stage): string => (isProject(s) ? key : `{feature}/${key}`);

function attachFiles(s: Stage): string[] {
  return [
    ...s.produces.map(f => `${root(s)}${f}`),
    ...(s.producesInWorkspace ?? []).map(swap),
  ];
}

function generatePrompt(key: string, s: Stage): string {
  return [
    `Generate the ${s.label} for ${scope(s)}.`,
    ``,
    `Your inputs are already staged — \`node scripts/stage.mjs ${stageArgs(s, key)}\``,
    `has run, converted every source document to markdown, and copied the`,
    `project context into your working folder. Read what is there; do not go`,
    `looking for files outside it.`,
    ``,
    `Invoke the \`${s.skill}\` skill. It writes:`,
    ...s.produces.map(f => `  - ${root(s)}${f}`),
    ``,
    `Do not call any API. Do not publish anything. Do not change any issue`,
    `status, attach anything, or raise an approval — the orchestrator owns all`,
    `of that. Exit when your files are written.`,
  ].join("\n");
}

function approvalSummary(s: Stage): string {
  return [
    `${s.label} is ready for review.`,
    ``,
    `Files:`,
    ...attachFiles(s).map(f => `- ${f}`),
    ``,
    s.publishes
      ? `Approving publishes it to the Azure DevOps wiki. Rejecting sends it back to the ${s.agentKey} to regenerate.`
      : `Approving completes this stage. Rejecting sends it back to the ${s.agentKey} to regenerate.`,
  ].join("\n");
}

/**
 * The wiki path a stage's document lives at.
 *
 * Identity is the PATH, not a title lookup plus a remembered id — which is
 * what makes republishing a revision idempotent. Project and feature are both
 * in it so two features cannot collide on a stage name.
 */
const wikiPathTpl = (s: Stage): string =>
  isProject(s) ? `/Scyne/{project}/${s.label}` : `/Scyne/{project}/{feature}/${s.label}`;

function publishPrompt(key: string, s: Stage): string {
  const stories = key === "requirements";
  return [
    `A human has APPROVED the ${s.label} for ${scope(s)}. Publish it to the`,
    `Azure DevOps wiki.`,
    ``,
    `## Where`,
    ``,
    `- **Organisation**: the \`adoOrg\` parameter below if one is listed, otherwise`,
    `  \`ADO_ORG\` from the environment.`,
    `- **Project**: the \`adoProject\` parameter, otherwise \`ADO_PROJECT\`.`,
    `- **Wiki**: the \`adoWiki\` parameter. If none is listed, use the project's`,
    `  only wiki; if it has more than one, STOP and say so rather than guessing`,
    `  which of a client's wikis to write into.`,
    `- **Page path**: \`${wikiPathTpl(s)}\``,
    `  Keep it identical between runs. The page is identified BY PATH, which is`,
    `  what makes a revision update the same page instead of creating a second`,
    `  copy. Do not "tidy" the path.`,
    ``,
    `## How`,
    ``,
    `Use the MCP's \`wiki_upsert_page\` tool. Create or update the page at that`,
    `path with the contents of:`,
    ``,
    `    ${primaryDoc(s)}`,
    ``,
    `ADO wiki takes **markdown natively** and renders \`\`\`mermaid fences itself,`,
    `so publish the file as it is. Do not convert it, do not render diagrams to`,
    `images, and do not attach anything.`,
    ``,
    `**If that document is larger than about 40 KB, do not pass it through a tool`,
    `call.** \`wiki_upsert_page\` takes the page body as a \`content\` STRING`,
    `parameter — there is no publish-from-file form — so the whole document has`,
    `to travel through your context to reach it. Run this instead, which streams`,
    `it straight from disk:`,
    ``,
    `    node scripts/ado-publish.mjs ${primaryDoc(s)} \\`,
    `      --path "${wikiPathTpl(s)}" \\`,
    `      --published-json projects/{project}/.published.json \\`,
    `      --artefact-key "${artefactKeyTpl(key, s)}"`,
    ``,
    `That threshold is not a style preference. Measured on run SCY-6: a 110 KB`,
    `document passed to a publishing tool call was read three times while the`,
    `call was assembled, triggered a context compaction thirteen minutes in, and`,
    `ended in a loop that published nothing — $2.73 for no page. Moving bytes is`,
    `not a reasoning task.`,
    ``,
    `## Record where it went`,
    ``,
    `Write the page path and URL into \`projects/{project}/.published.json\` under`,
    `\`ado.${artefactKeyTpl(key, s)}\`, so a later revision updates this page`,
    `rather than creating a second one. (\`ado-publish.mjs\` does this itself when`,
    `you use it.)`,
    ...(stories ? [
      ``,
      `## Then push the stories as work items`,
      ``,
      `Read \`projects/{project}/{feature}/outputs/stories.json\`. For each story,`,
      `use the MCP's \`wit_work_item_write\` tool:`,
      ``,
      `- \`action\`: \`create\` — or \`update\`, when the story already carries an`,
      `  \`adoId\` from a previous run. Check that FIRST. Creating a second work`,
      `  item for a story that already has one duplicates a client's backlog,`,
      `  and nothing re-running can undo it.`,
      `- \`workItemType\`: the \`adoWorkItemType\` parameter below. **Use it exactly`,
      `  as given and do not substitute a familiar-sounding name.** "User Story"`,
      `  exists only in the Agile process template; a Basic project has`,
      `  Epic → Issue → Task and no User Story at all, so guessing fails every`,
      `  story at once. There is no MCP tool that lists a project's types, which`,
      `  is why this arrives as a parameter rather than something to look up.`,
      `- \`fields\`: an **array** of \`{name, value, format}\`, NOT an object keyed`,
      `  by field name — the server validates this and rejects the object form:`,
      ``,
      `      "fields": [`,
      `        { "name": "System.Title", "value": "<the story summary>" },`,
      `        { "name": "System.Description", "format": "Markdown",`,
      `          "value": "<the story description>" },`,
      `        { "name": "Microsoft.VSTS.Common.AcceptanceCriteria", "format": "Markdown",`,
      `          "value": "<the acceptance criteria, as a list>" }`,
      `      ]`,
      ``,
      `  \`format\` accepts \`Markdown\` or \`Html\`. Use **Markdown** — the story text`,
      `  is already markdown, and converting it to HTML only creates escaping`,
      `  mistakes.`,
      `- \`parentId\`: the \`adoParentEpicId\` parameter as a NUMBER, ONLY if one is`,
      `  listed. Omit the key entirely otherwise.`,
      `- to UPDATE, pass \`updates\`: an array of \`{op, path, value}\` with paths`,
      `  like \`/fields/System.Title\` — a different shape from \`fields\` above.`,
      ``,
      `**Replace \`{{PRODUCT_SUMMARY_URL}}\` in every description** with the wiki`,
      `URL you published above, before you create anything. A story that reaches`,
      `a client's backlog still carrying the placeholder is worse than one that`,
      `never got there.`,
      ``,
      `Then write each new work item id back into \`stories.json\` as \`adoId\`, so a`,
      `later revision updates these items instead of creating a second set.`,
      ``,
      `**If any of that goes wrong** — the type is rejected, the ids will not`,
      `write back, or there are more stories than is comfortable to do one at a`,
      `time — run this instead, which does all of the above deterministically:`,
      ``,
      `    node scripts/ado-workitems.mjs projects/{project}/{feature}/outputs/stories.json \\`,
      `      --summary-url "<the wiki page URL>" \\`,
      `      --parent <adoParentEpicId>          # only if that parameter is listed`,
      ``,
      `It discovers the work item type from the project, substitutes the URL and`,
      `refuses to write a description that still contains the placeholder, and`,
      `writes the ids back itself.`,
    ] : []),
    ``,
    `## Finish`,
    ``,
    `Print the wiki page URL on a line of its own as the last thing you`,
    `output${stories ? ", preceded by a table of story number | work item id | url" : ""}.`,
    `Do not change any issue status — the orchestrator moves the issue on when`,
    `you exit cleanly.`,
  ].join("\n");
}

export function stageWorkflow(key: string, s: Stage): WorkflowDef {
  const steps: Step[] = [
    { type: "exec", cmd: `node scripts/stage.mjs ${stageArgs(s, key)}`, timeoutMs: 10 * MINUTES },
  ];

  if (s.skill) {
    steps.push({ type: "agent", phase: "generate", skill: s.skill, effort: "high", prompt: generatePrompt(key, s) });
  } else if (s.script) {
    // `app` has no skill — it is a renderer, and a shell step is the honest
    // expression of that. Running it through an agent would spend a model call
    // to type one command.
    steps.push({ type: "exec", cmd: swap(s.script), timeoutMs: 20 * MINUTES });
  }

  // The validator that must pass before a human is asked to approve anything.
  if (s.then) steps.push({ type: "exec", cmd: swap(s.then), timeoutMs: 5 * MINUTES });

  const files = attachFiles(s);
  if (files.length) steps.push({ type: "attach", files });

  steps.push({ type: "gate", title: `Approve ${s.label} — ${scope(s)}`, summary: approvalSummary(s) });

  if (s.publishes) {
    steps.push({ type: "agent", phase: "publish", effort: "medium", prompt: publishPrompt(key, s) });
  }

  // Every stage feeds the one companion app, so it is re-rendered after each —
  // not once at the end, which would leave the chatbot's UI tab stale for hours.
  if (key !== "app") steps.push({ type: "exec", cmd: swap(RENDER_CMD), timeoutMs: 15 * MINUTES });

  return { key, label: s.label, assignee: s.agentKey, title: `${s.label} — ${scope(s)}`, steps };
}

function revisePrompt(key: string, s: Stage): string {
  return [
    `Revise the ${s.label} for ${scope(s)}. This is a REVISION, not a regeneration.`,
    ``,
    `## The reviewer's instruction, verbatim`,
    ``,
    `{instruction}`,
    ``,
    `## The current version`,
    ``,
    `Below is the artefact as it stands. Invoke the \`${s.skill}\` skill in its`,
    `**Revision mode**: preserve every section, decision, identifier and`,
    `numbering the instruction does not touch; apply the change and its genuine`,
    `consequences; append a \`## Revision History\` entry recording what changed`,
    `and why.`,
    ``,
    `A regenerate-from-scratch is a failure of this task, not a thorough job. A`,
    `human approves this by reading the diff, and a diff of everything cannot be`,
    `read — which defeats the gate the revision exists to pass.`,
    ``,
    `--- BEGIN CURRENT VERSION -------------------------------------------------`,
    `{previous}`,
    `--- END CURRENT VERSION ---------------------------------------------------`,
    ``,
    `Your other inputs have been re-staged, so read them as you would for a`,
    `fresh run wherever the instruction requires it.`,
    ``,
    `Write the revised artefact back to the same path(s):`,
    ...s.produces.map(f => `  - ${root(s)}${f}`),
    ``,
    `Do not call any API. Do not publish anything. Do not change any issue`,
    `status. Exit when your files are written.`,
  ].join("\n");
}

export function reviseWorkflow(key: string, s: Stage): WorkflowDef {
  const steps: Step[] = [
    { type: "exec", cmd: `node scripts/stage.mjs ${stageArgs(s, key)}`, timeoutMs: 10 * MINUTES },
    {
      type: "agent", phase: "revise", skill: s.skill, effort: "high",
      // The whole point of the flow: the previous version becomes {previous}.
      // A missing file blocks BEFORE the agent is spawned, which is right —
      // "revise" with nothing to revise is a caller error, not a model task.
      reads: { previous: primaryDoc(s) },
      prompt: revisePrompt(key, s),
    },
  ];
  if (s.then) steps.push({ type: "exec", cmd: swap(s.then), timeoutMs: 5 * MINUTES });
  steps.push({ type: "attach", files: attachFiles(s) });
  steps.push({
    type: "gate",
    title: `Approve revised ${s.label} — ${scope(s)}`,
    summary: [
      `The ${s.label} has been revised.`,
      ``,
      `Read the diff, not the document — the instruction should be the only`,
      `thing that changed, plus its genuine consequences.`,
      ``,
      s.publishes
        ? `Approving UPDATES the existing wiki page rather than creating a second one.`
        : `Approving completes the revision.`,
    ].join("\n"),
  });
  if (s.publishes) {
    steps.push({ type: "agent", phase: "publish", effort: "medium", prompt: publishPrompt(key, s) });
  }
  steps.push({ type: "exec", cmd: swap(RENDER_CMD), timeoutMs: 15 * MINUTES });

  // A mode of the stage it revises, not a tenth stage. The engine does not care
  // — it runs every workflow the same way — but a console listing eighteen peers
  // buries the ten anyone actually starts.
  return { key: `revise-${key}`, label: `Revise ${s.label}`, assignee: s.agentKey,
           title: `Revise ${s.label} — ${scope(s)}`,
           variantOf: key, variant: "revise", steps };
}

// Reporting lines mirror `scripts/bootstrap.mjs`'s org chart. `mcpEnabled` is
// granted ONLY to agents that publish — an Atlassian tool surface on an agent
// with nothing to push is a way to reach a client's wiki by accident.
export const ORG: AgentSpec[] = [
  { key: "ceo",          name: "CEO",               title: "Chief Executive",   icon: "crown" },
  { key: "pm",           name: "Delivery Lead",     title: "Delivery Lead",     icon: "rocket",        reportsTo: "ceo" },
  { key: "businessLead", name: "Business Lead",     title: "Business Lead",     icon: "lightbulb",     reportsTo: "pm" },
  { key: "archLead",     name: "Architecture Lead", title: "Architecture Lead", icon: "circuit-board", reportsTo: "pm",
    bundlePath: "agent-instructions/architect-lead.thin.md", mcpEnabled: true },
  { key: "ba",           name: "BA",                title: "Business Analyst",  icon: "search",        reportsTo: "businessLead",
    bundlePath: "agent-instructions/ba.thin.md", mcpEnabled: true },
  { key: "qaArchitect",  name: "QA Architect",      title: "QA Architect",      icon: "clipboard-check", reportsTo: "businessLead",
    bundlePath: "agent-instructions/qa-architect.thin.md", mcpEnabled: true },
  { key: "capArchitect", name: "Capabilities Process Architect", title: "Capabilities Process Architect",
    icon: "network", reportsTo: "archLead",
    bundlePath: "agent-instructions/capabilities-process-architect.thin.md", mcpEnabled: true },
  { key: "serviceDesigner", name: "Service Designer", title: "Service Designer", icon: "users", reportsTo: "archLead",
    bundlePath: "agent-instructions/service-designer.thin.md", mcpEnabled: true },
  { key: "dataModeler",  name: "Data Modeler",      title: "Data Modeler",      icon: "database",      reportsTo: "archLead",
    bundlePath: "agent-instructions/data-modeler.thin.md", mcpEnabled: true },
  { key: "solutionArchitect", name: "Solution Architect", title: "Solution Architect", icon: "layers", reportsTo: "archLead",
    bundlePath: "agent-instructions/solution-architect.thin.md", mcpEnabled: true },
  { key: "uxDesigner",   name: "UX Designer",       title: "UX Designer",       icon: "palette",       reportsTo: "archLead",
    bundlePath: "agent-instructions/ux-designer.thin.md" },
  { key: "ui",           name: "Developer",         title: "Developer",         icon: "code",          reportsTo: "archLead",
    bundlePath: "agent-instructions/ui.thin.md" },
];

/**
 * The project baseline: capability map, then personas, in one issue with a gate
 * after each. Sequential because journey stages align to the L1 lifecycle
 * phases the capability map defines — a real dependency, not a preference.
 * Expressed as one flat workflow rather than two `flow` steps because
 * parent-resume-on-child-completion is not implemented in the engine; a flat
 * workflow needs none of it.
 */
function baselineWorkflow(): WorkflowDef {
  const cap = stageWorkflow("capabilities", S.capabilities);
  const per = stageWorkflow("personas", S.personas);
  return {
    key: "baseline",
    label: "Project Baseline (capabilities + personas)",
    assignee: "capArchitect",
    title: "Project Baseline — {project}",
    steps: [
      ...cap.steps.map(s => (s.type === "agent" ? { ...s, agent: "capArchitect" } : s)),
      ...per.steps.map(s => (s.type === "agent" ? { ...s, agent: "serviceDesigner" } : s)),
    ],
  };
}

export function buildWorkflows(): WorkflowDef[] {
  const entries = Object.entries(S);
  const generate = entries.map(([key, s]) => stageWorkflow(key, s));
  // `app` renders the companion app from other artefacts — there is nothing to
  // revise and no skill to enter Revision mode. Every other stage gets one.
  const revise = entries.filter(([, s]) => Boolean(s.skill)).map(([key, s]) => reviseWorkflow(key, s));
  return [...generate, ...revise, baselineWorkflow()];
}
