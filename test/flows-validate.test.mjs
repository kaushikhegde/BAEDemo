import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFlows } from "../scripts/lib/flows.mjs";

// The `flows` contract in process-model.json: one swimlane per L1 phase, drawn
// by the companion app and guarded by render-capability-map.mjs --validate-only.
// The fixture is BAE's Requisition & Approval phase, sequenced as §5 describes it.

const L1 = "Requisition & Approval";
const ACT = {
  search: "Search catalogue or locate blanket purchase agreement for the requirement",
  nonCat: "Raise non-catalogue requisition with charge account and project/task coding",
  mark: "Mark export-controlled requisition lines and submit for funds check",
  chain: "Build approval chain from requisition value, cost centre, project and approver hierarchy",
  approve: "Approve, reject or request information on requisition within delegation limit",
  pm: "Obtain Program Manager approval for program commitments over $100,000",
  route: "Route controlled requisition lines to Trade Compliance Officer queue",
  tco: "Confirm classification, supplier clearance and permits, then release or hold the line",
};
const ACTIVITIES = [
  ...Object.values(ACT).map((l3) => ({ l1: L1, l2: "Step", l3 })),
  { l1: "Purchase Order Management", l2: "Convert", l3: "Convert approved requisition to standard purchase order" },
];

const REQ = "Requester (REQ)", SYS = "System", AM = "Approving Manager (AM)";
const PM = "Program Manager", TCO = "Trade Compliance Officer (TCO)", BUY = "Buyer (BUY)";

function fixture() {
  return {
    l1: L1,
    lanes: [REQ, SYS, AM, PM, TCO, BUY],
    nodes: [
      { id: "start", type: "start", lane: REQ, label: "Need identified" },
      { id: "t1", type: "task", lane: REQ, label: "Check catalogue or BPA", activity: ACT.search },
      { id: "g1", type: "gateway", lane: REQ, label: "Covered by catalogue or BPA?" },
      { id: "t2", type: "task", lane: REQ, label: "Raise catalogue requisition" },
      { id: "t3", type: "task", lane: REQ, label: "Raise non-catalogue requisition", activity: ACT.nonCat },
      { id: "t4", type: "task", lane: REQ, label: "Mark export-controlled lines", activity: ACT.mark },
      { id: "t5", type: "task", lane: SYS, label: "Build approval chain", activity: ACT.chain },
      { id: "t6", type: "task", lane: AM, label: "Approve, reject or request info", activity: ACT.approve,
        sla: "Reminder 2 bd, escalation 4 bd" },
      { id: "g2", type: "gateway", lane: AM, label: "Program spend $100,000+?" },
      { id: "t7", type: "task", lane: PM, label: "Additional approval", activity: ACT.pm },
      { id: "g3", type: "gateway", lane: SYS, label: "Controlled item?" },
      { id: "t8", type: "task", lane: SYS, label: "Route to TCO queue", activity: ACT.route },
      { id: "t9", type: "task", lane: TCO, label: "Confirm classification and permits", activity: ACT.tco,
        pain: "Classification is checked by hand against the register" },
      { id: "g4", type: "gateway", lane: TCO, label: "Released?" },
      { id: "t10", type: "task", lane: BUY, label: "Approved requisition in Buyer queue" },
      { id: "end-ok", type: "end", lane: BUY, label: "Ready for PO", outcome: "good" },
      { id: "t11", type: "task", lane: TCO, label: "Line on hold" },
      { id: "end-hold", type: "end", lane: TCO, label: "On hold", outcome: "bad" },
    ],
    edges: [
      { from: "start", to: "t1" },
      { from: "t1", to: "g1" },
      { from: "g1", to: "t2", label: "Yes" },
      { from: "g1", to: "t3", label: "No" },
      { from: "t2", to: "t4" },
      { from: "t3", to: "t4" },
      { from: "t4", to: "t5" },
      { from: "t5", to: "t6" },
      { from: "t6", to: "g2" },
      { from: "g2", to: "t7", label: "Yes" },
      { from: "g2", to: "g3", label: "No" },
      { from: "t7", to: "g3" },
      { from: "g3", to: "t8", label: "Yes" },
      { from: "g3", to: "t10", label: "No" },
      { from: "t8", to: "t9" },
      { from: "t9", to: "g4" },
      { from: "g4", to: "t10", label: "Yes" },
      { from: "g4", to: "t11", label: "No" },
      { from: "t10", to: "end-ok" },
      { from: "t11", to: "end-hold" },
    ],
  };
}

const node = (f, id) => f.nodes.find((n) => n.id === id);

// Refuse: the result has no valid flows and some error matches `pattern`.
function refuses(flows, pattern) {
  const { flows: ok, errors } = validateFlows(flows, ACTIVITIES);
  assert.ok(errors.length > 0, "expected an error, got none");
  assert.ok(errors.some((e) => pattern.test(e)), `no error matched ${pattern}:\n${errors.join("\n")}`);
  return { ok, errors };
}

test("accepts the Requisition & Approval flow", () => {
  const { flows, errors } = validateFlows([fixture()], ACTIVITIES);
  assert.deepEqual(errors, []);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].nodes.length, 18);
  assert.equal(flows[0].edges.length, 20);
});

test("normalises: trims, drops unknown keys, defaults an end's outcome to good", () => {
  const f = fixture();
  f.l1 = `  ${L1} `;
  f.lanes[0] = ` ${REQ}`;
  f.colour = "red";
  Object.assign(node(f, "start"), { lane: `${REQ} `, label: " Need identified ", x: 10 });
  delete node(f, "end-ok").outcome;
  f.edges[2].label = " Yes ";
  f.edges[0].style = "dashed";
  const { flows, errors } = validateFlows([f], ACTIVITIES);
  assert.deepEqual(errors, []);
  const [out] = flows;
  assert.deepEqual(Object.keys(out), ["l1", "lanes", "nodes", "edges"]);
  assert.equal(out.l1, L1);
  assert.equal(out.lanes[0], REQ);
  assert.deepEqual(out.nodes[0], { id: "start", type: "start", lane: REQ, label: "Need identified" });
  assert.equal(out.nodes.find((n) => n.id === "end-ok").outcome, "good");
  assert.equal(out.nodes.find((n) => n.id === "end-hold").outcome, "bad");
  assert.equal("outcome" in out.nodes.find((n) => n.id === "t1"), false);
  assert.deepEqual(out.edges[0], { from: "start", to: "t1" });
  assert.equal(out.edges[2].label, "Yes");
});

test("absent flows are accepted — the field is optional", () => {
  assert.deepEqual(validateFlows(undefined, ACTIVITIES), { flows: [], errors: [] });
  assert.deepEqual(validateFlows(null, ACTIVITIES), { flows: [], errors: [] });
  assert.deepEqual(validateFlows([], ACTIVITIES), { flows: [], errors: [] });
});

test("loops are allowed", () => {
  const f = fixture();
  f.edges.push({ from: "t9", to: "t8", label: "Re-check" });
  assert.deepEqual(validateFlows([f], ACTIVITIES).errors, []);
});

test("refuses flows that are not an array", () => {
  refuses({ l1: L1 }, /"flows" must be an array/);
});

test("refuses a flow that is not an object", () => {
  refuses(["nope"], /flows\[0\]: must be an object/);
});

test("refuses an l1 that is not an activity phase", () => {
  const f = fixture();
  f.l1 = "Requisitions";
  refuses([f], /"l1" "Requisitions" is not the l1 of any activity/);
});

test("refuses a missing l1", () => {
  const f = fixture();
  delete f.l1;
  refuses([f], /flows\[0\]: "l1" is required/);
});

test("refuses a second flow for the same l1, keeping the first", () => {
  const { ok } = refuses([fixture(), fixture()], /flows\[1\] \("Requisition & Approval"\): "l1" .* already has a flow at flows\[0\]/);
  assert.equal(ok.length, 1);
});

test("refuses empty lanes", () => {
  const f = fixture();
  f.lanes = [];
  refuses([f], /"lanes" must be a non-empty array/);
});

test("refuses a blank lane", () => {
  const f = fixture();
  f.lanes.push("  ");
  refuses([f], /lanes\[6\]: must be a non-empty string/);
});

test("refuses duplicate lanes", () => {
  const f = fixture();
  f.lanes.push(SYS);
  refuses([f], /lanes\[6\]: duplicate lane "System"/);
});

test("refuses a node whose lane is not listed, naming flow and node precisely", () => {
  const f = fixture();
  node(f, "t3").lane = "Buyer";
  const { errors } = refuses([f], /lane "Buyer" is not in lanes/);
  assert.ok(errors.includes(`process-model.json flows[0] ("Requisition & Approval") nodes[4] ("t3"): lane "Buyer" is not in lanes.`), errors.join("\n"));
});

test("refuses a node with no lane", () => {
  const f = fixture();
  delete node(f, "t3").lane;
  refuses([f], /nodes\[4\] \("t3"\): "lane" is required/);
});

test("refuses empty nodes", () => {
  const f = fixture();
  f.nodes = [];
  f.edges = [];
  refuses([f], /"nodes" must be a non-empty array/);
});

test("refuses a node without an id", () => {
  const f = fixture();
  node(f, "t11").id = " ";
  refuses([f], /nodes\[16\]: "id" is required/);
});

test("refuses duplicate node ids", () => {
  const f = fixture();
  node(f, "t11").id = "t10";
  refuses([f], /nodes\[16\] \("t10"\): duplicate id "t10"/);
});

test("refuses an unknown node type", () => {
  const f = fixture();
  node(f, "t2").type = "subprocess";
  refuses([f], /nodes\[3\] \("t2"\): "type" must be one of start \| task \| gateway \| end, got "subprocess"/);
});

test("refuses a flow with no start", () => {
  const f = fixture();
  f.nodes = f.nodes.filter((n) => n.id !== "start");
  f.edges = f.edges.filter((e) => e.from !== "start");
  refuses([f], /must have exactly one "start" node, found 0/);
});

test("refuses a flow with two starts", () => {
  const f = fixture();
  f.nodes.push({ id: "start2", type: "start", lane: BUY, label: "Second start" });
  f.edges.push({ from: "start2", to: "t10" });
  refuses([f], /must have exactly one "start" node, found 2/);
});

test("refuses a flow with no end", () => {
  const f = fixture();
  node(f, "end-ok").type = "task";
  node(f, "end-hold").type = "task";
  refuses([f], /must have at least one "end" node/);
});

test("refuses an edge to a node that does not exist", () => {
  const f = fixture();
  f.edges.push({ from: "t10", to: "t99" });
  refuses([f], /edges\[20\] \("t10" → "t99"\): "to" "t99" is not a node id/);
});

test("refuses an edge with no from", () => {
  const f = fixture();
  f.edges.push({ to: "t10" });
  refuses([f], /edges\[20\] .*"from" is required/);
});

test("refuses a duplicate edge", () => {
  const f = fixture();
  f.edges.push({ from: "t1", to: "g1" });
  refuses([f], /edges\[20\] \("t1" → "g1"\): duplicate edge/);
});

test("refuses a node unreachable from the start", () => {
  const f = fixture();
  f.edges = f.edges.filter((e) => !(e.from === "g4" && e.to === "t11"));
  f.edges.push({ from: "g4", to: "end-hold", label: "No" }); // keep g4 a real branch
  refuses([f], /nodes\[16\] \("t11"\): not reachable from the start/);
});

test("refuses a gateway with fewer than two outgoing edges", () => {
  const f = fixture();
  f.edges = f.edges.filter((e) => !(e.from === "g1" && e.to === "t2"));
  f.edges.push({ from: "t1", to: "t2" }); // keep t2 reachable
  refuses([f], /nodes\[2\] \("g1"\): a gateway needs 2 or more outgoing edges, has 1/);
});

test("refuses an edge into the start", () => {
  const f = fixture();
  f.edges.push({ from: "t11", to: "start" });
  refuses([f], /"to" "start" is the "start" node, which takes no incoming edges/);
});

test("refuses an edge out of an end", () => {
  const f = fixture();
  f.edges.push({ from: "end-hold", to: "t4" });
  refuses([f], /"from" "end-hold" is an "end" node, which takes no outgoing edges/);
});

test("refuses an empty label on every node type", () => {
  for (const id of ["start", "t1", "g1", "end-ok"]) {
    const f = fixture();
    node(f, id).label = "   ";
    refuses([f], new RegExp(`\\("${id}"\\): "label" is required`));
  }
});

test("refuses a label over 80 chars on every node type", () => {
  for (const id of ["start", "t1", "g1", "end-ok"]) {
    const f = fixture();
    node(f, id).label = "x".repeat(81);
    refuses([f], new RegExp(`\\("${id}"\\): "label" is 81 chars; the limit is 80`));
  }
  const f = fixture();
  node(f, "t1").label = "x".repeat(80);
  assert.deepEqual(validateFlows([f], ACTIVITIES).errors, []);
});

test("refuses an activity that is not an l3 in the same l1", () => {
  const f = fixture();
  node(f, "t10").activity = "Convert approved requisition to standard purchase order"; // a PO-phase l3
  refuses([f], /nodes\[14\] \("t10"\): "activity" ".*" is not the l3 of any activity in "Requisition & Approval"/);
});

test("refuses an outcome other than good or bad", () => {
  const f = fixture();
  node(f, "end-hold").outcome = "neutral";
  refuses([f], /\("end-hold"\): "outcome" must be good \| bad, got "neutral"/);
});

test("refuses pain over 140 chars", () => {
  const f = fixture();
  node(f, "t9").pain = "p".repeat(141);
  refuses([f], /\("t9"\): "pain" is 141 chars; the limit is 140/);
});

test("refuses sla over 60 chars", () => {
  const f = fixture();
  node(f, "t6").sla = "s".repeat(61);
  refuses([f], /\("t6"\): "sla" is 61 chars; the limit is 60/);
});

test("refuses an edge label over 24 chars", () => {
  const f = fixture();
  f.edges[2].label = "y".repeat(25);
  refuses([f], /edges\[2\] \("g1" → "t2"\): "label" is 25 chars; the limit is 24/);
});

test("collects every error rather than stopping at the first", () => {
  const f = fixture();
  node(f, "t3").lane = "Buyer";
  node(f, "t2").type = "subprocess";
  f.edges[2].label = "y".repeat(25);
  const { flows, errors } = validateFlows([f], ACTIVITIES);
  assert.equal(errors.length, 3, errors.join("\n"));
  assert.deepEqual(flows, []);
});

test("returns only the flows that passed", () => {
  const good = fixture();
  const bad = fixture();
  bad.l1 = "Purchase Order Management";
  for (const n of bad.nodes) delete n.activity;
  bad.nodes.find((n) => n.id === "t1").activity = ACT.search; // l3 from another phase
  const { flows, errors } = validateFlows([good, bad], ACTIVITIES);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /^process-model\.json flows\[1\] \("Purchase Order Management"\) nodes\[1\] \("t1"\)/);
  assert.deepEqual(flows.map((f) => f.l1), [L1]);
});
