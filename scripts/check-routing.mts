// Checks that every issue title + description the chatbot generates routes to
// the right orchestrator workflow, with the right params.
//
// This is the most fragile joint in the Paperclip swap: `server/index.ts` builds
// a human-readable title and a markdown description, and
// `server/orchestrator.ts` parses them back into a workflow key and a flat param
// map. Nothing type-checks that round trip — a renamed heading or a reworded
// title prefix breaks it silently, and the symptom is a stage running as the
// wrong stage.
//
// Run:  npm run check:routing
//
// A check rather than a unit test because scyne-chatbot has no test runner and
// adding one for a single round-trip assertion is not worth the dependency.

import { parseParams, workflowFor } from "../scyne-chatbot/server/orchestrator.js";

/**
 * Whether this installation publishes at all.
 *
 * Under `PUBLISH_TARGET=none` the orchestrator compiles no `publish-*`
 * workflows, so the three republish cases below have no key to route TO —
 * `workflowFor` refuses instead, and refusing is the correct routing on such an
 * install. Asserting the key there would demand a workflow that does not exist;
 * asserting nothing would let the refusal quietly become a stack trace.
 */
const PUBLISHES = (process.env.PUBLISH_TARGET ?? "atlassian") !== "none";

// The exact title + description shapes server/index.ts builds, verbatim.
const cases: Array<[string, string, string]> = [
  ["Generate requirements — Review & Verify Evidence (SADA/interim-benefit)",
   "## Project + Feature\n- Project: SADA\n- Feature: interim-benefit\n\n## Parameters\n- Process L3: 2.4 Review\n- ADO parent epic id: (none — create work items without a parent)\n- ADO org: Scyne-AI-Lab\n- ADO project: Scyne AI Project\n- ADO wiki: (the project's only wiki)\n- ADO work item type: Issue",
   "requirements"],
  ["Generate capability map — RTWSA", "## Project\n- Project: RTWSA", "capabilities"],
  ["Generate personas — RTWSA", "## Project\n- Project: RTWSA", "personas"],
  ["Generate UI mockups — Demo (RTWSA/Demo)", "- Project: RTWSA\n- Feature: Demo", "ui"],
  ["Generate data model — Demo (RTWSA/Demo)",
   "- Project: RTWSA\n- Feature: Demo\n- ADO org: Scyne-AI-Lab\n- ADO project: Scyne AI Project\n- ADO wiki: (the project's only wiki)\n- ADO work item type: Issue",
   "datamodel"],
  ["Generate solution architecture — Demo (RTWSA/Demo)", "- Project: RTWSA\n- Feature: Demo", "architecture"],
  ["Generate solution design — Demo (RTWSA/Demo)", "- Project: RTWSA\n- Feature: Demo", "design"],
  ["Generate test cases — Demo (RTWSA/Demo)", "- Project: RTWSA\n- Feature: Demo", "qa"],
  ["Build UI — RTWSA", "- Project: RTWSA", "app"],
  ["Generate project baseline — RTWSA", "- Project: RTWSA", "baseline"],
  ["Set up project — RTWSA", "- Project: RTWSA", "baseline"],
  ["Revise Data Model — RTWSA/Demo",
   "- Project: RTWSA\n- Feature: Demo\n- Artefact: datamodel\n- Owner: Data Modeler\n\n## instruction\nAdd an SLA breach field to the Case object.\n\n## How to run this\n- Stage your inputs.",
   "revise-datamodel"],
  // A republish carries no instruction — that is the whole difference from a
  // revision, and the reason the two must not collapse onto one workflow.
  ["Republish Data Model — RTWSA/Demo",
   "- Project: RTWSA\n- Feature: Demo\n- Artefact: datamodel\n- Owner: Data Modeler",
   "publish-datamodel"],
  ["Republish User Stories & Product Summary — RTWSA/Demo",
   "- Project: RTWSA\n- Feature: Demo\n- Artefact: requirements",
   "publish-requirements"],
  ["Republish Capability & Process Map — RTWSA",
   "- Project: RTWSA\n- Artefact: capabilities",
   "publish-capabilities"],
];

let bad = 0;
for (const [title, desc, want] of cases) {
  const params = parseParams(desc);
  let got: string;
  try { got = workflowFor(title, params); } catch (e) { got = `THREW: ${(e as Error).message}`; }
  // A republish on a non-publishing install must refuse IN THOSE WORDS. The
  // message is the deliverable: the person asked to push a document to a wiki
  // this installation has no credentials for, and "publishing is disabled" is
  // an answer they can act on where an unknown-workflow error is not.
  const mustRefuse = !PUBLISHES && want.startsWith("publish-");
  const ok = mustRefuse ? /publishing is disabled/i.test(got) : got === want;
  if (!ok) bad++;
  console.log(ok ? "ok  " : "BAD ", title.slice(0, 46).padEnd(48),
    (mustRefuse ? (ok ? "refused" : got) : got).padEnd(20),
    ok ? "" : `(want ${mustRefuse ? "a 'publishing is disabled' refusal" : want})`);
}

console.log("\n--- params extracted from the requirements description ---");
console.log(parseParams(cases[0][1]));
console.log("\n--- revision instruction, verbatim ---");
console.log(JSON.stringify(parseParams(cases[11][1]).instruction));

// The ADO target must survive the round trip. There is no environment fallback
// any more: a publish step handed no project STOPS rather than guessing, so a
// parameter lost here is a blocked run rather than a misfiled page.
{
  const p = parseParams(
    "- Project: SADA\n- Feature: interim-benefit\n- ADO org: Scyne-AI-Lab\n" +
    "- ADO project: Scyne AI Project\n- ADO wiki: (the project's only wiki)\n" +
    "- ADO work item type: Issue\n" +
    "- ADO parent epic id: (none — create work items without a parent)");
  const want = { adoOrg: "Scyne-AI-Lab", adoProject: "Scyne AI Project", adoWorkItemType: "Issue" };
  for (const [k, v] of Object.entries(want)) {
    if (p[k] !== v) { console.error(`FAIL  ${k}: expected ${v}, got ${p[k]}`); bad++; }
  }
  // "(the project's only wiki)" and "(none — …)" are index.ts's way of writing
  // "not set". Passing either through literally would name a wiki that does
  // not exist, or parent every work item under an item called "(none".
  if (p.adoWiki !== undefined) { console.error(`FAIL  adoWiki should be absent, got ${p.adoWiki}`); bad++; }
  if (p.adoParentEpicId !== undefined) { console.error(`FAIL  adoParentEpicId should be absent, got ${p.adoParentEpicId}`); bad++; }
  if (!bad) console.log("\nADO parameters round-trip correctly (and the \"(none)\" forms are dropped)");
}

console.log(bad ? `\n${bad} routing case(s) WRONG` : "\nevery routing case correct");
process.exit(bad ? 1 : 0);
