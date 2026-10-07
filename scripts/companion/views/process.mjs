// Process tab: phase cards, and per phase a swimlane plus its step cards.
//
// Routed as #/process (the phase grid) and #/process/<phase slug>. The
// swimlane is drawn at build time by swimlane.mjs from `flows` in
// process-model.json; a phase without a flow shows its cards only. Clicking a
// task in the swimlane highlights the activity it names in the cards below.

import { html, raw, slug, plural } from "../html.mjs";
import { renderSwimlane } from "../swimlane.mjs";

// Phase icons are keyword-matched from the phase name, so any client's
// lifecycle gets a sensible icon without hard-coding their phase names.
const ICON_RULES = [
  [/lodge|intake|submit|discover|receiv|requisit|request/i, "M20 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6M12 3v12m0 0l-4-4m4 4l4-4"],
  [/onboard|supplier|vetting|registr|classif|rout/i, "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"],
  [/sourc|tender|assess|review|analys|determin|screen/i, "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4"],
  [/invoice|commercial|licen|fee|financ|billing|payment/i, "M3 10h18M7 15h4M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"],
  [/order|notif|clearance|works|schedul|coordinat/i, "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 14l2 2 4-4"],
  [/goods|receipt|deliver|lifecycle|manage|maintain|install/i, "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7L12 12l8.7-5M12 22V12"],
  [/decommission|closure|clos|exit|remov|terminat/i, "M9 12l2 2 4-4M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"],
];
const DEFAULT_ICON = "M4 6h16M4 12h16M4 18h10";
const icon = (name) => {
  const d = (ICON_RULES.find(([re]) => re.test(name)) || [null, DEFAULT_ICON])[1];
  return raw(`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`);
};

/** Activities grouped phase → step, keeping the model's lifecycle order. */
export function phasesOf(activities) {
  const phases = [];
  const byName = new Map();
  for (const a of activities) {
    let p = byName.get(a.l1);
    if (!p) { p = { name: a.l1, slug: slug(a.l1), steps: [], stepBy: new Map(), activities: [] }; byName.set(a.l1, p); phases.push(p); }
    let s = p.stepBy.get(a.l2);
    if (!s) { s = { name: a.l2, activities: [] }; p.stepBy.set(a.l2, s); p.steps.push(s); }
    s.activities.push(a);
    p.activities.push(a);
  }
  return phases;
}

const actorsOf = (acts) => [...new Set(acts.map((a) => a.actor).filter(Boolean))];

function activityRow(a) {
  const tier = a.serviceTier && a.serviceTier !== "All" ? a.serviceTier : "";
  return html`
    <li class="act" data-activity-row="${a.l3}">
      <span class="act-t">${a.l3}</span>
      ${a.description && html`<span class="act-d">${a.description}</span>`}
      <span class="act-m">
        ${a.actor && html`<span class="chip chip-ink">${a.actor}</span>`}
        ${tier && html`<span class="chip chip-warn" title="Applies to">${tier}</span>`}
        ${(a.components || []).map((c) => html`<span class="chip">${c}</span>`)}
        ${(a.capabilityIds || []).map((id) => html`<button type="button" class="chip chip-link" data-cap="${id}" title="Open capability ${id}">${id}</button>`)}
      </span>
    </li>`;
}

function phaseView(p, i, flow) {
  let lane = null;
  if (flow) {
    try {
      const sl = renderSwimlane(flow, { idPrefix: `sl-${p.slug}` });
      lane = html`
      <section class="swim card" aria-labelledby="sw-${p.slug}-h">
        <header class="swim-h">
          <div>
            <h3 class="h3" id="sw-${p.slug}-h">Process flow</h3>
            <p class="quiet">Current state · ${plural(flow.lanes.length, "role")} · ${plural(flow.nodes.filter((n) => n.type === "task").length, "task")} · ${plural(flow.nodes.filter((n) => n.type === "gateway").length, "decision")}</p>
          </div>
          <div class="swim-key" aria-hidden="true">
            <span><i class="k-pain">!</i>Pain point</span>
            <span><i class="k-sys"></i>System step</span>
            <span><i class="k-gw"></i>Decision</span>
            <span><i class="k-end-good"></i>Outcome</span>
          </div>
          <button type="button" class="btn btn-quiet" data-fit aria-pressed="false">Fit to width</button>
        </header>
        <div class="swim-scroll" tabindex="0" role="region" aria-label="${p.name} swimlane, scrolls sideways">${raw(sl.svg)}</div>
        <p class="swim-tip quiet">Select a task to find it in the steps below.</p>
      </section>`;
    } catch (e) {
      console.warn(`[render-companion-app] WARN swimlane for "${p.name}" not drawn — ${e.message}`);
    }
  }
  const roles = actorsOf(p.activities);
  return html`
  <div data-show="process/${p.slug}" class="phase-view">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/process">Process</a><span aria-hidden="true">/</span><span aria-current="page">${p.name}</span></nav>
    <header class="phase-head">
      <span class="phase-ico">${icon(p.name)}</span>
      <div>
        <div class="eyebrow">Phase ${String(i + 1).padStart(2, "0")}</div>
        <h2 class="h2">${p.name}</h2>
        <p class="lede">${plural(p.steps.length, "step")} · ${plural(p.activities.length, "activity", "activities")} · ${plural(roles.length, "role")}</p>
      </div>
    </header>
    ${lane}
    <h3 class="h3 steps-h">Steps and activities</h3>
    <div class="steps">
      ${p.steps.map((s, si) => html`
        <article class="step card">
          <header class="step-h"><span class="step-n">${si + 1}</span><h4>${s.name}</h4><span class="count">${s.activities.length}</span></header>
          <ol class="acts">${s.activities.map(activityRow)}</ol>
        </article>`)}
    </div>
  </div>`;
}

export function renderProcessPanel({ activities, flows }) {
  const phases = phasesOf(activities);
  const flowOf = new Map((flows || []).map((f) => [f.l1, f]));
  const withFlow = phases.filter((p) => flowOf.has(p.name)).length;

  const grid = html`
  <div data-show="process/phases">
    <div class="sec-head">
      <div class="eyebrow">Process model</div>
      <h2 class="h2">How the work flows today</h2>
      <p class="lede">${plural(phases.length, "lifecycle phase")}, ${plural(activities.length, "activity", "activities")}.${withFlow > 0 ? ` ${withFlow} with a swimlane.` : ""} Open a phase to see who does what, in order.</p>
    </div>
    <div class="phase-grid">
      ${phases.map((p, i) => html`
        <a class="phase-card card" href="#/process/${p.slug}">
          <span class="phase-top"><span class="phase-ico">${icon(p.name)}</span><span class="phase-n">${String(i + 1).padStart(2, "0")}</span></span>
          <span class="phase-t">${p.name}</span>
          <span class="phase-m">${plural(p.steps.length, "step")} · ${plural(p.activities.length, "activity", "activities")} · ${plural(actorsOf(p.activities).length, "role")}</span>
          <span class="phase-f">${flowOf.has(p.name) ? html`<span class="chip chip-ok">Swimlane</span>` : html`<span></span>`}<span class="go" aria-hidden="true">→</span></span>
        </a>`)}
    </div>
  </div>`;

  return {
    html: html`${grid}${phases.map((p, i) => phaseView(p, i, flowOf.get(p.name)))}`,
    defaults: { process: "phases" },
  };
}
