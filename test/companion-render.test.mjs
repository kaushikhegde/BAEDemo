import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Renders a small fixture project through the real CLI, in a throwaway
// SCYNE_WORK_ROOT, and checks the page and the registry contract the chatbot,
// the a11y audit and the app stage depend on.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "render-companion-app.mjs");
let work;

const put = (rel, data) => {
  const file = path.join(work, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
};
const render = (project, extra = []) => spawnSync(process.execPath, [CLI, project, "--no-diagrams", ...extra], {
  env: { ...process.env, SCYNE_WORK_ROOT: work }, encoding: "utf8",
});

const activities = [
  { l1: "Requisition & Approval", l2: "Raise", l3: "Check catalogue", description: "d", actor: "Requester (REQ)", serviceTier: "All", components: [], capabilityIds: ["1.1.1"], sourceDocs: ["a.md"] },
  { l1: "Requisition & Approval", l2: "Raise", l3: "Raise requisition", description: "d", actor: "Requester (REQ)", serviceTier: "All", components: ["Oracle"], capabilityIds: ["1.1.1"], sourceDocs: ["a.md"] },
  { l1: "Requisition & Approval", l2: "Approve", l3: "Approve requisition", description: "d", actor: "Approving Manager (AM)", serviceTier: "All", components: [], capabilityIds: ["1.1.1"], sourceDocs: ["a.md"] },
  { l1: "Invoice & Payment", l2: "Match", l3: "Three-way match", description: "d", actor: "System", serviceTier: "All", components: [], capabilityIds: ["1.1.1"], sourceDocs: ["a.md"] },
];
const flow = {
  l1: "Requisition & Approval",
  lanes: ["Requester (REQ)", "Approving Manager (AM)"],
  nodes: [
    { id: "s", type: "start", lane: "Requester (REQ)", label: "Need identified" },
    { id: "t1", type: "task", lane: "Requester (REQ)", label: "Check catalogue", activity: "Check catalogue" },
    { id: "g", type: "gateway", lane: "Requester (REQ)", label: "In catalogue?" },
    { id: "t2", type: "task", lane: "Requester (REQ)", label: "Raise requisition", activity: "Raise requisition", pain: "No guidance on fields" },
    { id: "t3", type: "task", lane: "Approving Manager (AM)", label: "Approve requisition", activity: "Approve requisition", sla: "2 bd" },
    { id: "e1", type: "end", lane: "Approving Manager (AM)", label: "Approved", outcome: "good" },
  ],
  edges: [
    { from: "s", to: "t1" }, { from: "t1", to: "g" }, { from: "g", to: "t2", label: "No" },
    { from: "g", to: "t3", label: "Yes" }, { from: "t2", to: "t3" }, { from: "t3", to: "e1" },
  ],
};

before(() => {
  work = mkdtempSync(path.join(tmpdir(), "companion-render-"));
  const P = "projects/Demo";
  put(`${P}/description.md`, "# Demo");
  put(`${P}/solutions/Capabilities/outputs/capability-map.json`, { capabilities: [
    { id: "1.0", name: "Buying", level: 1, parentId: null, description: "Buy things" },
    { id: "1.1", name: "Requisitions", level: 2, parentId: "1.0" },
    { id: "1.1.1", name: "Requisition Management", level: 3, parentId: "1.1", currentMaturity: "Foundational", targetMaturity: "Operational" },
  ] });
  put(`${P}/solutions/Capabilities/outputs/process-model.json`, { activities, flows: [flow] });
  put(`${P}/solutions/Experience/outputs/personas.json`, { personas: [
    { id: "alex", name: "Alex", role: "Requester — Engineer", avatarColor: "bg-blue-900",
      today: ["Waits a week [project/root/07-Workshop.md §3]"], tomorrow: ["Approved same day"], keyBenefit: "Less chasing" },
  ] });
  put(`${P}/solutions/Experience/outputs/journey-map.json`, { journeys: [{
    id: "alex-req", personaId: "alex", title: "Requisitioning", scenario: "Need to PO",
    stages: [{ id: "st1", name: "Raise", l1Phase: "Requisition & Approval", steps: [
      { id: "s1", name: "Raises requisition", actor: "Requester", channel: "Oracle", thinking: "Hope it is right", feeling: "unsure", todayScore: 2, targetScore: 4, painPoints: ["No guidance"], opportunities: ["Guided entry"] },
      { id: "s2", name: "Submits", actor: "Requester", channel: "Oracle", feeling: "hopeful", todayScore: 3, targetScore: 3, painPoints: [], opportunities: [] },
    ] }],
    momentsThatMatter: [{ stepId: "s1", why: "Errors cost weeks", designResponse: "Validate at entry" }],
    metrics: [{ name: "Cycle time", today: "9 days", target: "3 days", source: "x.md" }],
  }] });
  put("projects/Empty/description.md", "# Empty");
});
after(() => { if (work) rmSync(work, { recursive: true, force: true }); });

test("renders every project tab, a swimlane where a flow exists, and the registry entry last", () => {
  const r = render("Demo");
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(path.join(work, "generated-apps", "Demo", "index.html"), "utf8");

  for (const id of ["personas", "capabilities", "process"]) assert.match(html, new RegExp(`id="panel-${id}"`));
  // One swimlane: the phase that has a flow. The phase without one has cards only.
  assert.equal((html.match(/class="swim card"/g) || []).length, 1);
  assert.match(html, /data-show="process\/requisition-approval"/);
  assert.match(html, /data-show="process\/invoice-payment"/);
  assert.match(html, /data-activity-row="Raise requisition"/);
  // Journey grid, moment badge, no "—" filler cells.
  assert.match(html, /class="jg"/);
  assert.match(html, /is-moment/);
  assert.doesNotMatch(html, /class="jg-cell[^"]*">\s*—\s*</);
  // Internal evidence never reaches the page.
  assert.doesNotMatch(html, /07-Workshop\.md/);
  assert.doesNotMatch(html, /x\.md/);
  // Self-contained: nothing fetched from anywhere.
  assert.doesNotMatch(html, /(src|href)="https?:/i);
  assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/i);

  const tail = /\{[\s\S]*\}\s*$/.exec(r.stdout);
  assert.ok(tail, "stdout must end with the registry entry");
  const entry = JSON.parse(tail[0]);
  assert.equal(entry.kind, "static-html");
  assert.equal(entry.htmlPath, path.join("generated-apps", "Demo", "index.html"));
  assert.match(entry.devUrl, /\/api\/companion-app\/Demo\/$/);
  assert.ok(entry.artefacts.includes("1 swimlane"));
  const registry = JSON.parse(readFileSync(path.join(work, "generated-apps", "registry.json"), "utf8"));
  assert.deepEqual(registry.Demo.artefacts, entry.artefacts);
});

test("a project with nothing generated is refused with the wording the chatbot matches", () => {
  const r = render("Empty");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nothing to render/i);
});

test("a malformed flow costs that swimlane, not the page", () => {
  const P = "projects/Broken";
  put(`${P}/solutions/Capabilities/outputs/process-model.json`, {
    activities, flows: [{ ...flow, lanes: ["Requester (REQ)"] }],
  });
  const r = render("Broken");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /flows/);
  const html = readFileSync(path.join(work, "generated-apps", "Broken", "index.html"), "utf8");
  assert.doesNotMatch(html, /class="swim card"/);
  assert.match(html, /id="panel-process"/);
});
