// The `flows` contract for process-model.json — one swimlane per L1 phase.
//
// The capability-process-map skill writes `flows`; render-capability-map.mjs
// refuses a model whose flows break these rules, and the companion app draws
// them. Keeping the rules here, pure and in one place, is what lets the guard and
// the renderer agree on what a valid flow is.
//
// `flows` is OPTIONAL: a project mapped before swimlanes existed has none and
// must still validate and render (cards only, no swimlane).
//
// Pure: no I/O, no process.exit. Every error names the file, the flow, the node
// or edge and the field, so the agent can fix the JSON without guessing.

/**
 * @typedef {"start" | "task" | "gateway" | "end"} FlowNodeType
 *
 * @typedef {object} FlowNode
 * @property {string} id         unique within the flow
 * @property {FlowNodeType} type
 * @property {string} lane       one of the flow's `lanes`
 * @property {string} label      1–80 chars
 * @property {string} [activity] an `l3` of an activity in the same `l1`
 * @property {string} [pain]     a stated problem at this step, ≤140 chars
 * @property {string} [sla]      a stated timeframe, ≤60 chars
 * @property {"good" | "bad"} [outcome] END NODES ONLY, always set there (default "good")
 *
 * @typedef {object} FlowEdge
 * @property {string} from       a node id
 * @property {string} to         a node id
 * @property {string} [label]    e.g. "Yes" / "No", ≤24 chars
 *
 * @typedef {object} Flow
 * @property {string} l1         the L1 phase this flow sequences
 * @property {string[]} lanes    actors, in display order
 * @property {FlowNode[]} nodes
 * @property {FlowEdge[]} edges
 */

const FILE = "process-model.json";
const TYPES = ["start", "task", "gateway", "end"];
const OUTCOMES = ["good", "bad"];
const MAX = { label: 80, pain: 140, sla: 60, edgeLabel: 24 };

const str = (v) => (typeof v === "string" ? v.trim() : "");
const q = (s) => JSON.stringify(s);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validate and normalise process-model.json's `flows`.
 *
 * @param {unknown} flows        the raw `flows` value (undefined/null = none)
 * @param {Array<{l1: string, l3: string}>} activities  the model's activities
 * @returns {{ flows: Flow[], errors: string[] }}
 *   `flows` holds only the flows that passed every rule (strings trimmed,
 *   unknown keys dropped); `errors` lists every failure, not just the first.
 *   A caller that must refuse bad data refuses when `errors` is non-empty.
 */
export function validateFlows(flows, activities) {
  if (flows === undefined || flows === null) return { flows: [], errors: [] };
  if (!Array.isArray(flows)) return { flows: [], errors: [`${FILE}: "flows" must be an array, got ${typeof flows}.`] };

  const l3sByL1 = new Map();
  for (const a of Array.isArray(activities) ? activities : []) {
    const l1 = str(a?.l1);
    if (!l1) continue;
    if (!l3sByL1.has(l1)) l3sByL1.set(l1, new Set());
    const l3 = str(a?.l3);
    if (l3) l3sByL1.get(l1).add(l3);
  }

  const errors = [];
  const valid = [];
  const seenL1 = new Map();

  flows.forEach((raw, fi) => {
    const before = errors.length;
    const flow = checkFlow(raw, fi, l3sByL1, seenL1, errors);
    if (flow && errors.length === before) valid.push(flow);
  });

  return { flows: valid, errors };
}

function checkFlow(raw, fi, l3sByL1, seenL1, errors) {
  const l1 = str(raw?.l1);
  const at = `${FILE} flows[${fi}]${l1 ? ` (${q(l1)})` : ""}`;
  const err = (msg, where = "") => errors.push(`${at}${where ? ` ${where}` : ""}: ${msg}`);

  if (!isObj(raw)) {
    err(`must be an object.`);
    return null;
  }

  // l1 — names a phase the activities use, once across all flows.
  let l1Known = false;
  if (!l1) err(`"l1" is required (the L1 phase this flow sequences).`);
  else if (!l3sByL1.has(l1)) err(`"l1" ${q(l1)} is not the l1 of any activity.`);
  else l1Known = true;
  if (l1) {
    if (seenL1.has(l1)) err(`"l1" ${q(l1)} already has a flow at flows[${seenL1.get(l1)}] — one flow per phase.`);
    else seenL1.set(l1, fi);
  }

  // lanes — non-empty, non-blank, unique.
  const lanes = [];
  if (!Array.isArray(raw.lanes) || raw.lanes.length === 0) {
    err(`"lanes" must be a non-empty array of actor names.`);
  } else {
    raw.lanes.forEach((v, li) => {
      const lane = str(v);
      if (!lane) err(`must be a non-empty string.`, `lanes[${li}]`);
      else if (lanes.includes(lane)) err(`duplicate lane ${q(lane)}.`, `lanes[${li}]`);
      else lanes.push(lane);
    });
  }

  // nodes
  const nodes = [];
  const nodeAt = new Map(); // node -> its location in the RAW array, for errors
  const ids = new Set();
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    err(`"nodes" must be a non-empty array.`);
  } else {
    raw.nodes.forEach((n, ni) => {
      const id = str(n?.id);
      const nat = `nodes[${ni}]${id ? ` (${q(id)})` : ""}`;
      const nerr = (msg) => err(msg, nat);
      if (!isObj(n)) return nerr(`must be an object.`);

      if (!id) nerr(`"id" is required.`);
      else if (ids.has(id)) nerr(`duplicate id ${q(id)}.`);
      else ids.add(id);

      const type = str(n.type).toLowerCase();
      if (!TYPES.includes(type)) nerr(`"type" must be one of ${TYPES.join(" | ")}, got ${q(n.type ?? null)}.`);

      const lane = str(n.lane);
      if (!lane) nerr(`"lane" is required.`);
      else if (lanes.length && !lanes.includes(lane)) nerr(`lane ${q(lane)} is not in lanes.`);

      const label = str(n.label);
      if (!label) nerr(`"label" is required.`);
      else if (label.length > MAX.label) nerr(`"label" is ${label.length} chars; the limit is ${MAX.label}.`);

      const node = { id, type, lane, label };

      const activity = str(n.activity);
      if (activity) {
        if (l1Known && !l3sByL1.get(l1).has(activity)) {
          nerr(`"activity" ${q(activity)} is not the l3 of any activity in ${q(l1)}.`);
        }
        node.activity = activity;
      }
      for (const key of ["pain", "sla"]) {
        const v = str(n[key]);
        if (!v) continue;
        if (v.length > MAX[key]) nerr(`"${key}" is ${v.length} chars; the limit is ${MAX[key]}.`);
        node[key] = v;
      }

      const outcomeRaw = str(n.outcome).toLowerCase();
      if (outcomeRaw && !OUTCOMES.includes(outcomeRaw)) nerr(`"outcome" must be good | bad, got ${q(n.outcome)}.`);
      if (type === "end") node.outcome = outcomeRaw || "good";

      nodes.push(node);
      nodeAt.set(node, nat);
    });

    const starts = nodes.filter((n) => n.type === "start");
    if (starts.length !== 1) err(`must have exactly one "start" node, found ${starts.length}.`);
    if (!nodes.some((n) => n.type === "end")) err(`must have at least one "end" node.`);
  }

  // edges
  const edges = [];
  const byId = new Map(nodes.filter((n) => n.id).map((n) => [n.id, n]));
  const pairs = new Set();
  if (!Array.isArray(raw.edges)) {
    err(`"edges" must be an array.`);
  } else {
    raw.edges.forEach((e, ei) => {
      const from = str(e?.from), to = str(e?.to);
      const eat = `edges[${ei}]${from || to ? ` (${q(from)} → ${q(to)})` : ""}`;
      const eerr = (msg) => err(msg, eat);
      if (!isObj(e)) return eerr(`must be an object.`);

      let ok = true;
      for (const [key, id] of [["from", from], ["to", to]]) {
        if (!id) { eerr(`"${key}" is required.`); ok = false; }
        else if (!byId.has(id)) { eerr(`"${key}" ${q(id)} is not a node id.`); ok = false; }
      }
      const edge = { from, to };
      const label = str(e.label);
      if (label) {
        if (label.length > MAX.edgeLabel) eerr(`"label" is ${label.length} chars; the limit is ${MAX.edgeLabel}.`);
        edge.label = label;
      }
      if (!ok) return;

      const pair = `${from}\u0000${to}`;
      if (pairs.has(pair)) return eerr(`duplicate edge.`);
      pairs.add(pair);

      if (byId.get(from).type === "end") eerr(`"from" ${q(from)} is an "end" node, which takes no outgoing edges.`);
      if (byId.get(to).type === "start") eerr(`"to" ${q(to)} is the "start" node, which takes no incoming edges.`);
      edges.push(edge);
    });
  }

  // Gateways branch: two or more ways out.
  for (const n of nodes) {
    if (n.type !== "gateway" || !n.id) continue;
    const out = edges.filter((e) => e.from === n.id).length;
    if (out < 2) err(`a gateway needs 2 or more outgoing edges, has ${out}.`, nodeAt.get(n));
  }

  // Every node reachable from the start. Loops are fine — BFS stops at seen nodes.
  const starts = nodes.filter((n) => n.type === "start" && n.id);
  if (starts.length) {
    const seen = new Set(starts.map((n) => n.id));
    const queue = [...seen];
    while (queue.length) {
      const cur = queue.shift();
      for (const e of edges) if (e.from === cur && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
    for (const n of nodes) if (n.id && !seen.has(n.id)) err(`not reachable from the start.`, nodeAt.get(n));
  }

  return { l1, lanes, nodes, edges };
}
