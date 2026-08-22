#!/usr/bin/env node
/**
 * Make sure the Azure DevOps project a Scyne project publishes to exists,
 * creating it and its wiki when it does not.
 *
 * WHY THIS EXISTS
 * ---------------
 * A capability-map publish failed its verifier with
 *
 *   GET .../SA-Power-Networks/_apis/wiki/wikis
 *     -> HTTP 404. TF200016: The following project does not exist
 *
 * The verifier was right and the publish agent was doomed before it started:
 * `.published.json` named a target that had never been created in Azure DevOps,
 * because the wizard's creation step is allowed to fail without failing the
 * project (the tree, definition and branding are real and worth keeping, so a
 * project is left INCOMPLETE rather than broken). Nothing downstream noticed
 * until a human had already approved a document that then could not be
 * published anywhere.
 *
 * WHY IT IS NOT IN THE VERIFIER
 * -----------------------------
 * `verify-published.mjs` is the JUDGE of the publish step. A judge that
 * repairs what it is judging cannot fail it. This runs BEFORE the publish
 * instead, so the publish it protects has somewhere to write, and a failure
 * here refuses cleanly with nothing published and no page half-written.
 *
 * WHY IT IS NOT NEW CODE
 * ----------------------
 * `ensureAdoProject` is the wizard's own creation path — it short-circuits
 * when the project exists, resolves the process template BY NAME rather than
 * by a GUID that is correct in one organisation only, polls the create to a
 * TERMINAL state, creates the wiki, and confirms the work item type exists.
 * That polling is what makes "a half-created project is worse than a clear
 * refusal" still true when creation happens in a run rather than in front of a
 * person. A second copy of that logic here would be a second thing to get
 * wrong.
 *
 * USAGE
 * -----
 *   node --import tsx scripts/ensure-ado-project.mts <project> [--org <org>]
 *        [--project <adoProject>] [--template <name>] [--work-item-type <name>]
 *
 * Exit 0 = the project is there, whether it already was or was just created.
 * Non-zero = it is not, with Azure DevOps' own message.
 */

import process from "node:process";
import { loadAdo, parseArgs, readAdoTarget, recordAdoTarget } from "./lib/ado.mjs";
import { ensureAdoProject } from "../scyne-chatbot/server/services/adoProject.js";

const { flags, positional } = parseArgs(process.argv.slice(2));
const project = positional[0];

const die = (msg: string): never => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

if (!project) die(`No Scyne project. Usage: ensure-ado-project.mts <project> [--org <org>]`);

const publishedFile = `projects/${project}/.published.json`;
const recorded = await readAdoTarget(publishedFile);

// The recorded target wins. Falling back to the Scyne project's own name is
// the same decision the wizard makes, which is what makes a project whose
// Azure DevOps step failed completable rather than stranded — but it is only
// ever THIS project's name, never one derived or guessed from anything else.
const adoProject = String(flags.project || recorded?.project || project);

// Through `loadAdo`, not `process.env` directly, for the token as much as the
// org: every other script in this folder reads the ROOT .env through it, and
// `ensureAdoProject` reads `process.env` alone. An `exec` step runs under
// `/bin/sh -c` and a hand run has no dotenv either, so without this the token
// sitting in .env is invisible and the failure reads "no Azure DevOps token"
// at someone who has one. It also means one wording for that failure across
// every script rather than a second one here.
const ado = await loadAdo({ org: flags.org ? String(flags.org) : recorded?.org });
const org = ado.org;
process.env.ADO_PAT ??= ado.pat;

// The RECORDED template and work item type win over the defaults.
//
// `ensureAdoProject` defaults to Agile / "User Story" because that is what a
// NEW project gets. Applied to an existing one it is an assertion, and a wrong
// one: measured against the live organisation, SA-Power-Networks and
// "Scyne AI Project" both run the **Basic** template — Epic, Issue, Task, and
// no User Story at all. Ignoring the record therefore refused a project that
// was working perfectly, before every publish, including the wiki-only stages
// that never create a work item.
//
// `.published.json` is where that answer already lives, per project, written
// when the project was created and confirmed BY NAME at that moment.
const result = await ensureAdoProject({
  org,
  project: adoProject,
  ...(flags.template ?? recorded?.processTemplate
    ? { processTemplate: String(flags.template ?? recorded?.processTemplate) } : {}),
  ...(flags["work-item-type"] ?? recorded?.workItemType
    ? { workItemType: String(flags["work-item-type"] ?? recorded?.workItemType) } : {}),
  // A TYPED flag is an assertion; a RECORDED value is only our own note, made
  // before anyone checked, and it is exactly the thing that needs correcting
  // when it turns out to be wrong. Treating the record as binding is what
  // would keep a project blocked on a value this run could simply fix.
  ...(flags["work-item-type"] ? { requireWorkItemType: true } : {}),
});

if (!result.ok) {
  // Azure DevOps' own text, verbatim. TF50316 alone covers length, illegal
  // characters and reserved names, and re-describing it here would be one more
  // thing to keep in step with a service that owns the rule.
  die(`Azure DevOps project "${adoProject}" in ${org} is not available.\n  ${result.error}`);
}

// Record it whether it was created or already there: a project that exists in
// Azure DevOps and is not written down here is one every later publish has to
// rediscover, and `readAdoTarget` has no environment fallback by design.
const existed = recorded?.project === result.target.project && recorded?.wikiId === result.target.wikiId;
await recordAdoTarget(publishedFile, result.target);

console.log(
  existed
    ? `✓ Azure DevOps project "${result.target.project}" already there (wiki "${result.target.wiki}").`
    : `✓ Azure DevOps project "${result.target.project}" ready in ${org} — wiki "${result.target.wiki}", ` +
      `${result.target.processTemplate} template, work item type "${result.target.workItemType}". Recorded in ${publishedFile}.`,
);
