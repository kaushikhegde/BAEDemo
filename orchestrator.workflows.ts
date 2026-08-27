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
  /**
   * Whether this stage raises a human approval gate. Absent means yes — a
   * stage author gets the gate by default and has to opt out deliberately.
   *
   * Separate from `publishes` on purpose: they answer different questions.
   * `app` publishes nothing and keeps its gate; `ui` publishes nothing and
   * does not.
   */
  gates?: boolean;

  /**
   * Whether this stage re-renders the companion app afterwards. Absent means
   * yes — a stage author gets the render by default and opts out deliberately.
   *
   * Two stages do. `app` IS the render. `extract` runs at order 0 and produces
   * only internal extracts, so on a new project the renderer has nothing to
   * show and refuses, which as a workflow step means a blocked issue.
   */
  renders?: boolean;
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
/**
 * `<project>` / `<feature>` in pipeline.mjs become the engine's placeholders,
 * ALWAYS quoted.
 *
 * An `exec` step runs through `child_process.exec`, which is `/bin/sh -c`, so
 * an unquoted placeholder word-splits. A project called `SA Demo` reached
 * `stage.mjs` as two argv entries and it refused with
 * `no such project: projects/SA` — naming a project nobody had typed, while
 * listing `SA Demo` as available two lines below. Feature names happened to be
 * quoted by hand in `stageArgs` and project names were not, and `<feature>` in
 * `render-mockups.mjs <project> <feature>` was bare as well, so every feature
 * with a space in it had the same fault waiting.
 *
 * Quoting HERE rather than in each template is what keeps "add a stage to
 * pipeline.mjs and get a workflow for free" true: a stage author cannot forget
 * it, and there is no second place for the two to disagree. An already-quoted
 * form is absorbed rather than doubled — `""x""` is two words to a shell, not
 * one, so naive wrapping would break exactly what it set out to fix.
 */
const swap = (cmd: string): string =>
  cmd
    .replaceAll(/"?<project>"?/g, '"{project}"')
    .replaceAll(/"?<feature>"?/g, '"{feature}"');

const isProject = (s: Stage): boolean => s.level === LEVEL.PROJECT;

/** `stage.mjs` resolves the LEVEL before the name, so a project stage passes no feature. */
const stageArgs = (s: Stage, key: string): string =>
  isProject(s) ? `"{project}" ${key}` : `"{project}" "{feature}" ${key}`;

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
 * what makes republishing a revision idempotent. The Scyne project is NOT in
 * the path: each one has its own Azure DevOps project now, so the wiki already
 * belongs to exactly one client and a `/Scyne/{project}/` prefix would only
 * repeat the container's name inside it. The feature IS, so two features
 * cannot collide on a stage name.
 *
 * This is a FIRST-publish path only. An artefact already recorded in
 * `.published.json` keeps the path it was published at — see `resolvePagePath`
 * in `scripts/lib/ado.mjs`, which is what stops a change here from moving a
 * page a client already has a link to.
 */
const wikiPathTpl = (s: Stage): string =>
  isProject(s) ? `/${s.label}` : `/{feature}/${s.label}`;

/**
 * The container pages above an artefact, outermost first.
 *
 * Azure DevOps does NOT create these for you: upsert a page at
 * `/Scyne/RTWSA/Appeals/Data Model` with no `/Scyne/RTWSA/Appeals` and the page
 * exists but is unreachable by browsing the tree — a client finds it only by
 * search, which is not how anyone reads a delivery pack.
 *
 * Derived from `wikiPathTpl` rather than written out beside it, so a change to
 * the path shape cannot leave the parent list describing the old one.
 */
const parentPagesTpl = (s: Stage): string[] => {
  const parts = wikiPathTpl(s).split("/").filter(Boolean).slice(0, -1);
  return parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/"));
};

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
    `- **Project**: the \`adoProject\` parameter if one is listed, otherwise the`,
    `  \`adoTarget.project\` recorded in \`projects/{project}/.published.json\`.`,
    `  There is no environment fallback: ONE Azure DevOps project for the whole`,
    `  installation is exactly what per-project targets replaced, and guessing`,
    `  one would publish a client's document into another client's project. If`,
    `  neither is present, STOP and say the project has no Azure DevOps target.`,
    `- **Wiki**: the \`adoWiki\` parameter. If none is listed, use the project's`,
    `  only wiki; if it has more than one, STOP and say so rather than guessing`,
    `  which of a client's wikis to write into.`,
    `- **Page path**: \`${wikiPathTpl(s)}\``,
    `  Keep it identical between runs. The page is identified BY PATH, which is`,
    `  what makes a revision update the same page instead of creating a second`,
    `  copy. Do not "tidy" the path.`,
    ``,
    `### Create the parents first, in this order`,
    ``,
    ...parentPagesTpl(s).map((p, i) =>
      `${i + 1}. \`${p}\` — a container. If it exists, leave its content alone.`),
    `${parentPagesTpl(s).length + 1}. \`${wikiPathTpl(s)}\` — the document itself.`,
    ``,
    `A wiki page whose parent does not exist is created detached, so the client`,
    `opens the wiki and cannot find it by browsing — only by search. Creating`,
    `the branch top-down is what makes one project's work read as one tree`,
    `instead of a flat list of unrelated pages. For a container that does not`,
    `exist yet, a single line naming it is enough content; do not invent a`,
    `summary of work you have not been shown.`,
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
      `## The backlog is not yours to create`,
      ``,
      `This stage delivers two things — this page, and one work item per story.`,
      `You publish the page. You do NOT create the work items: the step`,
      `immediately after this one runs \`scripts/ado-workitems.mjs\`, which reads`,
      `\`projects/{project}/{feature}/outputs/stories.json\`, discovers the`,
      `project's work item type, substitutes the wiki URL, creates or UPDATES`,
      `each item, and writes every new id back into that file.`,
      ``,
      `That used to be your job, described here as a loop of`,
      `\`wit_work_item_write\` calls, and it is not one any more because of how it`,
      `failed. Measured on SA-Power-Networks: 45 stories, the page published,`,
      `**zero** work items created, and the turn finished normally — exit 0. An`,
      `exit code says a model stopped talking; it has never said the work`,
      `happened. Forty-five sequential tool calls in one turn is not a reasoning`,
      `task, and the one part of it that cannot be undone — a duplicated backlog`,
      `in a client's project — is the part a retry makes worse.`,
      ``,
      `So do not call \`wit_work_item_write\` at all. What the next step needs`,
      `from you is the record described under **Record where it went** above: it`,
      `reads the page URL back out of \`.published.json\`, so **write the \`url\``,
      `field**, not only the path.`,
    ] : []),
    ``,
    `## Finish`,
    ``,
    `Print the wiki page URL on a line of its own as the last thing you output.`,
    `Do not change any issue status — the orchestrator moves the issue on when`,
    `you exit cleanly.`,
  ].join("\n");
}

/**
 * The step that makes a publish PROVE itself.
 *
 * Every other stage is guarded by its `produces` files: the artefact lands on
 * disk and `attach` blocks if it did not. A publish leaves nothing on this
 * machine — the output is on somebody else's server — so it was the one step
 * in the pipeline whose success was taken on the agent's word.
 *
 * SCY-1 is why that is not good enough. Its publish agent could not reach
 * Azure DevOps, said so in prose, and finished its turn: exit 0. The engine
 * recorded `succeeded`, the timeline read "finished publish in 8m 20s", and
 * the issue closed **`done`** with no wiki page and no `.published.json`.
 *
 * An agent's exit code says the MODEL finished talking. It has never said the
 * WORK happened, and for a publish those are entirely different claims.
 *
 * It is an `exec` rather than another agent turn on purpose: exec steps are
 * never retried, run outside the agent sandbox, and cost nothing — and asking
 * a model whether a model succeeded is not a check.
 */
/**
 * Make sure the Azure DevOps project exists before anything tries to publish
 * into it.
 *
 * A capability-map publish failed its verifier with `TF200016: The following
 * project does not exist` — the target recorded in `.published.json` had never
 * been created in Azure DevOps, because the wizard is allowed to fail its
 * creation step without failing the project (the tree, definition and branding
 * are real and worth keeping). Nothing noticed until a human had approved a
 * document that then had nowhere to go.
 *
 * BEFORE the publish, deliberately, not inside the verifier: a judge that
 * repairs what it is judging cannot fail it. A failure here refuses with
 * nothing published, which is the same clean refusal the "verify, never
 * create" rule at the approval gate was protecting — just earlier, and without
 * a human waiting on it.
 *
 * Only `{project}` is interpolated. Every workflow has one; `adoOrg` is
 * optional, and a placeholder the engine cannot fill blocks the run with
 * `unknown placeholder` — which is how the requirements publish broke once
 * already. The script resolves the org from the recorded target, then ADO_ORG.
 */
function ensureAdoProjectStep(): Step {
  return {
    type: "exec",
    label: "Making sure the Azure DevOps project exists",
    cmd: `node --import tsx scripts/ensure-ado-project.mts "{project}"`,
    timeoutMs: 5 * MINUTES,
  };
}

/**
 * Push a stage's outputs to blob.
 *
 * Blob is the source of truth for projects/; the local tree is a cache. An
 * agent writes its artefacts to disk, so without this they exist only in the
 * cache and a `syncDown` on another day would not restore them.
 *
 * An `exec` step rather than a paragraph in a prompt, for the same reason
 * work-item creation is a step: an instruction a model may or may not
 * follow, running beside a script that always does, is how you get half a
 * backlog. This one is added ONCE, here, so every compiled workflow inherits
 * it — the same "add a stage, get it for free" discipline the rest of this
 * file relies on.
 *
 * Placed as the LAST step of every workflow it appears in — after `attach`
 * (so it can never race the agent still writing) and after the publish +
 * verify sequence where one exists (so `.published.json`, which the publish
 * step writes, goes up too).
 *
 * Non-fatal by design: the staged files, the upload and this workflow's
 * outputs are all real whether or not blob heard about it. An ordinary exec
 * step's non-zero exit BLOCKS the issue — exactly wrong here, since a sync
 * hiccup is not a reason to hold a client's finished artefact hostage at a
 * step nobody can see the point of retrying. The `|| echo` fallback keeps
 * this step's own exit code at 0 no matter what `sync.mjs` does; a real
 * failure is still on stderr from the inner command if anyone goes looking,
 * it just never reaches the blocking path.
 *
 * `--prefix "{feature}"` narrows a feature stage's push to that feature's own
 * subtree, matching `root(s)` above — a feature stage's `produces[]` never
 * reaches outside `projects/{project}/{feature}/`, and scoping the sync the
 * same way keeps one feature's push from re-hashing every other feature's
 * tree. A project stage has no feature to scope to, so it pushes the whole
 * project.
 */
function syncOutputsStep(s: Stage): Step {
  const prefix = s.level === LEVEL.FEATURE ? ` --prefix "{feature}"` : "";
  const sync =
    `plugins/aws-file-processing/node_modules/.bin/tsx ` +
    `plugins/aws-file-processing/scripts/sync.mjs "{project}" --up --root "{workspace}"${prefix}`;
  return {
    type: "exec",
    label: "Saving this stage's outputs",
    cmd: `(${sync}) || echo "workspace sync skipped — continuing"`,
    timeoutMs: 10 * MINUTES,
  };
}

/**
 * Create the client's backlog, deterministically.
 *
 * The requirements stage is the only one whose deliverable is a page AND a set
 * of work items, and the second half used to be a paragraph in `publishPrompt`
 * asking the publishing agent to call `wit_work_item_write` once per story.
 *
 * SA-Power-Networks / CRM-Management is why it is a step instead. 45 stories,
 * the wiki page published cleanly, **zero** work items, and the agent's turn
 * finished normally — so the run recorded `succeeded`, and only
 * `verify-published.mjs` caught it, one step later, with the stage already
 * paid for.
 *
 * Three things make this the right shape rather than a better prompt:
 *
 * - **It cannot half-finish quietly.** A non-zero exit blocks the issue with
 *   the real stderr. A model that stops after 20 of 45 items exits 0.
 * - **It is idempotent.** The created id is written back into `stories.json`
 *   per story, so a re-run UPDATES instead of creating a second backlog — the
 *   one failure here that no amount of re-running can undo.
 * - **It discovers the work item type.** "User Story" exists only under Agile;
 *   a Basic project has Epic -> Issue -> Task and no User Story at all, and no
 *   MCP tool can enumerate a project's types.
 *
 * `--summary-url` is deliberately not passed: that URL does not exist when
 * this command is compiled. The script reads it back out of the
 * `ado.<artefact>` record the publish step wrote moments earlier — which is
 * why the publish prompt now insists on the `url` field, not the path alone.
 *
 * No `rewindOnFailure`: this step does the work rather than judging somebody
 * else's, so a Resume re-runs THIS step, cheaply and idempotently, instead of
 * spending another publish agent.
 */
function createWorkItemsStep(key: string, s: Stage): Step {
  return {
    type: "exec",
    label: "Creating the work items",
    cmd: `node scripts/ado-workitems.mjs "projects/{project}/{feature}/outputs/stories.json"` +
         ` --published-json "projects/{project}/.published.json"` +
         ` --artefact-key "${artefactKeyTpl(key, s)}"`,
    timeoutMs: 15 * MINUTES,
  };
}

function verifyPublishStep(key: string, s: Stage, publishStepIndex: number): Step {
  return {
    type: "exec",
    label: "Confirming the page is really there",
    cmd: `node scripts/verify-published.mjs "{project}"` +
         ` --artefact "${artefactKeyTpl(key, s)}"` +
         ` --path "${wikiPathTpl(s)}"` +
         // The requirements stage is the only one whose deliverable is a page
         // AND a backlog, and the backlog half had nothing checking it: a
         // published page with zero work items closed the issue green.
         // Same condition as `stories` in publishPrompt, for the same reason.
         (key === "requirements"
           ? ` --stories "projects/{project}/{feature}/outputs/stories.json"`
           : ""),
    timeoutMs: 5 * MINUTES,
    // This step judges the PUBLISH step, so a failure has to send Resume back
    // there. Without it the issue parks on the verifier and every Resume
    // re-runs the check — which cannot pass, because the publish step already
    // recorded `succeeded` and is never re-run. SCY-1 sat in exactly that loop.
    rewindOnFailure: publishStepIndex,
  };
}

export function stageWorkflow(key: string, s: Stage): WorkflowDef {
  const steps: Step[] = [
    // Every exec step carries a `label`, and the engine narrates THAT rather
    // than the command. The issue timeline is what a client watches in the
    // chatbot while their run proceeds: `node scripts/stage.mjs SAPN qa` tells
    // them nothing they wanted to know, and discloses a path on our machine.
    // The command is still recorded verbatim if the step fails.
    { type: "exec", label: "Gathering the inputs", cmd: `node scripts/stage.mjs ${stageArgs(s, key)}`, timeoutMs: 10 * MINUTES },
  ];

  if (s.skill) {
    steps.push({ type: "agent", phase: "generate", skill: s.skill, effort: "high", prompt: generatePrompt(key, s) });
  } else if (s.script) {
    // `app` has no skill — it is a renderer, and a shell step is the honest
    // expression of that. Running it through an agent would spend a model call
    // to type one command.
    steps.push({ type: "exec", label: `Building the ${s.label.toLowerCase()}`, cmd: swap(s.script), timeoutMs: 20 * MINUTES });
  }

  // The validator that must pass before a human is asked to approve anything.
  if (s.then) steps.push({ type: "exec", label: "Checking the output", cmd: swap(s.then), timeoutMs: 5 * MINUTES });

  const files = attachFiles(s);
  if (files.length) steps.push({ type: "attach", files });

  // `gates: false` opts a stage out. Declared on the STAGE rather than
  // derived from `publishes`, because they are different questions: `app`
  // publishes nothing either and keeps its gate. A stage author who adds a
  // stage gets the gate by default and has to say otherwise.
  if (s.gates !== false) {
    steps.push({ type: "gate", title: `Approve ${s.label} — ${scope(s)}`, summary: approvalSummary(s) });
  }

  if (s.publishes) {
    steps.push(ensureAdoProjectStep());
    // Captured rather than hard-coded as "one back": the index is read off the
    // array as it is being built, so inserting anything between publish and
    // its verifier cannot silently point the rewind at the wrong step.
    const publishAt = steps.length;
    // `agent: "publisher"` rather than the stage's own specialist — see the
    // note on the `publisher` entry in ORG. Publishing is the same job for
    // every stage and needs none of the domain brief that produced the
    // artefact; being handed one is what turned a publish into a rewrite.
    steps.push({ type: "agent", agent: "publisher", phase: "publish", effort: "medium", prompt: publishPrompt(key, s) });
    // Requirements is the only stage delivering a backlog as well as a page.
    // Same condition as `stories` in publishPrompt, which now tells the
    // agent NOT to create them — the two must agree or they are made twice.
    if (key === "requirements") steps.push(createWorkItemsStep(key, s));
    steps.push(verifyPublishStep(key, s, publishAt));
  }

  // Every stage feeds the one companion app, so it is re-rendered after each —
  // not once at the end, which would leave the chatbot's UI tab stale for hours.
  //
  // `renders: false` opts a stage out, declared on the STAGE rather than
  // tested for by key here. It used to read `key !== "app"`, which was right
  // about `app` (that stage IS the render) and silently wrong about `extract`:
  // extraction runs at order 0, so a new project reaches this step having
  // produced nothing the companion app shows — extracts are internal and never
  // reach a rendered page — and `render-companion-app.mjs` refuses by design
  // with `nothing to render — no artefacts found`. A deliberate, correct
  // refusal became a blocked issue on the first stage of every new project.
  if (s.renders !== false) {
    steps.push({ type: "exec", label: "Updating the companion app", cmd: swap(RENDER_CMD), timeoutMs: 15 * MINUTES });
  }

  // Last, so it is after attach and after the publish + verify sequence
  // (where one exists) unconditionally — see the doc comment above.
  steps.push(syncOutputsStep(s));

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
    { type: "exec", label: "Gathering the inputs", cmd: `node scripts/stage.mjs ${stageArgs(s, key)}`, timeoutMs: 10 * MINUTES },
    {
      type: "agent", phase: "revise", skill: s.skill, effort: "high",
      // The whole point of the flow: the previous version becomes {previous}.
      // A missing file blocks BEFORE the agent is spawned, which is right —
      // "revise" with nothing to revise is a caller error, not a model task.
      reads: { previous: primaryDoc(s) },
      prompt: revisePrompt(key, s),
    },
  ];
  if (s.then) steps.push({ type: "exec", label: "Checking the revision", cmd: swap(s.then), timeoutMs: 5 * MINUTES });
  steps.push({ type: "attach", files: attachFiles(s) });
  // Same opt-out as the generate variant: a revision of a stage that gates
  // nothing has nothing to gate either.
  if (s.gates !== false) {
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
  }
  if (s.publishes) {
    steps.push(ensureAdoProjectStep());
    // Captured rather than hard-coded as "one back": the index is read off the
    // array as it is being built, so inserting anything between publish and
    // its verifier cannot silently point the rewind at the wrong step.
    const publishAt = steps.length;
    // `agent: "publisher"` rather than the stage's own specialist — see the
    // note on the `publisher` entry in ORG. Publishing is the same job for
    // every stage and needs none of the domain brief that produced the
    // artefact; being handed one is what turned a publish into a rewrite.
    steps.push({ type: "agent", agent: "publisher", phase: "publish", effort: "medium", prompt: publishPrompt(key, s) });
    // Requirements is the only stage delivering a backlog as well as a page.
    // Same condition as `stories` in publishPrompt, which now tells the
    // agent NOT to create them — the two must agree or they are made twice.
    if (key === "requirements") steps.push(createWorkItemsStep(key, s));
    steps.push(verifyPublishStep(key, s, publishAt));
  }
  steps.push({ type: "exec", label: "Updating the companion app", cmd: swap(RENDER_CMD), timeoutMs: 15 * MINUTES });
  steps.push(syncOutputsStep(s));

  // A mode of the stage it revises, not a tenth stage. The engine does not care
  // — it runs every workflow the same way — but a console listing eighteen peers
  // buries the ten anyone actually starts.
  return { key: `revise-${key}`, label: `Revise ${s.label}`, assignee: s.agentKey,
           title: `Revise ${s.label} — ${scope(s)}`,
           variantOf: key, variant: "revise", steps };
}

/**
 * Publish an artefact that already exists, without regenerating it.
 *
 * "Can you publish the user stories again" used to reach `revise_artefact` —
 * the only tool whose description mentioned an artefact that already exists —
 * so a request to push a finished document started a full agent regeneration
 * and offered a diff nobody asked for. The publish agent was always the right
 * worker; there was simply no way to ask for it on its own.
 *
 * No `stage.mjs` step: `publishPrompt` reads the stage's own `outputs/` path,
 * not a staged working copy, so there is nothing to gather.
 *
 * The gate stays. Nothing has been regenerated, but the artefact on disk may
 * have been edited since it was approved, and this is the last point before it
 * reaches a client's wiki.
 */
export function publishWorkflow(key: string, s: Stage): WorkflowDef {
  const steps: Step[] = [
    {
      type: "gate",
      title: `Approve republish of ${s.label} — ${scope(s)}`,
      summary: [
        `Republish the ${s.label} for ${scope(s)}.`,
        ``,
        `**Nothing has been regenerated.** This publishes the document exactly`,
        `as it stands on disk, to the page it already has, and creates nothing`,
        `new — a revision is the other thing, and this is not it.`,
        ...(key === "requirements" ? [
          ``,
          `The work items go with it: stories that already carry an \`adoId\` are`,
          `updated, and any without one are created.`,
        ] : []),
      ].join("\n"),
    },
  ];
  steps.push(ensureAdoProjectStep());
  const publishAt = steps.length;
  steps.push({ type: "agent", agent: "publisher", phase: "publish", effort: "medium", prompt: publishPrompt(key, s) });
  // Requirements is the only stage delivering a backlog as well as a page.
  // Same condition as `stories` in publishPrompt, which now tells the
  // agent NOT to create them — the two must agree or they are made twice.
  if (key === "requirements") steps.push(createWorkItemsStep(key, s));
  steps.push(verifyPublishStep(key, s, publishAt));
  // Publishing writes `.published.json`, so the record of where the page
  // went is itself an output worth pushing to blob.
  steps.push(syncOutputsStep(s));

  return {
    key: `publish-${key}`,
    label: `Republish ${s.label}`,
    assignee: s.agentKey,
    title: `Republish ${s.label} — ${scope(s)}`,
    variantOf: key,
    variant: "publish",
    steps,
  };
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
  // Every stage's publish step runs as THIS agent, not as the specialist that
  // generated the artefact. There is one system prompt per agent, and each
  // specialist's is written entirely in generate terms — "your inputs are
  // staged", "invoke your skill", "the validator must pass after you". Handing
  // that to a publish step means the model reads a brief to generate and a task
  // to publish, and the brief is the one it wakes up holding.
  //
  // Measured on the personas publish for SAPN (run d3b42b39, issue 8fc6b03f
  // step 5): the Service Designer's prompt states that journey stages must
  // align to the capability map's L1 phases and that validate-experience.mjs
  // must pass. The publish agent read that, went and re-read the capability map
  // and process model, rewrote personas-journeys.md four times, re-normalised
  // journey-map.json, stamped the document "1.0 (Approved)" itself — and then
  // published it. What reached the wiki was not what the human approved at the
  // gate one step earlier, and it took 14 minutes and 2.5M tokens to get there.
  //
  // The publish prompt already said none of that. It lost to the system prompt
  // above it, which is not an argument a prompt wins reliably — so the publish
  // step no longer receives one that disagrees with it.
  { key: "publisher",    name: "Publisher",         title: "Publisher",         icon: "upload-cloud",  reportsTo: "pm",
    bundlePath: "agent-instructions/publisher.thin.md", mcpEnabled: true },
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

  /**
   * Re-base any step index a step carries onto its position in the COMBINED
   * list.
   *
   * `rewindOnFailure` is an index into the workflow the step belongs to. Glue
   * two workflows together and every index in the second half is silently off
   * by the length of the first: the personas verifier said "rewind to 6", which
   * inside its own workflow is the personas publish and inside `baseline` is
   * the CAPABILITIES publish. A failed personas publish therefore re-published
   * the capability map — a page nobody asked to touch, at twenty-five minutes
   * and real money — and never retried the step that actually failed.
   *
   * Applied to both halves, with `cap` at offset 0, so the first half is not a
   * special case that happens to work.
   *
   * The `type === "exec"` test is what makes this type-check: `rewindOnFailure`
   * is declared on the exec member of `Step` alone. Nothing type-checks THIS
   * file today (no tsconfig includes it), so a union error here would run
   * perfectly under tsx and surface only when someone adds it to one.
   */
  const rebase = (steps: Step[], offset: number): Step[] =>
    steps.map(step => (step.type === "exec" && typeof step.rewindOnFailure === "number"
      ? { ...step, rewindOnFailure: step.rewindOnFailure + offset }
      : step));

  return {
    key: "baseline",
    label: "Project Baseline (capabilities + personas)",
    assignee: "capArchitect",
    title: "Project Baseline — {project}",
    steps: [
      // `s.agent ??`, not a blanket assignment: the publish steps already name
      // the `publisher`, and flattening them back onto the specialist here
      // would reintroduce the generate-shaped system prompt this workflow is
      // the only place that could silently undo.
      ...rebase(cap.steps.map(s => (s.type === "agent" ? { ...s, agent: s.agent ?? "capArchitect" } : s)), 0),
      ...rebase(per.steps.map(s => (s.type === "agent" ? { ...s, agent: s.agent ?? "serviceDesigner" } : s)), cap.steps.length),
    ],
  };
}

export function buildWorkflows(): WorkflowDef[] {
  const entries = Object.entries(S);
  const generate = entries.map(([key, s]) => stageWorkflow(key, s));
  // `app` renders the companion app from other artefacts — there is nothing to
  // revise and no skill to enter Revision mode. Every other stage gets one.
  const revise = entries.filter(([, s]) => Boolean(s.skill)).map(([key, s]) => reviseWorkflow(key, s));
  // Only a stage that publishes has anything to republish. `ui` and `app`
  // produce local artefacts only, so there is no page to push them to.
  const republish = entries.filter(([, s]) => s.publishes).map(([key, s]) => publishWorkflow(key, s));
  return [...generate, ...revise, ...republish, baselineWorkflow()];
}
