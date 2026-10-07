// Feature tabs (Product Summary, Stories, UI, Data Model, …): a grid of
// feature cards, and one view per feature, routed #/<tab>/<feature slug>.
//
// A feature that has NOT run the stage still gets a card, muted — a visible
// gap is more useful than a silently short list.

import { html, raw, slug, plural } from "../html.mjs";

function storyCard(s) {
  return html`
  <article class="story card">
    <h3 class="story-h">${s.summary || "(untitled story)"}</h3>
    ${s.narrative && html`<p>${s.narrative}</p>`}
    ${(s.userGroup || s.process) && html`<dl class="story-meta">
      ${s.userGroup && html`<dt>User group</dt><dd>${s.userGroup}</dd>`}
      ${s.process && html`<dt>Process</dt><dd>${s.process}</dd>`}
    </dl>`}
    ${(s.acceptanceCriteria || []).length > 0 && html`<h4 class="eyebrow-sm">Acceptance criteria</h4><ul class="ac">${s.acceptanceCriteria.map((a) => html`<li>${a}</li>`)}</ul>`}
    ${(s.labels || []).length > 0 && html`<div class="chips">${s.labels.map((l) => html`<span class="chip">${l}</span>`)}</div>`}
  </article>`;
}

function screens(row) {
  return html`<div class="rows">${row.screens.map((sc) => html`
    <a class="row-link" href="${sc.href}">
      <span class="idn">${sc.id}</span>
      <span class="row-mid"><b>${sc.name}</b><small>${[sc.persona, sc.surface, plural(sc.states, "state"), sc.stories.length ? `stories ${sc.stories.join(", ")}` : ""].filter(Boolean).join(" · ")}</small></span>
      <span class="go" aria-hidden="true">→</span>
    </a>`)}</div>`;
}

function docs(row, tabId) {
  return row.docs.map((d, i) => html`
    ${row.docs.length > 1 && html`<h3 class="coll-h" id="${tabId}-${slug(row.feature)}-${i}">${d.id && d.id !== row.feature ? `${d.id} · ` : ""}${d.title}</h3>`}
    <div class="doc">${raw(d.html || "")}</div>`);
}

/**
 * @param t    tab meta: {id,label,eyebrow,noun}
 * @param rows one per feature: {feature, has, stat, ps, docs, stories, screens, mockupIndex, missing}
 */
export function renderFeaturePanel(t, rows) {
  const live = rows.filter((r) => r.has);
  const defaults = { [t.id]: live.length === 1 && rows.length === 1 ? slug(live[0].feature) : "list" };

  const list = html`
  <div data-show="${t.id}/list">
    <div class="sec-head">
      <div class="eyebrow">${t.eyebrow}</div>
      <h2 class="h2">${t.label}</h2>
      <p class="lede">${rows.length === 1 ? "One feature." : `${live.length} of ${rows.length} features ${live.length === 1 ? "has" : "have"} ${t.noun}. Open one to read it.`}</p>
    </div>
    <div class="feat-grid">
      ${rows.map((r) => r.has
        ? html`<a class="feat-card card" href="#/${t.id}/${slug(r.feature)}">
            <span class="fc-name">${r.feature}</span>
            ${r.ps && t.id !== "summary" && html`<span class="fc-ps"><span class="eyebrow-sm">Product Summary</span>${r.ps}</span>`}
            <span class="fc-stat">${r.stat}</span>
            <span class="go">Open <span aria-hidden="true">→</span></span>
          </a>`
        : html`<div class="feat-card card is-empty" aria-disabled="true"><span class="fc-name">${r.feature}</span><span class="fc-stat">Not generated</span></div>`)}
    </div>
  </div>`;

  const details = live.map((r) => html`
  <div data-show="${t.id}/${slug(r.feature)}">
    ${rows.length > 1 && html`<nav class="crumbs" aria-label="Breadcrumb"><a href="#/${t.id}/list">${t.label}</a><span aria-hidden="true">/</span><span aria-current="page">${r.feature}</span></nav>`}
    <header class="feat-head">
      <div class="eyebrow">${t.eyebrow}</div>
      <h2 class="h2">${r.feature}</h2>
      ${r.ps && t.id !== "summary" && html`<p class="quiet">Product Summary · ${r.ps}</p>`}
      <p class="quiet">${r.stat}</p>
      ${(r.missing || []).length > 0 && html`<p class="warn-note">Designed before ${r.missing.map((m) => (m === "DataModel" ? "the data model" : "the test pack")).join(" and ")} existed — field names and states are provisional.</p>`}
      ${r.mockupIndex && html`<p><a class="btn btn-primary" href="${r.mockupIndex}">Open all screens <span aria-hidden="true">→</span></a></p>`}
    </header>
    ${r.screens.length ? screens(r) : r.stories.length ? html`<div class="stories">${r.stories.map(storyCard)}</div>` : docs(r, t.id)}
  </div>`);

  return { html: html`${list}${details}`, defaults };
}
