// Checks the compiled workflows against the rules that are easy to break from a
// distance and expensive to discover at runtime.
//
// The one that motivated this file: EVERY publish step must run as the
// `publisher`, never as the specialist that generated the artefact. A specialist
// gets one system prompt, written entirely in generate terms, and handing that
// to a publish step gives the model a brief to generate and a task to publish.
// Measured on the SAPN personas publish (issue 8fc6b03f step 5): the Service
// Designer's prompt states that journey stages must align to the capability
// map's L1 phases, so the publish agent went and re-read the capability map,
// rewrote personas-journeys.md four times, and published a document the human
// at the gate had never seen.
//
// It is easy to undo by accident: `baselineWorkflow` re-maps every agent step
// onto a named agent, so one blanket assignment there silently reverts all of
// it — with no type error and no failing test, because the workflows compile
// perfectly either way.
//
// Run:  npm run check:workflows
//
// A check rather than a unit test because these files live at the repo root,
// outside packages/orchestrator's suite — which deliberately cannot import
// them.

import { existsSync } from "node:fs";
import { ORG, buildWorkflows } from "../orchestrator.workflows.js";

let bad = 0;
const fail = (m: string) => { console.error(`FAIL  ${m}`); bad++; };

const publisher = ORG.find(a => a.key === "publisher");
if (!publisher) fail("ORG has no `publisher` agent");
else {
  // Without MCP the publisher cannot reach wiki_upsert_page at all, and the
  // step fails after the gate was approved — the most expensive moment to find
  // out.
  if (!publisher.mcpEnabled) fail("the publisher needs mcpEnabled to reach the ADO MCP");
  if (!publisher.bundlePath) fail("the publisher has no bundlePath, so it runs on the bare workflow prompt");
  else if (!existsSync(publisher.bundlePath)) {
    // Claude Code fails fast with `System prompt file not found` before any
    // network call, so this is worth catching here rather than per run.
    fail(`the publisher's bundlePath does not exist: ${publisher.bundlePath}`);
  }
}

let publishSteps = 0;
for (const w of buildWorkflows()) {
  for (const [i, s] of w.steps.entries()) {
    if (s.type !== "agent" || s.phase !== "publish") continue;
    publishSteps++;
    if (s.agent !== "publisher") {
      fail(`${w.key} step ${i}: publish runs as \`${s.agent ?? w.assignee}\`, not \`publisher\``);
    }
    // A skill on a publish step is the same mistake in a different place:
    // publishing is moving bytes, and a skill is a method for producing them.
    if (s.skill) fail(`${w.key} step ${i}: a publish step must not invoke a skill (\`${s.skill}\`)`);
  }
}

if (!publishSteps) fail("no publish steps found at all — has `publishes` been dropped from the pipeline?");

console.log(bad
  ? `\n${bad} workflow check(s) FAILED`
  : `\nevery publish step (${publishSteps}) runs as the publisher, with no skill`);
process.exit(bad ? 1 : 0);
