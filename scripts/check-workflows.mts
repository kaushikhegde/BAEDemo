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

// The wiki path scheme. One Azure DevOps project per Scyne project means the
// project name is no longer needed IN the path — the project IS the container.
// A regression here does not throw: it publishes a client's document to a
// plausible-looking path that nothing links to.
{
  const publishPrompts = buildWorkflows()
    .flatMap(w => w.steps.map((s, i) => ({ key: w.key, i, s })))
    .filter(({ s }) => s.type === "agent" && s.phase === "publish")
    .map(({ key, s }) => ({ key, prompt: String((s as any).prompt ?? "") }));

  for (const { key, prompt } of publishPrompts) {
    if (prompt.includes("/Scyne/")) {
      fail(`${key}: publish prompt still carries the retired /Scyne/ path prefix`);
    }
    if (/`\/\{project\}\//.test(prompt)) {
      fail(`${key}: publish prompt still puts {project} in the wiki path`);
    }
  }

  // A project-level artefact sits at the wiki root and therefore has NO parent
  // page; a feature-level one has exactly one, `/{feature}`.
  const capabilities = publishPrompts.find(p => p.key === "capabilities");
  if (capabilities && !capabilities.prompt.includes("`/Capability & Process Map`")) {
    fail("capabilities: expected the page path `/Capability & Process Map`");
  }
  const datamodel = publishPrompts.find(p => p.key === "datamodel");
  if (datamodel && !datamodel.prompt.includes("`/{feature}/Salesforce Data Model`")) {
    fail("datamodel: expected the page path `/{feature}/Salesforce Data Model`");
  }
}

// Every publish is preceded by the step that guarantees it has somewhere to
// publish TO, and the verifier that judges it still points back at the publish.
//
// Both halves are position-dependent, which is the kind of thing that survives
// a refactor looking correct: a capability-map publish already failed with
// `TF200016: The following project does not exist` because nothing created the
// Azure DevOps project, and a rewind pointed one step off would park the issue
// on a verifier that can never pass — the SCY-1 loop.
{
  let ensured = 0;
  for (const w of buildWorkflows()) {
    for (const [i, step] of w.steps.entries()) {
      if (step.type !== "agent" || step.phase !== "publish") continue;

      const before = w.steps[i - 1];
      if (before?.type !== "exec" || !String((before as any).cmd ?? "").includes("ensure-ado-project")) {
        fail(`${w.key} step ${i}: publish is not preceded by the ensure-ado-project step`);
      } else ensured++;

      // The verifier sits at i+1, or at i+2 with the work-item step between
      // them — and nothing else. Deliberately still position-dependent rather
      // than "somewhere after": the point of this check is that a refactor
      // cannot quietly move the judge away from the thing it judges, and a
      // search-forward would accept a verifier six steps and a gate later.
      const between = w.steps[i + 1] as any;
      const gap = between?.type === "exec" &&
        String(between.cmd ?? "").includes("ado-workitems") ? 1 : 0;
      const verifier = w.steps[i + 1 + gap] as any;
      if (verifier?.type !== "exec" || !String(verifier.cmd ?? "").includes("verify-published")) {
        fail(`${w.key} step ${i}: publish is not followed by its verifier`);
      } else if (verifier.rewindOnFailure !== i) {
        fail(`${w.key} step ${i}: the verifier rewinds to ${verifier.rewindOnFailure}, not to the publish step`);
      }
    }
  }
  if (publishSteps && !ensured) fail("no publish step is preceded by ensure-ado-project");
}

// Only the stage that produces a backlog asks the verifier to check one.
// Every other stage publishes a page and nothing else, and `--stories` there
// would point at a file that does not exist and block a healthy publish.
{
  for (const w of buildWorkflows()) {
    for (const [i, step] of w.steps.entries()) {
      if (step.type !== "exec" || !String(step.cmd ?? "").includes("verify-published")) continue;
      const asks = String(step.cmd).includes("--stories");
      // Every variant of the requirements stage publishes the backlog, so
      // every one of them must have its backlog checked: generate, revise and
      // republish alike. `variantOf` is the declared link, which is why the
      // workflows carry it rather than leaving the prefix to be parsed.
      const should = w.key === "requirements" || (w as any).variantOf === "requirements";
      if (asks !== should) {
        fail(`${w.key} step ${i}: --stories is ${asks ? "present" : "absent"}, expected ${should ? "present" : "absent"}`);
      }
    }
  }

// The backlog is created by a step, and by NOTHING ELSE.
//
// These two have to agree or a client's backlog is written twice, and a
// duplicated backlog is the one failure in this pipeline that re-running
// cannot undo. So: every workflow that publishes the requirements stage
// carries exactly one `ado-workitems` step, and no publish prompt anywhere
// still tells an agent to create work items itself.
//
// SA-Power-Networks is why the step exists — 45 stories, page published, zero
// work items, agent exit 0 — and why the prompt half was deleted rather than
// left as a fallback: an instruction a model may or may not follow, running
// beside a script that always does, is how you get 90 items instead of 45.
{
  for (const w of buildWorkflows()) {
    const backlog = w.steps.filter(st =>
      st.type === "exec" && String((st as any).cmd ?? "").includes("ado-workitems"));
    const should = w.key === "requirements" || (w as any).variantOf === "requirements";
    if (should && backlog.length !== 1) {
      fail(`${w.key}: expected exactly 1 ado-workitems step, found ${backlog.length}`);
    }
    if (!should && backlog.length) {
      fail(`${w.key}: has an ado-workitems step but does not publish the requirements stage`);
    }

    for (const [i, st] of w.steps.entries()) {
      if (st.type !== "agent" || st.phase !== "publish") continue;
      // The prompt may still NAME the tool — telling the publisher "do not
      // call `wit_work_item_write`" is worth more than silence, because the
      // stage's deliverable obviously includes a backlog and an agent left to
      // infer will help. What it may not do is name it as an instruction.
      const prompt = String((st as any).prompt ?? "");
      if (prompt.includes("wit_work_item_write") && !prompt.includes("do not call")) {
        fail(`${w.key} step ${i}: the publish prompt still tells the agent to create work items`);
      }
    }
  }
}
}

console.log(bad
  ? `\n${bad} workflow check(s) FAILED`
  : `\nevery publish step (${publishSteps}) runs as the publisher, with no skill`);
process.exit(bad ? 1 : 0);
