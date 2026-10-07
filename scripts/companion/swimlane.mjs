// flow → layout → SVG string. Pure, no dependencies, no I/O.
//
// A flow is one L1 phase drawn as a "polished BPMN" swimlane: one lane per
// role, columns from the longest path out of the start, orthogonal edges.
// The input is assumed validated (scripts/lib/flows.mjs) but nothing here
// throws on a malformed graph — an unknown lane is appended, an unknown type
// draws as a task, an edge to a missing node is dropped.
//
// Colours are NOT emitted. Every shape carries a semantic class and
// swimlane.css (inlined by the page) maps those onto the page's tokens, so
// light, dark and print come from one stylesheet.

// ---- geometry (px) ---------------------------------------------------------
const LABEL_W = 170; // lane label column
const PAD_L = 16; // gap between the label column and column 0
const PAD_R = 24;
const COL_W = 150;
const TASK_W = 118;
const TASK_H = 54;
const GW_R = 24; // gateway half-diagonal
const EV_R = 12; // start / end radius
const LANE_MIN_H = 96;
const LANE_PAD = 14;
const STACK_GAP = 20;
const BACK_STEP = 6; // spacing between back-edges sharing a lane's bottom channel
const OB_PAD = 3; // obstacle inflation for routing
const TRACK = 8; // offset between parallel gutter tracks

// ---- type (px) — mirrored by font-size attributes so wrapping matches ------
const FS = { task: 11, gw: 10.5, ev: 10, lane: 11.5, badge: 10, pill: 9.5, sla: 9.5 };
const LH = { task: 13, gw: 12, ev: 12, lane: 14, sla: 11 };
const CHAR_EM = 0.555; // ≈6.1px per character at 11px

const GW_LABEL_W = 100;
const GW_LABEL_BASE = 32; // last gateway-label baseline sits this far above the centre
const EV_LABEL_W = 116;
const SLA_TEXT_W = 116;
const LANE_TEXT_X = 54;
const LANE_TEXT_W = LABEL_W - LANE_TEXT_X - 14;

const r1 = (n) => Math.round(n * 10) / 10;

export function escapeXml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

export const textWidth = (text, fontSize) => String(text ?? "").length * fontSize * CHAR_EM;

/** Greedy word wrap by estimated width; ellipsis when it runs past maxLines. */
export function wrapText(text, maxPx, fontSize, maxLines = 3) {
  const maxChars = Math.max(4, Math.floor(maxPx / (fontSize * CHAR_EM)));
  // a long hyphenated word may break after its hyphens ("export-|controlled")
  const tokens = [];
  for (const word of String(text ?? "").trim().split(/\s+/).filter(Boolean)) {
    const parts = word.length > maxChars ? word.split(/(?<=-)(?=.)/) : [word];
    parts.forEach((part, i) => tokens.push({ part, glue: i === 0 ? " " : "" }));
  }
  const lines = [];
  let cur = "";
  for (const { part, glue } of tokens) {
    let w = part;
    if (cur && (cur + glue + w).length <= maxChars) {
      cur += glue + w;
      continue;
    }
    if (cur) lines.push(cur);
    cur = "";
    while (w.length > maxChars) {
      lines.push(w.slice(0, maxChars - 1) + "-");
      w = w.slice(maxChars - 1);
    }
    cur = w;
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return { lines, truncated: false };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  if (last.length + 1 > maxChars) {
    const cut = last.slice(0, maxChars - 1);
    last = cut.includes(" ") ? cut.replace(/\s+\S*$/, "") : cut;
  }
  kept[maxLines - 1] = last.replace(/[\s,;:.\-–—]+$/, "") + "…";
  return { lines: kept, truncated: true };
}

// ---- lanes -----------------------------------------------------------------
const STOP = new Set(["and", "of", "the", "for", "&", "to", "in", "on"]);

function initials(display) {
  const words = display
    .split(/[\s\-/]+/)
    .filter((w) => /[A-Za-z0-9]/.test(w) && !STOP.has(w.toLowerCase()));
  if (!words.length) return "?";
  if (words.length === 1) return words[0].replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
  return words
    .map((w) => w.match(/[A-Za-z0-9]/)[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
}

/** Lane name → displayed name, badge abbreviation, system styling. */
export function laneInfo(name) {
  const raw = String(name ?? "").trim();
  const system = /^system$/i.test(raw) || /\(\s*system\s*\)/i.test(raw) || /\boracle\b/i.test(raw);
  const m = raw.match(/^(.*\S)\s*\(\s*([^()]{1,12}?)\s*\)$/);
  let display = raw;
  let abbr = null;
  if (m) {
    const tag = m[2];
    if (/^[A-Z0-9&]{1,5}$/.test(tag)) {
      abbr = tag;
      display = m[1];
    } else if (/^system$/i.test(tag)) {
      display = m[1];
    }
  }
  if (!abbr) abbr = system ? "SYS" : initials(display);
  return { name: raw, display, abbr, system };
}

// ---- ranking ---------------------------------------------------------------
/** Longest-path columns over the graph with DFS back-edges removed. */
function rankNodes(ids, startId, edges) {
  const out = new Map(ids.map((id) => [id, []]));
  edges.forEach((e, i) => out.get(e.from).push(i));
  const state = new Map(); // 1 = on the DFS stack, 2 = finished
  const back = new Set();
  const discovery = new Map();
  const roots = startId ? [startId, ...ids.filter((id) => id !== startId)] : ids;
  for (const root of roots) {
    if (state.has(root)) continue;
    state.set(root, 1);
    discovery.set(root, discovery.size);
    const stack = [[root, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = out.get(top[0]);
      if (top[1] < list.length) {
        const ei = list[top[1]++];
        const to = edges[ei].to;
        const s = state.get(to);
        if (s === 1) back.add(ei);
        else if (!s) {
          state.set(to, 1);
          discovery.set(to, discovery.size);
          stack.push([to, 0]);
        }
      } else {
        state.set(top[0], 2);
        stack.pop();
      }
    }
  }
  const indeg = new Map(ids.map((id) => [id, 0]));
  edges.forEach((e, i) => {
    if (!back.has(i)) indeg.set(e.to, indeg.get(e.to) + 1);
  });
  const rank = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    for (const ei of out.get(id)) {
      if (back.has(ei)) continue;
      const to = edges[ei].to;
      rank.set(to, Math.max(rank.get(to), rank.get(id) + 1));
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  return { rank, back, discovery };
}

// ---- node metrics ------------------------------------------------------------
function measure(n) {
  if (n.type === "task") {
    n.hw = TASK_W / 2;
    n.hh = TASK_H / 2;
    n.text = wrapText(n.label, TASK_W - 16, FS.task, 3);
    n.slaText = n.sla ? wrapText(n.sla, SLA_TEXT_W, FS.sla, 2) : null;
    n.slaH = n.slaText ? 8 + n.slaText.lines.length * LH.sla : 0;
    n.above = n.hh + (n.pain ? 7 : 0);
    n.below = n.hh + (n.slaText ? 6 + n.slaH : 0);
  } else if (n.type === "gateway") {
    n.hw = n.hh = GW_R;
    n.text = wrapText(n.label, GW_LABEL_W, FS.gw, 3);
    const lines = n.text.lines.length;
    n.above = lines ? Math.max(GW_R, GW_LABEL_BASE + (lines - 1) * LH.gw + 10) : GW_R;
    n.below = GW_R;
  } else {
    n.hw = n.hh = EV_R;
    n.text = wrapText(n.label, EV_LABEL_W, FS.ev, 2);
    n.above = EV_R;
    n.below = EV_R + (n.text.lines.length ? 5 + n.text.lines.length * LH.ev : 0);
  }
}

// ---- routing helpers -------------------------------------------------------
function segHits(a, b, r) {
  if (a[1] === b[1]) {
    const y = a[1];
    if (!(y > r.y1 && y < r.y2)) return false;
    return Math.max(a[0], b[0]) > r.x1 && Math.min(a[0], b[0]) < r.x2;
  }
  const x = a[0];
  if (!(x > r.x1 && x < r.x2)) return false;
  return Math.max(a[1], b[1]) > r.y1 && Math.min(a[1], b[1]) < r.y2;
}

function cleanPoints(points) {
  const pts = [];
  for (const p of points) {
    const q = [r1(p[0]), r1(p[1])];
    const last = pts[pts.length - 1];
    if (last && last[0] === q[0] && last[1] === q[1]) continue;
    pts.push(q);
  }
  // drop collinear midpoints
  for (let i = pts.length - 2; i > 0; i--) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) pts.splice(i, 1);
  }
  return pts;
}

/** Orthogonal polyline → path with small rounded corners. */
export function roundedPath(points, radius = 6) {
  if (!points.length) return "";
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const next = points[i + 1];
    if (!next) {
      d += ` L${p[0]},${p[1]}`;
      break;
    }
    const prev = points[i - 1];
    const d1 = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const d2 = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    const ax = p[0] - (Math.sign(p[0] - prev[0]) * r);
    const ay = p[1] - (Math.sign(p[1] - prev[1]) * r);
    const bx = p[0] + (Math.sign(next[0] - p[0]) * r);
    const by = p[1] + (Math.sign(next[1] - p[1]) * r);
    d += ` L${r1(ax)},${r1(ay)} Q${p[0]},${p[1]} ${r1(bx)},${r1(by)}`;
  }
  return d;
}

const POSITIVE =
  /^(yes|y|ok|true|approved?|accept(ed)?|released?|pass(ed)?|valid|confirm(ed)?|complete[d]?|success(ful)?|covered|in stock)\b/i;
const NEGATIVE = /^(no|n|false|reject(ed)?|declined?|fail(ed)?|invalid|denied|not\b|on hold)\b/i;

export function pillKind(label) {
  if (POSITIVE.test(String(label).trim())) return "yes";
  if (NEGATIVE.test(String(label).trim())) return "no";
  return "";
}

// ---- layout ----------------------------------------------------------------
export function layoutSwimlane(flow) {
  const laneNames = (Array.isArray(flow?.lanes) ? flow.lanes : []).map((l) => String(l));
  const nodes = [];
  const byId = new Map();
  for (const raw of Array.isArray(flow?.nodes) ? flow.nodes : []) {
    if (!raw || raw.id == null || byId.has(String(raw.id))) continue;
    const type = ["start", "task", "gateway", "end"].includes(raw.type) ? raw.type : "task";
    const lane = String(raw.lane ?? "");
    if (!laneNames.includes(lane)) laneNames.push(lane);
    const n = {
      id: String(raw.id),
      type,
      lane,
      label: String(raw.label ?? ""),
      activity: raw.activity ? String(raw.activity) : "",
      pain: raw.pain ? String(raw.pain) : "",
      sla: raw.sla ? String(raw.sla) : "",
      outcome: raw.outcome === "bad" ? "bad" : "good",
    };
    nodes.push(n);
    byId.set(n.id, n);
  }
  const edges = (Array.isArray(flow?.edges) ? flow.edges : [])
    .filter((e) => e && byId.has(String(e.from)) && byId.has(String(e.to)))
    .map((e) => ({ from: String(e.from), to: String(e.to), label: e.label ? String(e.label) : "" }));

  const lanes = laneNames.map((name, i) => ({ ...laneInfo(name), index: i }));
  const laneIndex = new Map(laneNames.map((n, i) => [n, i]));
  for (const n of nodes) {
    n.laneIndex = laneIndex.get(n.lane);
    n.system = lanes[n.laneIndex].system;
    measure(n);
  }

  const start = nodes.find((n) => n.type === "start");
  const { rank, back, discovery } = rankNodes(
    nodes.map((n) => n.id),
    start?.id,
    edges,
  );
  edges.forEach((e, i) => (e.back = back.has(i)));
  for (const n of nodes) n.col = rank.get(n.id);
  const columns = nodes.length ? Math.max(...nodes.map((n) => n.col)) + 1 : 1;

  // stacks: nodes sharing (lane, column), ordered by where their predecessors sit
  const preds = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (!e.back && e.from !== e.to) preds.get(e.to).push(byId.get(e.from));
  const groups = new Map();
  for (const n of nodes) {
    const key = `${n.laneIndex}:${n.col}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const ordered = [...groups.values()].sort((a, b) => a[0].col - b[0].col);
  for (const g of ordered) {
    for (const n of g) {
      const ps = preds.get(n.id);
      n.sortKey = ps.length
        ? ps.reduce((s, p) => s + p.laneIndex + (p.stackIndex + 1) / (p.stackSize + 1), 0) / ps.length
        : Infinity;
    }
    g.sort((a, b) => a.sortKey - b.sortKey || discovery.get(a.id) - discovery.get(b.id));
    g.forEach((n, i) => {
      n.stackIndex = i;
      n.stackSize = g.length;
    });
  }

  // back-edges travel along the bottom of the lowest lane they touch
  const backCount = new Array(lanes.length).fill(0);
  for (const e of edges) {
    if (!e.back) continue;
    const lane = Math.max(byId.get(e.from).laneIndex, byId.get(e.to).laneIndex);
    e.channelLane = lane;
    e.channelSlot = backCount[lane]++;
  }

  // lane heights and node centres
  for (const lane of lanes) {
    lane.needAbove = 0;
    lane.needBelow = 0;
  }
  for (const g of ordered) {
    let off = 0;
    g.forEach((n, i) => {
      if (i > 0) off += g[i - 1].below + STACK_GAP + n.above;
      n.offset = off;
    });
    const half = off / 2;
    for (const n of g) n.offset -= half;
    const lane = lanes[g[0].laneIndex];
    lane.needAbove = Math.max(lane.needAbove, half + g[0].above);
    lane.needBelow = Math.max(lane.needBelow, half + g[g.length - 1].below);
  }
  let y = 0;
  for (const lane of lanes) {
    const reserve = backCount[lane.index] ? backCount[lane.index] * BACK_STEP + 4 : 0;
    lane.needBelow += reserve;
    lane.text = wrapText(lane.display, LANE_TEXT_W, FS.lane, 3);
    const textH = lane.text.lines.length * LH.lane;
    lane.y = y;
    lane.h = Math.ceil(Math.max(LANE_MIN_H, lane.needAbove + lane.needBelow + 2 * LANE_PAD, textH + 2 * LANE_PAD, 30 + 2 * LANE_PAD));
    const lo = y + LANE_PAD + lane.needAbove;
    const hi = y + lane.h - LANE_PAD - lane.needBelow;
    lane.axis = r1(Math.min(Math.max(y + lane.h / 2, lo), hi));
    y += lane.h;
  }
  const height = y;
  const width = LABEL_W + PAD_L + columns * COL_W + PAD_R;
  const colX = (c) => LABEL_W + PAD_L + c * COL_W + COL_W / 2;

  for (const n of nodes) {
    n.cx = r1(colX(n.col));
    n.cy = r1(lanes[n.laneIndex].axis + n.offset);
    n.box = { x1: n.cx - n.hw, y1: n.cy - n.hh, x2: n.cx + n.hw, y2: n.cy + n.hh };
  }

  // routing obstacles: each shape, plus the decorations an edge must not cross
  const obstacles = [];
  for (const n of nodes) {
    obstacles.push({
      id: n.id,
      kind: "shape",
      x1: n.box.x1 - OB_PAD,
      y1: n.box.y1 - OB_PAD,
      x2: n.box.x2 + OB_PAD,
      y2: n.box.y2 + OB_PAD,
    });
    if (n.type === "task" && n.slaText) {
      n.slaW = Math.min(COL_W - 8, 25 + Math.max(...n.slaText.lines.map((l) => textWidth(l, FS.sla))));
      obstacles.push({
        id: n.id,
        kind: "deco",
        x1: n.cx - n.slaW / 2,
        y1: n.box.y2 + 6,
        x2: n.cx + n.slaW / 2,
        y2: n.box.y2 + 6 + n.slaH,
      });
    }
    if ((n.type === "start" || n.type === "end") && n.text.lines.length) {
      const w = Math.max(...n.text.lines.map((l) => textWidth(l, FS.ev)));
      obstacles.push({
        id: n.id,
        kind: "deco",
        x1: n.cx - w / 2,
        y1: n.cy + EV_R + 2,
        x2: n.cx + w / 2,
        y2: n.cy + n.below,
      });
    }
  }
  const clear = (pts, e) => {
    for (let i = 1; i < pts.length; i++) {
      for (const ob of obstacles) {
        if (ob.kind === "shape" && (ob.id === e.from || ob.id === e.to)) continue;
        if (segHits(pts[i - 1], pts[i], ob)) return false;
      }
    }
    return true;
  };

  // gutter tracks: parallel verticals from unrelated edges never share a line
  const vsegs = [];
  const gutter = (base, ya, yb, e) => {
    const lo = Math.min(ya, yb) - 4;
    const hi = Math.max(ya, yb) + 4;
    for (const k of [0, 1, -1, 2, -2, 3, -3]) {
      const x = r1(base + k * TRACK);
      const taken = vsegs.some(
        (s) => s.x === x && s.from !== e.from && s.to !== e.to && s.hi > lo && s.lo < hi,
      );
      if (!taken) return x;
    }
    return r1(base);
  };
  const commit = (pts, e) => {
    for (let i = 1; i < pts.length; i++) {
      if (pts[i - 1][0] === pts[i][0]) {
        vsegs.push({
          x: pts[i][0],
          lo: Math.min(pts[i - 1][1], pts[i][1]),
          hi: Math.max(pts[i - 1][1], pts[i][1]),
          from: e.from,
          to: e.to,
        });
      }
    }
  };
  const gAfter = (c) => colX(c) + COL_W / 2;
  const gBefore = (c) => colX(c) - COL_W / 2;
  const portsUsed = new Map(nodes.map((n) => [n.id, new Set()]));

  // gateway exits: same row → right, otherwise the vertex facing the target
  const wantPort = new Map();
  for (const n of nodes) {
    if (n.type !== "gateway") continue;
    const outs = edges
      .filter((e) => e.from === n.id && !e.back && e.from !== e.to)
      .map((e) => ({ e, dy: byId.get(e.to).cy - n.cy }))
      .sort((a, b) => Math.abs(a.dy) - Math.abs(b.dy));
    const free = new Set(["top", "bottom", "right"]);
    for (const { e, dy } of outs) {
      let port = Math.abs(dy) < 0.5 ? "right" : dy < 0 ? "top" : "bottom";
      if (port !== "right" && !free.has(port)) port = "right";
      free.delete(port);
      wantPort.set(e, port);
    }
  }

  const forwardOrder = edges
    .filter((e) => !e.back)
    .sort((a, b) => byId.get(a.from).col - byId.get(b.from).col || byId.get(a.to).col - byId.get(b.to).col);
  const backOrder = edges.filter((e) => e.back);

  for (const e of forwardOrder) {
    const u = byId.get(e.from);
    const v = byId.get(e.to);
    const sR = [u.cx + u.hw, u.cy];
    const tL = [v.cx - v.hw, v.cy];
    const cands = [];
    const port = wantPort.get(e);
    if (Math.abs(u.cy - v.cy) < 0.5) {
      cands.push({ pts: [sR, tL], port: "right" });
    } else {
      if (u.type === "gateway" && (port === "top" || port === "bottom")) {
        const sy = port === "top" ? u.cy - u.hh : u.cy + u.hh;
        cands.push({ pts: [[u.cx, sy], [u.cx, v.cy], tL], port });
      }
      const ga = gutter(gAfter(u.col), u.cy, v.cy, e);
      cands.push({ pts: [sR, [ga, u.cy], [ga, v.cy], tL], port: "right" });
      const gb = gutter(gBefore(v.col), u.cy, v.cy, e);
      cands.push({ pts: [sR, [gb, u.cy], [gb, v.cy], tL], port: "right" });
    }
    // through a lane boundary: last resort, always drawn
    const vl = lanes[v.laneIndex];
    const below = v.laneIndex > u.laneIndex || (v.laneIndex === u.laneIndex && v.cy >= u.cy);
    const yb = v.laneIndex === u.laneIndex ? (below ? vl.y + vl.h : vl.y) : below ? vl.y : vl.y + vl.h;
    const ga = gutter(gAfter(u.col), u.cy, yb, e);
    const gb = gutter(gBefore(v.col), yb, v.cy, e);
    cands.push({ pts: [sR, [ga, u.cy], [ga, yb], [gb, yb], [gb, v.cy], tL], port: "right" });

    const chosen = cands.find((c) => clear(c.pts, e)) ?? cands[cands.length - 1];
    e.points = cleanPoints(chosen.pts);
    e.port = chosen.port;
    portsUsed.get(u.id).add(chosen.port);
    commit(e.points, e);
  }

  for (const e of backOrder) {
    const u = byId.get(e.from);
    const v = byId.get(e.to);
    const lane = lanes[e.channelLane];
    const yb = lane.y + lane.h - 7 - e.channelSlot * BACK_STEP;
    if (u === v) {
      e.points = cleanPoints([
        [u.cx, u.cy + u.hh],
        [u.cx, yb],
        [u.cx - u.hw - 14, yb],
        [u.cx - u.hw - 14, u.cy],
        [u.cx - u.hw, u.cy],
      ]);
      e.port = "bottom";
      continue;
    }
    // a task may drop from its bottom edge off-centre to clear its own SLA chip
    const sxs = u.type === "task" ? [u.cx, u.box.x2 - 14] : [u.cx];
    const txs = v.type === "task" ? [v.cx, v.box.x1 + 14] : [v.cx];
    // leaving sideways, a task's back-edge sits below the centre line so it
    // never shares a segment with the forward edge out of the same side
    const sR = [u.cx + u.hw, u.type === "task" ? u.cy + u.hh / 2 : u.cy];
    const tL = [v.cx - v.hw, v.cy];
    const bottomFree = !portsUsed.get(u.id).has("bottom");
    const ga = gutter(gAfter(u.col), u.cy, yb, e);
    const gb = gutter(gBefore(v.col), yb, v.cy, e);
    const sy = u.cy + u.hh;
    const ty = v.cy + v.hh;
    const cands = [];
    if (bottomFree) {
      for (const sx of sxs) for (const tx of txs) cands.push({ pts: [[sx, sy], [sx, yb], [tx, yb], [tx, ty]], port: "bottom" });
    }
    for (const tx of txs) cands.push({ pts: [sR, [ga, sR[1]], [ga, yb], [tx, yb], [tx, ty]], port: "right" });
    if (bottomFree) {
      for (const sx of sxs) cands.push({ pts: [[sx, sy], [sx, yb], [gb, yb], [gb, v.cy], tL], port: "bottom" });
    }
    cands.push({ pts: [sR, [ga, sR[1]], [ga, yb], [gb, yb], [gb, v.cy], tL], port: "right" });
    const chosen = cands.find((c) => clear(c.pts, e)) ?? cands[cands.length - 1];
    e.points = cleanPoints(chosen.pts);
    e.port = chosen.port;
    portsUsed.get(u.id).add(chosen.port);
    commit(e.points, e);
  }

  // edge-label pills: near the source end, clear of every node and label
  const blocked = obstacles.map((o) => ({ ...o }));
  for (const n of nodes) {
    if (n.type === "gateway" && n.text.lines.length) {
      const w = Math.max(...n.text.lines.map((l) => textWidth(l, FS.gw)));
      const top = n.cy - GW_LABEL_BASE - (n.text.lines.length - 1) * LH.gw - 9;
      blocked.push({ x1: n.cx - 6 - w, y1: top, x2: n.cx - 6, y2: n.cy - GW_LABEL_BASE + 3 });
    }
    if (n.pain) blocked.push({ x1: n.box.x2 - 11, y1: n.box.y1 - 5, x2: n.box.x2 + 5, y2: n.box.y1 + 11 });
  }
  const free = (r) => !blocked.some((b) => r.x1 < b.x2 && b.x1 < r.x2 && r.y1 < b.y2 && b.y1 < r.y2);
  for (const e of edges) {
    e.d = roundedPath(e.points);
    if (!e.label) continue;
    const text = e.label.length > 24 ? e.label.slice(0, 23).trimEnd() + "…" : e.label;
    const w = r1(textWidth(text, FS.pill) + 14);
    const h = 16;
    const pts = e.points;
    const segs = pts.slice(1).map((b, i) => {
      const a = pts[i];
      const vertical = a[0] === b[0];
      const len = vertical ? Math.abs(b[1] - a[1]) : Math.abs(b[0] - a[0]);
      return { a, b, vertical, len, dir: vertical ? Math.sign(b[1] - a[1]) : Math.sign(b[0] - a[0]) };
    });
    const spots = [];
    const beside = (s) => {
      if (s.vertical) {
        const yc = s.a[1] + s.dir * (h / 2 + 5);
        spots.push({ x: s.a[0] + 5, yc }, { x: s.a[0] - 5 - w, yc }, { x: s.a[0] - w / 2, yc });
      } else {
        const x = s.dir > 0 ? s.a[0] + 6 : s.a[0] - 6 - w;
        spots.push({ x, yc: s.a[1] - h / 2 - 3 }, { x, yc: s.a[1] + h / 2 + 3 }, { x, yc: s.a[1] });
      }
    };
    if (e.back) {
      // on the return run, near where it starts
      const run = segs.reduce((m, s) => (!s.vertical && s.len > (m?.len ?? 0) ? s : m), null);
      if (run) spots.push({ x: run.dir > 0 ? run.a[0] + 10 : run.a[0] - 10 - w, yc: run.a[1] });
    }
    for (const s of segs.slice(0, 3)) {
      if (s.vertical ? s.len >= h + 12 : s.len >= w + 10) beside(s);
    }
    const last = segs[segs.length - 1];
    if (last && !last.vertical && last.len >= w + 14) {
      spots.push({ x: last.dir > 0 ? last.b[0] - 10 - w : last.b[0] + 10, yc: last.b[1] - h / 2 - 3 });
    }
    if (!spots.length) beside(segs[0]);
    const rect = (sp) => ({ x1: sp.x, y1: sp.yc - h / 2, x2: sp.x + w, y2: sp.yc + h / 2 });
    const spot = spots.find((sp) => free(rect(sp))) ?? spots[0];
    blocked.push(rect(spot));
    e.pill = { x: r1(spot.x), y: r1(spot.yc - h / 2), w, h, text, full: e.label, kind: pillKind(e.label) };
  }

  return { width, height, columns, lanes, nodes, edges, labelWidth: LABEL_W };
}

// ---- SVG -------------------------------------------------------------------
function textLines(lines, x, firstBaseline, lineHeight, attrs) {
  return lines
    .map(
      (l, i) =>
        `<text x="${r1(x)}" y="${r1(firstBaseline + i * lineHeight)}"${attrs}>${escapeXml(l)}</text>`,
    )
    .join("");
}

function renderTask(n, p) {
  const cls = ["sl-node", "sl-node-task"];
  if (n.system) cls.push("sl-node-sys");
  if (n.pain) cls.push("sl-node-pain");
  const interactive = n.activity
    ? ` tabindex="0" role="button" aria-label="${escapeXml(n.label)}" data-activity="${escapeXml(n.activity)}"`
    : "";
  const o = [`<g class="${cls.join(" ")}" data-node="${escapeXml(n.id)}"${interactive}>`];
  o.push(`<title>${escapeXml(n.label)}</title>`);
  const shadow = n.system ? "" : ` filter="url(#${p}-shadow)"`;
  o.push(
    `<rect class="sl-task${n.system ? " sl-task-sys" : ""}" x="${r1(n.box.x1)}" y="${r1(n.box.y1)}" width="${TASK_W}" height="${TASK_H}" rx="8"${shadow}/>`,
  );
  const lines = n.text.lines;
  const first = n.cy + FS.task * 0.36 - ((lines.length - 1) * LH.task) / 2;
  o.push(textLines(lines, n.cx, first, LH.task, ` class="sl-text sl-task-label" text-anchor="middle" font-size="${FS.task}"`));
  if (n.slaText) {
    const x = n.cx - n.slaW / 2;
    const y = n.box.y2 + 6;
    o.push(`<g class="sl-sla"><title>SLA: ${escapeXml(n.sla)}</title>`);
    o.push(`<rect class="sl-sla-bg" x="${r1(x)}" y="${r1(y)}" width="${r1(n.slaW)}" height="${n.slaH}" rx="${r1(Math.min(8, n.slaH / 2))}"/>`);
    const ix = x + 11;
    const iy = y + 4 + LH.sla / 2;
    o.push(
      `<circle class="sl-sla-icon" cx="${r1(ix)}" cy="${r1(iy)}" r="3.6" fill="none"/><path class="sl-sla-icon" d="M${r1(ix)},${r1(iy - 2)} V${r1(iy)} H${r1(ix + 1.8)}" fill="none"/>`,
    );
    o.push(textLines(n.slaText.lines, x + 19, y + 4 + FS.sla * 0.86, LH.sla, ` class="sl-sla-text" font-size="${FS.sla}"`));
    o.push(`</g>`);
  }
  if (n.pain) {
    const bx = n.box.x2 - 3;
    const by = n.box.y1 + 3;
    o.push(
      `<g class="sl-pain"><title>Pain point: ${escapeXml(n.pain)}</title><circle class="sl-pain-dot" cx="${r1(bx)}" cy="${r1(by)}" r="8"/><text class="sl-pain-mark" x="${r1(bx)}" y="${r1(by + 3.9)}" text-anchor="middle" font-size="11">!</text></g>`,
    );
  }
  o.push(`</g>`);
  return o.join("");
}

function renderGateway(n) {
  const { cx, cy } = n;
  const o = [`<g class="sl-gw-g" data-node="${escapeXml(n.id)}"><title>${escapeXml(n.label)}</title>`];
  o.push(
    `<polygon class="sl-gw" points="${cx},${r1(cy - GW_R)} ${r1(cx + GW_R)},${cy} ${cx},${r1(cy + GW_R)} ${r1(cx - GW_R)},${cy}"/>`,
  );
  o.push(`<text class="sl-gw-mark" x="${cx}" y="${r1(cy + 4.6)}" text-anchor="middle" font-size="14">?</text>`);
  const lines = n.text.lines;
  const first = cy - GW_LABEL_BASE - (lines.length - 1) * LH.gw;
  o.push(textLines(lines, cx - 6, first, LH.gw, ` class="sl-text sl-gw-label" text-anchor="end" font-size="${FS.gw}"`));
  o.push(`</g>`);
  return o.join("");
}

function renderEvent(n) {
  const kind = n.type === "start" ? "start" : n.outcome === "bad" ? "end-bad" : "end-good";
  const o = [`<g class="sl-event sl-event-${kind}" data-node="${escapeXml(n.id)}"><title>${escapeXml(n.label)}</title>`];
  o.push(`<circle class="sl-${kind}" cx="${n.cx}" cy="${n.cy}" r="${EV_R}"/>`);
  o.push(
    textLines(
      n.text.lines,
      n.cx,
      n.cy + EV_R + 5 + FS.ev * 0.86,
      LH.ev,
      ` class="sl-text sl-event-label sl-label-${kind}" text-anchor="middle" font-size="${FS.ev}"`,
    ),
  );
  o.push(`</g>`);
  return o.join("");
}

function renderLane(lane, width, height) {
  const alt = lane.index % 2 === 1;
  const cls = ["sl-lane"];
  if (alt) cls.push("sl-lane-alt");
  if (lane.system) cls.push("sl-lane-sys");
  const o = [`<g class="sl-lane-g" data-lane="${escapeXml(lane.name)}">`];
  o.push(`<rect class="${cls.join(" ")}" x="0" y="${lane.y}" width="${width}" height="${lane.h}"/>`);
  if (lane.index > 0) o.push(`<line class="sl-sep" x1="0" x2="${width}" y1="${lane.y}" y2="${lane.y}"/>`);
  const mid = lane.y + lane.h / 2;
  o.push(`<g class="sl-lane-label"><title>${escapeXml(lane.name)}</title>`);
  o.push(
    `<circle class="sl-badge${lane.system ? " sl-badge-sys" : ""}" cx="31" cy="${r1(mid)}" r="15"/>`,
  );
  o.push(
    `<text class="sl-badge-text${lane.system ? " sl-badge-text-sys" : ""}" x="31" y="${r1(mid + 3.6)}" text-anchor="middle" font-size="${lane.abbr.length > 2 ? FS.badge - 0.5 : FS.badge}">${escapeXml(lane.abbr)}</text>`,
  );
  const lines = lane.text.lines;
  const first = mid + FS.lane * 0.36 - ((lines.length - 1) * LH.lane) / 2;
  o.push(textLines(lines, LANE_TEXT_X, first, LH.lane, ` class="sl-text sl-lane-name" font-size="${FS.lane}"`));
  o.push(`</g></g>`);
  return o.join("");
}

/** Render one flow. idPrefix keeps marker/filter ids unique per instance. */
export function renderSwimlane(flow, { idPrefix = "sl" } = {}) {
  const p = String(idPrefix || "sl").replace(/[^A-Za-z0-9_-]/g, "-");
  const L = layoutSwimlane(flow);
  const { width, height } = L;
  const name = `${String(flow?.l1 ?? "Process")} swimlane`;
  const o = [];
  o.push(
    `<svg xmlns="http://www.w3.org/2000/svg" class="sl" role="group" aria-label="${escapeXml(name)}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
  );
  o.push(`<title>${escapeXml(name)}</title>`);
  o.push(
    `<defs><marker id="${p}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="sl-arrow" d="M0,0 L10,5 L0,10 z"/></marker>` +
      `<filter id="${p}-shadow" x="-10%" y="-15%" width="120%" height="150%"><feDropShadow class="sl-shadow" dx="0" dy="1" stdDeviation="1.5"/></filter></defs>`,
  );
  o.push(`<g class="sl-lanes">`);
  for (const lane of L.lanes) o.push(renderLane(lane, width, height));
  o.push(`<line class="sl-divider" x1="${L.labelWidth - 4}" x2="${L.labelWidth - 4}" y1="0" y2="${height}"/>`);
  o.push(`</g><g class="sl-edges">`);
  for (const e of L.edges) {
    o.push(
      `<path class="sl-edge${e.back ? " sl-edge-back" : ""}" d="${e.d}" fill="none" marker-end="url(#${p}-arrow)" data-from="${escapeXml(e.from)}" data-to="${escapeXml(e.to)}"/>`,
    );
  }
  o.push(`</g><g class="sl-nodes">`);
  for (const n of L.nodes) {
    if (n.type === "task") o.push(renderTask(n, p));
    else if (n.type === "gateway") o.push(renderGateway(n));
    else o.push(renderEvent(n));
  }
  o.push(`</g><g class="sl-pills">`);
  for (const e of L.edges) {
    if (!e.pill) continue;
    const pl = e.pill;
    o.push(
      `<g class="sl-pill${pl.kind ? ` sl-pill-${pl.kind}` : ""}"><title>${escapeXml(pl.full)}</title><rect class="sl-pill-bg" x="${pl.x}" y="${pl.y}" width="${pl.w}" height="${pl.h}" rx="${pl.h / 2}"/><text class="sl-pill-text" x="${r1(pl.x + pl.w / 2)}" y="${r1(pl.y + pl.h / 2 + FS.pill * 0.36)}" text-anchor="middle" font-size="${FS.pill}">${escapeXml(pl.text)}</text></g>`,
    );
  }
  o.push(`</g></svg>`);
  return { svg: o.join(""), width, height };
}
