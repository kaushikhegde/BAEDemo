import { test } from "node:test";
import assert from "node:assert/strict";
import { laneFor, parseMermaid, section5Flows, toFlow } from "../scripts/mermaid-to-flows.mjs";
import { validateFlows } from "../scripts/lib/flows.mjs";

const ACTORS = ["Requester (REQ)", "System", "Approving Manager (AM)", "Supplier Onboarding Officer (SOO)",
  "Supplier Representative (SR)", "Accounts Payable Officer (APO)", "Program Manager"];
const act = (l3, actor) => ({ l1: "Requisition & Approval", l2: "x", l3, actor, serviceTier: "All", components: [], capabilityIds: ["1"], sourceDocs: ["a.md"] });
const ACTIVITIES = [
  act("Search catalogue or locate blanket purchase agreement for the requirement", "Requester (REQ)"),
  act("Raise non-catalogue requisition with charge account and project/task coding", "Requester (REQ)"),
  act("Approve, reject or request information on requisition within delegation limit", "Approving Manager (AM)"),
  act("Obtain Program Manager approval for program commitments over $100,000", "Program Manager"),
];
const MERMAID = `flowchart TD
    A[Requester: search catalogue or locate BPA] --> B{Covered by catalogue or BPA?}
    B -- Yes --> C[Requester: raise catalogue requisition]
    B -- No --> D[Requester: raise non-catalogue requisition<br/>Code charge account and project/task]
    C & D --> G[Approving Manager: approve / reject / request info<br/>Reminder at 2 bd, escalation at 4 bd]
    G --> H{Program spend $100,000+?}
    H -->|Yes| I[Program Manager: additional approval]
    H -- No --> M[Approved requisition in Buyer work queue]
    I --> M
    G --> N[Oracle AME: requisition rejected — line on hold]`;

test("a role prefix picks the lane: abbreviation, name, system, and ambiguity", () => {
  assert.equal(laneFor("REQ", ACTORS), "Requester (REQ)");
  assert.equal(laneFor("Approving Manager", ACTORS), "Approving Manager (AM)");
  assert.equal(laneFor("AP Officer", ACTORS), "Accounts Payable Officer (APO)");
  assert.equal(laneFor("Oracle AME", ACTORS), "System");
  assert.equal(laneFor("CM / Requester", ["Category Manager (CM)", ...ACTORS]), "Category Manager (CM)");
  // Starts two actors' names — stays its own lane rather than guessing.
  assert.equal(laneFor("Suppliers", ACTORS), "Supplier");
});

test("parses shapes, labelled edges in both syntaxes, and & fan-in", () => {
  const { nodes, edges } = parseMermaid(MERMAID);
  assert.equal(nodes.get("B").kind, "gateway");
  assert.equal(nodes.get("A").kind, "task");
  assert.deepEqual(edges.filter((e) => e.to === "G").map((e) => e.from).sort(), ["C", "D"]);
  assert.equal(edges.find((e) => e.from === "H" && e.to === "I").label, "Yes");
  assert.equal(edges.find((e) => e.from === "B" && e.to === "D").label, "No");
});

test("builds a flow that validates: start, ends, lanes, SLA, activity links", () => {
  const flow = toFlow("Requisition & Approval", MERMAID, ACTIVITIES);
  const { errors } = validateFlows([flow], ACTIVITIES);
  assert.deepEqual(errors, []);
  assert.equal(flow.nodes.filter((n) => n.type === "start").length, 1);
  const byId = Object.fromEntries(flow.nodes.map((n) => [n.id, n]));
  assert.equal(byId.B.lane, "Requester (REQ)");                       // a decision inherits its lane
  assert.equal(byId.G.sla, "Reminder at 2 bd, escalation at 4 bd");    // timeframe → SLA chip
  assert.match(byId.D.label, /Code charge account/);                   // other extra lines stay in the label
  assert.equal(byId.A.activity, ACTIVITIES[0].l3);
  assert.equal(byId.N.lane, "System");
  const ends = flow.nodes.filter((n) => n.type === "end");
  assert.deepEqual(ends.map((e) => e.outcome).sort(), ["bad", "good"]);
  assert.equal(flow.lanes[0], "Requester (REQ)");
});

test("keeps pain the agent added on a previous run", () => {
  const first = toFlow("Requisition & Approval", MERMAID, ACTIVITIES);
  first.nodes.find((n) => n.id === "D").pain = "Free-text entry";
  const again = toFlow("Requisition & Approval", MERMAID, ACTIVITIES, first);
  assert.equal(again.nodes.find((n) => n.id === "D").pain, "Free-text entry");
});

test("finds one mermaid block per phase heading in section 5 only", () => {
  const md = `# Doc\n\n## 4. Coverage\n\n\`\`\`mermaid\nflowchart TD\n X --> Y\n\`\`\`\n\n## 5. Process Flow\n\n### Requisition & Approval\n\n\`\`\`mermaid\n${MERMAID}\n\`\`\`\n\n### Payment\n\nNo sequence.\n\n## 6. Assumptions & Gaps\n`;
  const found = section5Flows(md);
  assert.equal(found.length, 1);
  assert.equal(found[0].l1, "Requisition & Approval");
});
