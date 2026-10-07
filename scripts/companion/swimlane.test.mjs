import test from "node:test";
import assert from "node:assert/strict";
import { layoutSwimlane, renderSwimlane, laneInfo, wrapText } from "./swimlane.mjs";

const REQ = "Requester (REQ)";
const SYS = "System";
const AM = "Approving Manager (AM)";
const PM = "Program Manager";
const TCO = "Trade Compliance Officer (TCO)";
const BUY = "Buyer (BUY)";

export const REQUISITION = {
  l1: "Requisition & Approval",
  lanes: [REQ, SYS, AM, PM, TCO, BUY],
  nodes: [
    { id: "start", type: "start", lane: REQ, label: "Need identified" },
    { id: "check", type: "task", lane: REQ, label: "Check catalogue or BPA", activity: "Check catalogue or BPA" },
    { id: "g-cat", type: "gateway", lane: REQ, label: "Covered by catalogue or BPA?" },
    { id: "raise-cat", type: "task", lane: REQ, label: "Raise catalogue requisition", activity: "Raise requisition" },
    {
      id: "raise-non",
      type: "task",
      lane: REQ,
      label: "Raise non-catalogue requisition",
      pain: "Free-text entry with no guidance on required fields",
    },
    { id: "mark", type: "task", lane: REQ, label: "Mark export-controlled lines" },
    { id: "chain", type: "task", lane: SYS, label: "Build approval chain" },
    { id: "approve", type: "task", lane: AM, label: "Approve, reject or request info", sla: "Reminder 2 bd, escalation 4 bd" },
    { id: "g-spend", type: "gateway", lane: AM, label: "Program spend $100,000+?" },
    { id: "pm", type: "task", lane: PM, label: "Additional approval" },
    { id: "g-ctl", type: "gateway", lane: SYS, label: "Controlled item?" },
    { id: "route", type: "task", lane: SYS, label: "Route to TCO queue" },
    { id: "confirm", type: "task", lane: TCO, label: "Confirm classification and permits" },
    { id: "g-rel", type: "gateway", lane: TCO, label: "Released?" },
    { id: "hold", type: "task", lane: TCO, label: "Line on hold" },
    { id: "buyer", type: "task", lane: BUY, label: "Approved requisition in Buyer queue" },
    { id: "end-ok", type: "end", lane: BUY, label: "Ready for PO", outcome: "good" },
    { id: "end-hold", type: "end", lane: TCO, label: "On hold", outcome: "bad" },
  ],
  edges: [
    { from: "start", to: "check" },
    { from: "check", to: "g-cat" },
    { from: "g-cat", to: "raise-cat", label: "Yes" },
    { from: "g-cat", to: "raise-non", label: "No" },
    { from: "raise-cat", to: "mark" },
    { from: "raise-non", to: "mark" },
    { from: "mark", to: "chain" },
    { from: "chain", to: "approve" },
    { from: "approve", to: "g-spend" },
    { from: "g-spend", to: "pm", label: "Yes" },
    { from: "g-spend", to: "g-ctl", label: "No" },
    { from: "pm", to: "g-ctl" },
    { from: "g-ctl", to: "route", label: "Yes" },
    { from: "g-ctl", to: "buyer", label: "No" },
    { from: "route", to: "confirm" },
    { from: "confirm", to: "g-rel" },
    { from: "g-rel", to: "buyer", label: "Yes" },
    { from: "g-rel", to: "hold", label: "No" },
    { from: "hold", to: "end-hold" },
    { from: "buyer", to: "end-ok" },
  ],
};

const withLoop = () => ({
  ...REQUISITION,
  nodes: REQUISITION.nodes.map((n) => ({ ...n })),
  edges: [...REQUISITION.edges, { from: "approve", to: "check", label: "Request info" }],
});

const col = (L, id) => L.nodes.find((n) => n.id === id).col;
const node = (L, id) => L.nodes.find((n) => n.id === id);
const overlaps = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const ids = (svg) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

/** A node's full footprint: shape plus label, SLA chip and pain badge. */
function footprint(n) {
  return { x1: n.box.x1 - 2, x2: n.box.x2 + 2, y1: n.cy - n.above, y2: n.cy + n.below };
}

function segCrossesBox(a, b, r) {
  if (a[1] === b[1]) {
    return a[1] > r.y1 && a[1] < r.y2 && Math.max(a[0], b[0]) > r.x1 && Math.min(a[0], b[0]) < r.x2;
  }
  return a[0] > r.x1 && a[0] < r.x2 && Math.max(a[1], b[1]) > r.y1 && Math.min(a[1], b[1]) < r.y2;
}

test("a linear flow gets one column per step", () => {
  const L = layoutSwimlane({
    l1: "Linear",
    lanes: ["A", "B"],
    nodes: [
      { id: "s", type: "start", lane: "A", label: "Go" },
      { id: "t1", type: "task", lane: "A", label: "One" },
      { id: "t2", type: "task", lane: "B", label: "Two" },
      { id: "e", type: "end", lane: "B", label: "Done" },
    ],
    edges: [
      { from: "s", to: "t1" },
      { from: "t1", to: "t2" },
      { from: "t2", to: "e" },
    ],
  });
  assert.deepEqual(["s", "t1", "t2", "e"].map((id) => col(L, id)), [0, 1, 2, 3]);
  assert.equal(L.columns, 4);
  const xs = ["s", "t1", "t2", "e"].map((id) => node(L, id).cx);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, "columns run left to right");
});

test("columns are the longest path from the start", () => {
  const L = layoutSwimlane(REQUISITION);
  assert.equal(col(L, "start"), 0);
  assert.equal(col(L, "check"), 1);
  assert.equal(col(L, "g-cat"), 2);
  assert.equal(col(L, "raise-cat"), 3);
  assert.equal(col(L, "raise-non"), 3);
  assert.equal(col(L, "mark"), 4);
  // g-ctl waits for the longer Yes branch through the Program Manager
  assert.equal(col(L, "g-ctl"), col(L, "pm") + 1);
  assert.ok(col(L, "pm") > col(L, "g-spend"));
  // the Buyer task follows both of its predecessors
  assert.ok(col(L, "buyer") > col(L, "g-rel"));
  assert.ok(col(L, "buyer") > col(L, "g-ctl"));
  assert.equal(col(L, "end-ok"), col(L, "buyer") + 1);
});

test("gateway branches land in later columns", () => {
  const L = layoutSwimlane(REQUISITION);
  for (const e of REQUISITION.edges) {
    if (node(L, e.from).type !== "gateway") continue;
    assert.ok(col(L, e.to) > col(L, e.from), `${e.from} → ${e.to}`);
  }
});

test("every node sits inside its own lane, lanes stack top to bottom", () => {
  const L = layoutSwimlane(REQUISITION);
  L.lanes.forEach((lane, i) => {
    assert.equal(lane.name, REQUISITION.lanes[i]);
    assert.ok(lane.h >= 96);
    if (i > 0) assert.equal(lane.y, L.lanes[i - 1].y + L.lanes[i - 1].h);
  });
  for (const n of L.nodes) {
    const lane = L.lanes[n.laneIndex];
    assert.equal(lane.name, n.lane);
    const f = footprint(n);
    assert.ok(f.y1 >= lane.y && f.y2 <= lane.y + lane.h, `${n.id} inside ${n.lane}`);
  }
  assert.equal(L.height, L.lanes.reduce((s, l) => s + l.h, 0));
});

test("nodes sharing a lane and column stack instead of overlapping", () => {
  const L = layoutSwimlane(REQUISITION);
  const a = node(L, "raise-cat");
  const b = node(L, "raise-non");
  assert.equal(a.cx, b.cx);
  assert.ok(a.cy < b.cy, "Yes branch on top, discovery order");
});

test("no two node footprints overlap", () => {
  for (const flow of [REQUISITION, withLoop()]) {
    const L = layoutSwimlane(flow);
    for (let i = 0; i < L.nodes.length; i++) {
      for (let j = i + 1; j < L.nodes.length; j++) {
        const [a, b] = [L.nodes[i], L.nodes[j]];
        assert.ok(!overlaps(footprint(a), footprint(b)), `${a.id} overlaps ${b.id}`);
      }
    }
  }
});

test("every edge is drawn, orthogonal, and never crosses another node's box", () => {
  for (const flow of [REQUISITION, withLoop()]) {
    const L = layoutSwimlane(flow);
    const { svg } = renderSwimlane(flow);
    assert.equal(L.edges.length, flow.edges.length);
    assert.equal((svg.match(/<path class="sl-edge/g) || []).length, flow.edges.length);
    for (const e of L.edges) {
      assert.ok(e.points.length >= 2, `${e.from} → ${e.to} has a route`);
      for (let i = 1; i < e.points.length; i++) {
        const [a, b] = [e.points[i - 1], e.points[i]];
        assert.ok(a[0] === b[0] || a[1] === b[1], `${e.from} → ${e.to} segment ${i} is orthogonal`);
        for (const n of L.nodes) {
          if (n.id === e.from || n.id === e.to) continue;
          assert.ok(!segCrossesBox(a, b, n.box), `${e.from} → ${e.to} crosses ${n.id}`);
        }
      }
    }
  }
});

test("forward edges arrive at the target's left side", () => {
  const L = layoutSwimlane(REQUISITION);
  for (const e of L.edges) {
    const v = node(L, e.to);
    const last = e.points[e.points.length - 1];
    assert.deepEqual(last, [v.cx - v.hw, v.cy], `${e.from} → ${e.to}`);
  }
});

test("a gateway branch to another row leaves from the diamond's vertex", () => {
  const L = layoutSwimlane(REQUISITION);
  const e = L.edges.find((x) => x.from === "g-ctl" && x.to === "buyer");
  const g = node(L, "g-ctl");
  assert.deepEqual(e.points[0], [g.cx, g.cy + g.hh]);
  const up = L.edges.find((x) => x.from === "g-spend" && x.to === "g-ctl");
  const s = node(L, "g-spend");
  assert.deepEqual(up.points[0], [s.cx, s.cy - s.hh]);
});

test("a loop is a dashed back-edge routed below its lanes", () => {
  const flow = withLoop();
  const L = layoutSwimlane(flow);
  const e = L.edges.find((x) => x.from === "approve" && x.to === "check");
  assert.equal(e.back, true);
  assert.ok(L.edges.filter((x) => x.back).length === 1);
  const lowest = L.lanes[Math.max(node(L, "approve").laneIndex, node(L, "check").laneIndex)];
  const maxY = Math.max(...e.points.map((p) => p[1]));
  assert.ok(maxY > node(L, "approve").cy + node(L, "approve").below, "dips below the source");
  assert.ok(maxY <= lowest.y + lowest.h, "stays inside the lowest involved lane");
  const { svg } = renderSwimlane(flow);
  assert.match(svg, /class="sl-edge sl-edge-back"[^>]*data-from="approve" data-to="check"/);
  // columns unchanged by the loop
  assert.equal(col(L, "check"), 1);
});

test("a self-loop does not throw", () => {
  const { svg } = renderSwimlane({
    l1: "Self",
    lanes: ["A"],
    nodes: [
      { id: "s", type: "start", lane: "A", label: "s" },
      { id: "t", type: "task", lane: "A", label: "Retry" },
      { id: "e", type: "end", lane: "A", label: "e" },
    ],
    edges: [
      { from: "s", to: "t" },
      { from: "t", to: "t", label: "Again" },
      { from: "t", to: "e" },
    ],
  });
  assert.match(svg, /sl-edge-back/);
});

test("edge labels become pills, Yes is styled positive", () => {
  const { svg } = renderSwimlane(REQUISITION);
  assert.equal((svg.match(/class="sl-pill sl-pill-yes"/g) || []).length, 4);
  assert.equal((svg.match(/class="sl-pill sl-pill-no"/g) || []).length, 4);
});

test("label pills never cover a node", () => {
  for (const flow of [REQUISITION, withLoop()]) {
    const L = layoutSwimlane(flow);
    for (const e of L.edges.filter((x) => x.pill)) {
      const r = { x1: e.pill.x, y1: e.pill.y, x2: e.pill.x + e.pill.w, y2: e.pill.y + e.pill.h };
      for (const n of L.nodes) assert.ok(!overlaps(r, n.box), `${e.label} pill (${e.from}) covers ${n.id}`);
    }
  }
});

test("ids are unique per instance, so two swimlanes share a page", () => {
  const a = renderSwimlane(REQUISITION, { idPrefix: "sl-a" }).svg;
  const b = renderSwimlane(REQUISITION, { idPrefix: "sl-b" }).svg;
  const ia = ids(a);
  const ib = ids(b);
  assert.ok(ia.length >= 2);
  assert.equal(new Set(ia).size, ia.length);
  assert.ok(ia.every((id) => !ib.includes(id)));
  for (const svg of [a, b]) {
    const own = new Set(ids(svg));
    for (const [, ref] of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(own.has(ref), `#${ref} resolves`);
  }
  // a hostile prefix cannot break out of the attribute
  assert.doesNotMatch(renderSwimlane(REQUISITION, { idPrefix: 'x" onload="y' }).svg, /onload="/);
});

test("all text is escaped", () => {
  const nasty = `<script>alert("x")</script> & 'q'`;
  const { svg } = renderSwimlane({
    l1: `R&D <ops>`,
    lanes: [`Lab "A" <x>`],
    nodes: [
      { id: "s", type: "start", lane: `Lab "A" <x>`, label: nasty },
      { id: `t"1`, type: "task", lane: `Lab "A" <x>`, label: nasty, activity: nasty, pain: nasty, sla: nasty },
      { id: "g", type: "gateway", lane: `Lab "A" <x>`, label: nasty },
      { id: "e", type: "end", lane: `Lab "A" <x>`, label: nasty },
      { id: "e2", type: "end", lane: `Lab "A" <x>`, label: "x" },
    ],
    edges: [
      { from: "s", to: `t"1` },
      { from: `t"1`, to: "g" },
      { from: "g", to: "e", label: nasty },
      { from: "g", to: "e2", label: "Yes" },
    ],
  });
  assert.doesNotMatch(svg, /<script/);
  assert.doesNotMatch(svg, /"x"\)/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /aria-label="R&amp;D &lt;ops&gt; swimlane"/);
  assert.match(svg, /data-node="t&quot;1"/);
  assert.match(svg, /data-activity="&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;q&#39;"/);
  // every attribute value is well formed: no stray quotes or angle brackets
  for (const [, v] of svg.matchAll(/="([^"]*)"/g)) assert.doesNotMatch(v, /[<>]/);
});

test("task hooks: data-node always, button semantics only with an activity", () => {
  const { svg } = renderSwimlane(REQUISITION);
  assert.match(
    svg,
    /<g class="sl-node sl-node-task" data-node="check" tabindex="0" role="button" aria-label="Check catalogue or BPA" data-activity="Check catalogue or BPA">/,
  );
  assert.match(svg, /<g class="sl-node sl-node-task" data-node="mark">/);
  assert.match(svg, /<g class="sl-node sl-node-task sl-node-sys" data-node="chain">/);
  assert.match(svg, /<g class="sl-node sl-node-task sl-node-pain" data-node="raise-non">/);
  assert.match(svg, /<title>Pain point: Free-text entry with no guidance on required fields<\/title>/);
  assert.match(svg, /<title>SLA: Reminder 2 bd, escalation 4 bd<\/title>/);
});

test("root svg: group role, label, sized by the layout, no colour attributes", () => {
  const { svg, width, height } = renderSwimlane(REQUISITION);
  const L = layoutSwimlane(REQUISITION);
  assert.equal(width, L.width);
  assert.equal(height, L.height);
  assert.match(
    svg,
    new RegExp(`^<svg [^>]*class="sl" role="group" aria-label="Requisition &amp; Approval swimlane" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`),
  );
  assert.match(svg, /<title>Requisition &amp; Approval swimlane<\/title>/);
  assert.doesNotMatch(svg, /(fill|stroke|flood-color|color)="#/);
  assert.doesNotMatch(svg, /style="/);
  for (const cls of ["sl-start", "sl-end-good", "sl-end-bad", "sl-gw", "sl-task-sys", "sl-badge-sys", "sl-lane-alt"]) {
    assert.match(svg, new RegExp(`class="[^"]*\\b${cls}\\b`), cls);
  }
});

test("lane abbreviations", () => {
  assert.deepEqual(laneInfo("Requester (REQ)"), { name: "Requester (REQ)", display: "Requester", abbr: "REQ", system: false });
  assert.deepEqual(laneInfo("System"), { name: "System", display: "System", abbr: "SYS", system: true });
  assert.deepEqual(laneInfo("Oracle (system)"), { name: "Oracle (system)", display: "Oracle", abbr: "SYS", system: true });
  assert.equal(laneInfo("Oracle EBS").system, true);
  assert.equal(laneInfo("Oracle iProcurement (ORA)").abbr, "ORA");
  assert.equal(laneInfo("Program Manager").abbr, "PM");
  assert.equal(laneInfo("Trade Compliance Officer").abbr, "TCO");
  assert.equal(laneInfo("Head of Procurement and Contracts Services").abbr, "HPC");
  assert.equal(laneInfo("Buyer").abbr, "BUY");
  assert.equal(laneInfo("Contractor (external)").display, "Contractor (external)", "non-abbreviation suffix stays");
  assert.equal(laneInfo("Systems Engineer").system, false);
  const { svg } = renderSwimlane(REQUISITION);
  assert.match(svg, />REQ<\/text>/);
  assert.match(svg, />SYS<\/text>/);
  assert.match(svg, />PM<\/text>/);
  assert.match(svg, /class="sl-text sl-lane-name"[^>]*>Requester<\/text>/);
  assert.doesNotMatch(svg, /sl-lane-name"[^>]*>[^<]*\(REQ\)/);
});

test("long labels wrap to three lines with an ellipsis, full text in the title", () => {
  const long = "Reconcile the purchase order against the goods receipt and the supplier invoice before releasing payment";
  const w = wrapText(long, 102, 11, 3);
  assert.equal(w.lines.length, 3);
  assert.equal(w.truncated, true);
  assert.ok(w.lines[2].endsWith("…"));
  for (const line of w.lines) assert.ok(line.length * 11 * 0.555 <= 102 + 1, line);
  const { svg } = renderSwimlane({
    l1: "x",
    lanes: ["A"],
    nodes: [
      { id: "s", type: "start", lane: "A", label: "s" },
      { id: "t", type: "task", lane: "A", label: long },
      { id: "e", type: "end", lane: "A", label: "e" },
    ],
    edges: [
      { from: "s", to: "t" },
      { from: "t", to: "e" },
    ],
  });
  assert.match(svg, new RegExp(`<title>${long}</title>`));
  assert.equal((svg.match(/class="sl-text sl-task-label"/g) || []).length, 3);
  assert.deepEqual(wrapText("Short", 100, 11), { lines: ["Short"], truncated: false });
  assert.ok(wrapText("Supercalifragilisticexpialidocious", 60, 11).lines.every((l) => l.length <= 9));
});

test("tolerates an empty or partial flow", () => {
  assert.doesNotThrow(() => renderSwimlane({ l1: "Empty", lanes: ["A"], nodes: [], edges: [] }));
  assert.doesNotThrow(() => renderSwimlane({}));
  const { svg } = renderSwimlane({
    l1: "x",
    lanes: ["A"],
    nodes: [{ id: "t", type: "task", lane: "Unlisted", label: "t" }],
    edges: [{ from: "t", to: "missing" }],
  });
  assert.match(svg, /data-lane="Unlisted"/);
});
