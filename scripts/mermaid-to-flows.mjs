#!/usr/bin/env node
// Build process-model.json's `flows` (the companion app's swimlanes) from the
// Mermaid diagrams in capability-process.md §5 — mechanically, in seconds.
//
//   node scripts/mermaid-to-flows.mjs <project> [--dry-run]
//
// Why a script: asked to write `flows` by hand for six phases, the capability
// agent spent its whole output budget (128k tokens, four "output token limit
// hit" restarts) planning one enormous JSON write and saved nothing. §5 already
// holds every step, decision and branch, with the role as a prefix on each task
// ("SOO: verify ABN"), so the translation is deterministic and belongs in code.
// The agent then adds only what needs judgement — `pain`, from the documents —
// as small edits.
//
// Conventions read from §5 (see the skill's Section 5 guidance):
//   ### <L1 phase name>           one heading per phase, matching activities[].l1
//   A[Role: task label<br/>SLA]   a task; the role picks the lane
//   B{Decision?}                  a gateway, in the lane of the step before it
//   A -- Yes --> B, A -->|Yes| B  labelled edges; `&` fans in or out
// A start event is added before each entry node and an end event after each
// final node; an end whose label reads as a stop (hold, reject, …) is "bad".
// Existing `pain` / `sla` on a task with the same id are carried over, so a
// re-run after the agent's edits does not throw that judgement away.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORK_ROOT } from "./lib/roots.mjs";
import { validateFlows } from "./lib/flows.mjs";

const SYSTEM_RE = /^(oracle|system|isupplier|sap|teamcenter|workflow|portal)\b|_wf\b/i;
const STOP_RE = /\b(hold|reject|declin|cannot|not proceed|cancel|fail|terminat|exclud|stop)/i;
const SLA_RE = /\d/;
const SLA_WORD_RE = /\b(day|days|bd|hour|hours|week|weeks|month|months|minute|minutes|target|within|sla)\b/i;

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const norm = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, "").replace(/accounts payable/g, "ap")
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().replace(/s$/, "");

/** "SOO" / "AP Officer" / "Oracle AME" → the activity actor string it names. */
export function laneFor(prefix, actors) {
  const p = String(prefix).split("/")[0].trim();
  if (!p) return null;
  const system = actors.find((a) => /^system$/i.test(a));
  if (SYSTEM_RE.test(p)) return system || "System";
  const abbr = actors.find((a) => (/\(([^)]+)\)\s*$/.exec(a) || [])[1]?.toLowerCase() === p.toLowerCase());
  if (abbr) return abbr;
  const np = norm(p);
  const exact = actors.find((a) => norm(a) === np);
  if (exact) return exact;
  // A prefix match only when it is unambiguous: "Supplier" starts both
  // "Supplier Onboarding Officer" and "Supplier Representative", and picking
  // either would put the supplier's own steps in the wrong lane.
  const near = actors.filter((a) => norm(a).startsWith(np) || np.startsWith(norm(a)));
  if (near.length === 1) return near[0];
  return p.replace(/s$/, "") === p ? p : p.replace(/s$/, "");
}

/** One Mermaid flowchart → { nodes: Map(id → {kind,text}), edges: [{from,to,label}] }. */
export function parseMermaid(src) {
  const nodes = new Map();
  const edges = [];
  const SHAPE = /^([A-Za-z0-9_]+)\s*(\[\[.*?\]\]|\[\(.*?\)\]|\(\[.*?\]\)|\(\(.*?\)\)|\{\{.*?\}\}|\[.*?\]|\{.*?\}|\(.*?\)|>.*?\])?/;
  const define = (tok) => {
    const m = SHAPE.exec(tok.trim());
    if (!m) return null;
    const [, id, shape] = m;
    if (shape) {
      const kind = shape.startsWith("{") ? "gateway" : "task";
      const text = shape.replace(/^[[({>]+|[\])}]+$/g, "").replace(/^"|"$/g, "").trim();
      nodes.set(id, { kind, text });
    } else if (!nodes.has(id)) nodes.set(id, { kind: "task", text: id });
    return id;
  };
  const ARROW = /\s*(?:--\s*([^->|][^>]*?)\s*-->|-->\s*\|([^|]*)\||-\.->|==>|-->|---)\s*/g;
  for (const raw of String(src).split("\n")) {
    const line = raw.replace(/%%.*$/, "").trim();
    if (!line || /^(flowchart|graph|classDef|class |style |linkStyle|subgraph|end$|direction)/i.test(line)) continue;
    const parts = []; const labels = [];
    let last = 0; let m;
    ARROW.lastIndex = 0;
    while ((m = ARROW.exec(line))) {
      parts.push(line.slice(last, m.index)); labels.push((m[1] || m[2] || "").trim());
      last = ARROW.lastIndex;
    }
    parts.push(line.slice(last));
    const groups = parts.map((p) => p.split(/\s*&\s*/).map(define).filter(Boolean));
    for (let i = 0; i < labels.length; i++) {
      for (const a of groups[i]) for (const b of groups[i + 1]) edges.push({ from: a, to: b, label: labels[i] || undefined });
    }
  }
  return { nodes, edges };
}

/** §5 → [{ l1, src }], one per `### <phase>` heading followed by a mermaid block. */
export function section5Flows(md) {
  const s5 = /^##\s*5\.?\s+Process Flow[^\n]*\n([\s\S]*?)(?=^##\s+\d|(?![\s\S]))/m.exec(md);
  if (!s5) return [];
  const out = [];
  const re = /^###\s+(.+?)\s*\n[\s\S]*?```mermaid\n([\s\S]*?)```/gm;
  let m;
  while ((m = re.exec(s5[1]))) out.push({ l1: m[1].trim(), src: m[2] });
  return out;
}

const words = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2));
function bestActivity(label, acts) {
  const lw = words(label);
  let best = null, score = 0;
  for (const a of acts) {
    const aw = words(a.l3);
    const inter = [...lw].filter((w) => aw.has(w)).length;
    const s = inter / Math.max(1, Math.min(lw.size, aw.size));
    if (s > score) { score = s; best = a; }
  }
  return score >= 0.5 ? best.l3 : undefined;
}

/** One phase's Mermaid → a flow object in the `flows` contract. */
export function toFlow(l1, src, activities, previous) {
  const { nodes, edges } = parseMermaid(src);
  const acts = activities.filter((a) => a.l1 === l1);
  const actors = [...new Set(activities.map((a) => a.actor).filter(Boolean))];
  const prev = new Map((previous?.nodes || []).map((n) => [n.id, n]));
  const incoming = (id) => edges.filter((e) => e.to === id);
  const outgoing = (id) => edges.filter((e) => e.from === id);

  const out = new Map();
  for (const [id, n] of nodes) {
    const [head, ...rest] = n.text.split(/<br\s*\/?>/i).map((t) => t.trim()).filter(Boolean);
    const role = n.kind === "task" ? /^([^:]{1,40}):\s*(.+)$/.exec(head || "") : null;
    let label = role ? role[2] : head || id;
    const extra = rest.filter((t) => !(SLA_RE.test(t) && SLA_WORD_RE.test(t)));
    const sla = rest.filter((t) => SLA_RE.test(t) && SLA_WORD_RE.test(t)).join(" · ");
    if (extra.length) label += ` — ${extra.join("; ")}`;
    label = label.charAt(0).toUpperCase() + label.slice(1);
    const kind = n.kind === "gateway" && outgoing(id).length < 2 ? "task" : n.kind;
    const node = { id, type: kind, lane: role ? laneFor(role[1], actors) : null, label: clip(label, 80) };
    if (kind === "task") {
      const activity = bestActivity(`${label}`, acts);
      if (activity) node.activity = activity;
      if (sla) node.sla = clip(sla, 60);
      const was = prev.get(id);
      if (was?.pain) node.pain = was.pain;
      if (!node.sla && was?.sla) node.sla = was.sla;
    }
    out.set(id, node);
  }

  // A step with no role (a decision, an unprefixed task) sits in the lane of
  // the step that leads into it; failing that, the step it leads to.
  for (let pass = 0; pass < 4; pass++) {
    for (const n of out.values()) {
      if (n.lane) continue;
      const from = incoming(n.id).map((e) => out.get(e.from)?.lane).find(Boolean);
      const to = outgoing(n.id).map((e) => out.get(e.to)?.lane).find(Boolean);
      n.lane = from || (pass > 0 ? to : null);
    }
  }
  const fallback = actors[0] || "Team";
  for (const n of out.values()) if (!n.lane) n.lane = fallback;

  const flowNodes = [...out.values()];
  const flowEdges = edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: clip(e.label, 24) } : {}) }));
  const entries = flowNodes.filter((n) => !incoming(n.id).length);
  const exits = flowNodes.filter((n) => !outgoing(n.id).length);
  entries.forEach((n, i) => {
    const id = `start${i ? i + 1 : ""}`;
    flowNodes.unshift({ id, type: "start", lane: n.lane, label: "Start" });
    flowEdges.unshift({ from: id, to: n.id });
  });
  // Exactly one start: extra entry points hang off the first.
  if (entries.length > 1) {
    for (let i = 1; i < entries.length; i++) {
      const id = `start${i + 1}`;
      flowNodes.splice(flowNodes.findIndex((n) => n.id === id), 1);
      const e = flowEdges.find((x) => x.from === id); e.from = "start";
    }
  }
  exits.forEach((n, i) => {
    const bad = STOP_RE.test(n.label);
    const id = `end${i + 1}`;
    flowNodes.push({ id, type: "end", lane: n.lane, label: bad ? "Stopped" : "Done", outcome: bad ? "bad" : "good" });
    flowEdges.push({ from: n.id, to: id });
  });

  // Lanes in order of first appearance, walking from the start.
  const lanes = [];
  const seen = new Set(); const queue = ["start"];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue; seen.add(id);
    const n = flowNodes.find((x) => x.id === id);
    if (n && !lanes.includes(n.lane)) lanes.push(n.lane);
    flowEdges.filter((e) => e.from === id).forEach((e) => queue.push(e.to));
  }
  for (const n of flowNodes) if (!lanes.includes(n.lane)) lanes.push(n.lane);

  return { l1, lanes, nodes: flowNodes, edges: flowEdges };
}

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry-run");
  const [project] = argv.filter((a) => !a.startsWith("--"));
  if (!project) { console.error("Usage: node scripts/mermaid-to-flows.mjs <project> [--dry-run]"); process.exit(1); }
  const out = path.join(WORK_ROOT, "projects", project, "solutions", "Capabilities", "outputs");
  const pmPath = path.join(out, "process-model.json");
  const pm = JSON.parse(await fs.readFile(pmPath, "utf8"));
  const md = await fs.readFile(path.join(out, "capability-process.md"), "utf8");
  const activities = Array.isArray(pm.activities) ? pm.activities : [];
  const phases = new Set(activities.map((a) => a.l1));
  const previous = new Map((pm.flows || []).map((f) => [f.l1, f]));

  const flows = [];
  for (const { l1, src } of section5Flows(md)) {
    const phase = [...phases].find((p) => p.toLowerCase() === l1.toLowerCase());
    if (!phase) { console.warn(`[mermaid-to-flows] skipped "${l1}" — no activities have that l1`); continue; }
    flows.push(toFlow(phase, src, activities, previous.get(phase)));
  }
  const { flows: valid, errors } = validateFlows(flows, activities);
  for (const f of flows) {
    const tasks = f.nodes.filter((n) => n.type === "task");
    console.log(`  ${f.l1}: ${f.lanes.length} lanes, ${tasks.length} tasks (${tasks.filter((n) => n.activity).length} linked to an activity), ${f.nodes.filter((n) => n.type === "gateway").length} decisions`);
  }
  if (errors.length) {
    console.error(`[mermaid-to-flows] ${errors.length} problem(s):\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  if (!flows.length) { console.error("[mermaid-to-flows] no `### <phase>` + mermaid blocks found in §5"); process.exit(1); }
  if (dry) { console.log(JSON.stringify(valid, null, 2)); return; }
  pm.flows = valid;
  await fs.writeFile(pmPath, JSON.stringify(pm, null, 2) + "\n", "utf8");
  console.log(`[mermaid-to-flows] wrote ${valid.length} flow(s) to ${path.relative(WORK_ROOT, pmPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[mermaid-to-flows] ${e.stack || e}`); process.exit(1); });
}
