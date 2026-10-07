// Capabilities tab: L1 domain → L2 area card → L3 tile, with a maturity bar on
// every tile and a slide-over per capability.
//
// Filters DIM non-matching tiles rather than hiding them, so the shape of the
// map never changes under the reader. The slide-over content is rendered here
// into a <template> per capability; the browser only clones it.

import { html, slug, plural } from "../html.mjs";

export const MATURITY = ["None", "Foundational", "Operational", "Optimised", "Transformational"];

/**
 * "not assessed", never a question mark. An empty maturity is the skill
 * working correctly — it assesses leaves only, and where the documents say
 * nothing it leaves both empty rather than guess. A question mark made an
 * honest gap look like a broken page, and this is what a CLIENT is shown.
 */
export function maturity(c) {
  const cur = MATURITY.indexOf(c.currentMaturity), tgt = MATURITY.indexOf(c.targetMaturity);
  if (cur < 0 && tgt < 0) {
    return html`<span class="mat mat-none" title="The discovery documents did not say. Assessed capabilities show a maturity here.">Not assessed</span>`;
  }
  const segs = [1, 2, 3, 4].map((k) => {
    const cls = k <= cur ? "on" : k <= tgt ? "tgt" : "";
    return html`<i class="${cls}"></i>`;
  });
  return html`<span class="mat" aria-label="Maturity: ${c.currentMaturity || "not stated"}${tgt > cur ? `, target ${c.targetMaturity}` : ""}">
    <span class="mat-bar" aria-hidden="true">${segs}</span>
    <span class="mat-txt">${c.currentMaturity || "—"}${tgt > cur && html` <span class="mat-arrow" aria-hidden="true">→</span> <b>${c.targetMaturity}</b>`}</span>
  </span>`;
}

function detail(c, byId, caps, activities) {
  const chain = [];
  for (let cur = c, guard = 0; cur && guard < 12; guard++) { chain.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : null; }
  const children = caps.filter((x) => x.parentId === c.id);
  const realised = activities.filter((a) => (a.capabilityIds || []).includes(c.id));
  return html`
  <template data-cap-detail="${c.id}">
    <nav class="so-crumbs" aria-label="Capability path">
      ${chain.slice(0, -1).map((p, i) => html`${i > 0 && html`<span aria-hidden="true">›</span>`}<button type="button" class="link" data-cap="${p.id}">${p.id} ${p.name}</button>`)}
    </nav>
    <h2 class="so-title"><span class="idn">${c.id}</span> ${c.name || c.id}</h2>
    <div class="so-meta">${maturity(c)}${c.stage && html`<span class="chip">${c.stage}</span>`}${c.level && html`<span class="chip chip-quiet">L${c.level}</span>`}</div>
    ${c.description && html`<p class="so-desc">${c.description}</p>`}
    ${children.length > 0 && html`
      <h3 class="so-h">Child capabilities</h3>
      <div class="so-list">${children.map((k) => html`<button type="button" class="so-item" data-cap="${k.id}"><span class="idn">${k.id}</span><span>${k.name || k.id}</span></button>`)}</div>`}
    ${realised.length
      ? html`<h3 class="so-h">Realised by ${plural(realised.length, "process activity", "process activities")}</h3>
        <div class="so-list">${realised.map((a) => html`<a class="so-item" href="#/process/${slug(a.l1)}"><span>${a.l3}</span><small>${a.l1} › ${a.l2}${a.actor && ` · ${a.actor}`}</small></a>`)}</div>`
      : html`<h3 class="so-h">Process coverage</h3><p class="so-desc">No process activity references this capability — a coverage gap worth checking.</p>`}
  </template>`;
}

export function renderCapabilitiesPanel({ capabilities: caps, activities }) {
  const byId = new Map(caps.map((c) => [c.id, c]));
  const kids = new Map();
  for (const c of caps) {
    const k = c.parentId && byId.has(c.parentId) ? c.parentId : "__root";
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(c);
  }
  const roots = kids.get("__root") || [];
  const assessed = caps.filter((c) => c.currentMaturity).length;

  const tile = (leaf, root) => html`
    <button type="button" class="cap-tile" data-cap="${leaf.id}" data-root="${root.id}" aria-haspopup="dialog"
      data-hay="${[leaf.id, leaf.name, leaf.description, leaf.stage].join(" ").toLowerCase()}">
      <span class="cap-tile-h"><span class="idn">${leaf.id}</span><span class="cap-tile-t">${leaf.name || leaf.id}</span></span>
      ${maturity(leaf)}
    </button>`;

  const sections = roots.map((r) => {
    const areas = kids.get(r.id) || [];
    const leaves = areas.reduce((n, a) => n + ((kids.get(a.id) || []).length || 1), 0);
    return html`
    <section class="cap-sec card" data-root-sec="${r.id}">
      <header class="cap-sec-h">
        <span class="cap-sec-n">${r.id}</span>
        <div><h3>${r.name || r.id}</h3>${r.description && html`<p>${r.description}</p>`}</div>
        <span class="count">${plural(leaves, "capability", "capabilities")}</span>
      </header>
      <div class="cap-areas">
        ${areas.map((a) => html`
          <div class="cap-area">
            <h4 class="cap-area-h"><span class="idn">${a.id}</span> ${a.name || a.id}</h4>
            <div class="cap-tiles">${(kids.get(a.id) || [a]).map((leaf) => tile(leaf, r))}</div>
          </div>`)}
      </div>
    </section>`;
  });

  return {
    html: html`
    <div class="sec-head sec-head-row">
      <div>
        <div class="eyebrow">Business capability map</div>
        <h2 class="h2">What the organisation must be able to do</h2>
        <p class="lede">${plural(caps.length, "capability", "capabilities")} across ${plural(roots.length, "domain")}; ${assessed} assessed for maturity, today and target.</p>
      </div>
      <div class="mat-legend" aria-label="Maturity scale">
        <span class="mat-bar" aria-hidden="true"><i class="on"></i><i class="on"></i><i class="tgt"></i><i></i></span>
        <span><b>Filled</b> = today · <b>tinted</b> = target</span>
        <span class="quiet">${MATURITY.slice(1).join(" · ")}</span>
      </div>
    </div>
    <div class="cap-tools card">
      <label class="field"><span class="sr-only">Filter capabilities</span>
        <input type="search" id="capq" placeholder="Filter capabilities…" autocomplete="off"/></label>
      <div class="cap-domains" role="group" aria-label="Domains">
        ${roots.map((r) => html`<label class="chk"><input type="checkbox" value="${r.id}"/><span>${r.name || r.id}</span></label>`)}
      </div>
      <button type="button" class="btn btn-quiet" id="cap-clear">Clear</button>
    </div>
    ${caps.length ? sections : html`<div class="empty">No capability map generated for this project yet.</div>`}
    ${caps.map((c) => detail(c, byId, caps, activities))}`,
    defaults: {},
  };
}
