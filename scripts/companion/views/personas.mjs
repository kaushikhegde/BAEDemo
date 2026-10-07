// Personas tab: an overview of every persona, and one journey map per persona.
//
// Two sub-views under one panel, routed as #/personas/overview and
// #/personas/journeys/<journey id>. Every persona's "full profile" is a native
// <dialog> rendered here, so nothing about a persona is built in the browser.

import { html, raw, initials, plural } from "../html.mjs";
import { readableOn } from "../../lib/colour.mjs";
import { renderJourney } from "./journey.mjs";

// Must match PALETTE in scripts/validate-experience.mjs.
const COLOURS = {
  "bg-blue-900": "#1e3a8a", "bg-amber-500": "#f59e0b", "bg-teal-600": "#0d9488", "bg-sky-400": "#38bdf8",
  "bg-rose-600": "#e11d48", "bg-violet-700": "#6d28d9", "bg-emerald-600": "#059669",
};
export const personaColour = (p) => COLOURS[p?.avatarColor] || "#464e7e";

const NUMWORD = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

export function avatar(p, images, size = "") {
  const colour = personaColour(p);
  const pic = images?.[p?.id]?.avatar;
  if (pic) {
    return html`<span class="avatar ${size}" style="--pc:${colour}" aria-hidden="true"><img src="${raw(pic)}" alt=""/></span>`;
  }
  return html`<span class="avatar ${size}" style="--pc:${colour};--pcfg:${readableOn(colour)}" aria-hidden="true">${initials(p?.name)}</span>`;
}

function list(items, empty) {
  return items.length ? html`<ul>${items.map((t) => html`<li>${t}</li>`)}</ul>` : html`<p class="quiet">${empty}</p>`;
}

function personaCard(p, journey, images) {
  return html`
  <article class="pcard card">
    <header class="pcard-h">
      ${avatar(p, images, "avatar-lg")}
      <div class="pcard-who">
        <h3>${p.name || p.id}</h3>
        ${p.role && html`<div class="pcard-role">${p.role}</div>`}
      </div>
    </header>
    ${p.context && html`<p class="pcard-ctx">${p.context}</p>`}
    <div class="tt">
      <section class="tt-col tt-today"><h4><i aria-hidden="true"></i>Today</h4>${list(p.today || [], "Not recorded.")}</section>
      <section class="tt-col tt-tmrw"><h4><i aria-hidden="true"></i>Tomorrow</h4>${list(p.tomorrow || [], "Not recorded.")}</section>
    </div>
    <footer class="pcard-f">
      ${p.keyBenefit && html`<div class="benefit"><span class="eyebrow-sm">Key benefit</span><p>${p.keyBenefit}</p></div>`}
      <div class="pcard-actions">
        <button class="btn" type="button" data-dialog="dlg-${p.id}" aria-haspopup="dialog">Full profile</button>
        ${journey && html`<a class="btn btn-primary" href="#/personas/journeys/${journey.id}">View journey <span aria-hidden="true">→</span></a>`}
      </div>
    </footer>
  </article>`;
}

function personaDialog(p, journey, images) {
  return html`
  <dialog class="dlg" id="dlg-${p.id}" aria-labelledby="dlg-${p.id}-t">
    <header class="dlg-h">
      ${avatar(p, images, "avatar-lg")}
      <div><h2 id="dlg-${p.id}-t">${p.name || p.id}</h2>${p.role && html`<div class="pcard-role">${p.role}</div>`}</div>
      <button class="icon-btn" type="button" data-close aria-label="Close">×</button>
    </header>
    <div class="dlg-b">
      ${p.context && html`<p>${p.context}</p>`}
      <div class="tt">
        <section class="tt-col tt-today"><h4><i aria-hidden="true"></i>Today</h4>${list(p.today || [], "Not recorded.")}</section>
        <section class="tt-col tt-tmrw"><h4><i aria-hidden="true"></i>Tomorrow</h4>${list(p.tomorrow || [], "Not recorded.")}</section>
      </div>
      ${p.keyBenefit && html`<div class="benefit"><span class="eyebrow-sm">Key benefit</span><p>${p.keyBenefit}</p></div>`}
      ${p.journeySummary && html`<div class="benefit"><span class="eyebrow-sm">Journey in brief</span><p>${p.journeySummary}</p></div>`}
    </div>
    ${journey && html`<footer class="dlg-f"><a class="btn btn-primary" href="#/personas/journeys/${journey.id}" data-close>Open ${journey.title || "journey"} <span aria-hidden="true">→</span></a></footer>`}
  </dialog>`;
}

/**
 * @returns {{ html: Markup, defaults: Record<string,string> }}
 */
export function renderPersonasPanel({ personas, journeys, images }) {
  const journeyOf = (pid) => journeys.find((j) => j.personaId === pid) || null;
  const personaOf = (id) => personas.find((p) => p.id === id) || null;
  const defaults = { personas: "overview" };
  if (journeys.length) defaults["personas/journeys"] = journeys[0].id;

  const overview = html`
    <div data-show="personas/overview">
      <div class="sec-head">
        <div class="eyebrow">Who we serve</div>
        <h2 class="h2">${NUMWORD[personas.length] || personas.length} ${personas.length === 1 ? "representative participant" : "representative participants"}</h2>
        <p class="lede">Each persona stands for a group of people with similar work and similar frustrations, not for one individual.</p>
      </div>
      ${personas.length
        ? html`<div class="pgrid">${personas.map((p) => personaCard(p, journeyOf(p.id), images))}</div>`
        : html`<div class="empty">No personas generated for this project yet.</div>`}
      ${personas.map((p) => personaDialog(p, journeyOf(p.id), images))}
    </div>`;

  const picker = journeys.length > 1 && html`
    <nav class="jpick" aria-label="Choose a journey">
      ${journeys.map((j) => {
        const p = personaOf(j.personaId);
        return html`<a class="jpick-i" href="#/personas/journeys/${j.id}" data-link="personas/journeys/${j.id}">
          ${p ? avatar(p, images) : ""}
          <span><b>${p?.name || j.title || j.id}</b><small>${(p?.role || "").split(" — ")[0]}</small></span>
        </a>`;
      })}
    </nav>`;

  const journeysView = html`
    <div data-show="personas/journeys">
      <div class="sec-head">
        <div class="eyebrow">Persona journeys</div>
        <h2 class="h2">Today vs tomorrow, step by step</h2>
        <p class="lede">How each persona's experience changes across the lifecycle — what they do, think and feel, where it hurts today, and what changes.</p>
      </div>
      ${picker}
      ${journeys.length
        ? journeys.map((j) => renderJourney(j, personaOf(j.personaId), images))
        : html`<div class="empty">No journeys generated for this project yet.</div>`}
    </div>`;

  const sub = html`
    <nav class="subtabs" aria-label="Personas views">
      <a href="#/personas/overview" data-link="personas/overview">Overview <span class="count">${personas.length}</span></a>
      <a href="#/personas/journeys" data-link="personas/journeys">Journeys <span class="count">${journeys.length}</span></a>
    </nav>`;

  return { html: html`${sub}${overview}${journeysView}`, defaults, label: plural(personas.length, "persona") };
}
