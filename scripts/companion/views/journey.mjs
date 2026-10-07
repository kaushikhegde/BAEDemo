// One persona journey as a STAGE GRID: stages across the top, then rows for
// what the persona does, thinks and feels, where it hurts and what changes.
//
// The client rejected the previous layout (a squeezed side column, "—" filler
// in every empty cell, columns clipped at the edge, a curve that was hard to
// read). Rules that came out of that:
//   - an empty cell is EMPTY — no dash, no "Not recorded";
//   - columns are a fixed width so the feeling curve, drawn as one SVG, lines
//     up with the step columns exactly, and the grid scrolls sideways with the
//     row labels pinned rather than squeezing;
//   - red marks what matters (moments that matter, the target line), it is not
//     the colour of every surface.

import { html, raw, esc } from "../html.mjs";
import { avatar } from "./personas.mjs";

export const COL_W = 184;   // step column width, px — keep in step with styles.css (--jg-col)
export const GAP = 10;      // column gap, px — keep in step with styles.css (--jg-gap)
const CURVE_H = 132;

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean);
const score = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : null;
};

/** Smooth path through points: horizontal tangents, so peaks never overshoot. */
function smooth(pts) {
  if (!pts.length) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  return d;
}

function feelingCurve(steps, id) {
  const n = steps.length;
  const W = n * COL_W + (n - 1) * GAP;
  const x = (i) => i * (COL_W + GAP) + COL_W / 2;
  const y = (s) => 30 + (5 - s) * 20;            // 5 → 30, 1 → 110
  const segs = (key) => {
    // A missing score breaks the line rather than inventing a value.
    const out = []; let cur = [];
    steps.forEach((st, i) => {
      const s = score(st[key]);
      if (s == null) { if (cur.length) out.push(cur); cur = []; } else cur.push([x(i), y(s)]);
    });
    if (cur.length) out.push(cur);
    return out;
  };
  const today = segs("todayScore"), target = segs("targetScore");
  if (!today.length && !target.length) return null;

  const grid = [1, 2, 3, 4, 5].map((s) => `<line x1="0" x2="${W}" y1="${y(s)}" y2="${y(s)}" class="jc-grid"/>`).join("");
  const lines =
    target.map((s) => `<path d="${smooth(s)}" class="jc-target"/>`).join("") +
    today.map((s) => `<path d="${smooth(s)}" class="jc-today"/>`).join("");
  const dots = steps.map((st, i) => {
    const s = score(st.todayScore);
    return s == null ? "" : `<circle cx="${x(i)}" cy="${y(s)}" r="5" class="jc-dot"><title>${esc(st.name)} — today ${s}/5${score(st.targetScore) ? `, tomorrow ${score(st.targetScore)}/5` : ""}</title></circle>`;
  }).join("");
  const words = steps.map((st, i) => st.feeling
    ? `<text x="${x(i)}" y="14" text-anchor="middle" class="jc-word">${esc(st.feeling)}</text>` : "").join("");
  return raw(`<svg class="jc" width="${W}" height="${CURVE_H}" viewBox="0 0 ${W} ${CURVE_H}" role="img" aria-labelledby="${id}-curve-t"><title id="${id}-curve-t">How it feels at each step, today versus tomorrow</title>${grid}${lines}${dots}${words}</svg>`);
}

export function renderJourney(j, persona, images) {
  const id = `j-${j.id}`;
  const stages = (j.stages || []).filter((s) => (s.steps || []).length);
  const steps = stages.flatMap((s) => s.steps);
  const moments = new Map((j.momentsThatMatter || []).map((m) => [m.stepId, m]));
  const role = persona?.role || "";
  const roleHead = role.split(" — ")[0].toLowerCase();
  const pic = images?.[persona?.id]?.journey;

  const head = html`
    <header class="jv-head">
      ${persona && avatar(persona, images, "avatar-lg")}
      <div class="jv-who">
        <h3>${j.title || "Journey"}</h3>
        <p class="jv-sub">${persona ? html`<b>${persona.name}</b> · ${role}` : ""}</p>
        ${j.scenario && html`<p class="jv-scn">${j.scenario}</p>`}
      </div>
      ${(j.metrics || []).length > 0 && html`
        <dl class="metrics">
          ${j.metrics.map((m) => html`<div class="metric"><dt>${m.name}</dt><dd><span class="m-today">${m.today}</span><span class="m-arrow" aria-hidden="true">→</span><span class="m-target">${m.target}</span></dd></div>`)}
        </dl>`}
    </header>`;

  if (pic) {
    return html`
    <section class="jv card" data-show="personas/journeys/${j.id}" aria-label="${j.title || "Journey"}">
      ${head}
      <button class="jv-img" type="button" data-dialog="lb-${j.id}" aria-haspopup="dialog" aria-label="Enlarge the journey diagram">
        <img src="${raw(pic)}" alt="${j.title || "Journey"} — journey diagram"/>
      </button>
      <dialog class="dlg dlg-img" id="lb-${j.id}" aria-label="${j.title || "Journey"} diagram">
        <button class="icon-btn" type="button" data-close aria-label="Close">×</button>
        <img src="${raw(pic)}" alt="${j.title || "Journey"} — journey diagram"/>
      </dialog>
    </section>`;
  }

  if (!steps.length) {
    return html`<section class="jv card" data-show="personas/journeys/${j.id}">${head}<div class="empty">This journey has no steps yet.</div></section>`;
  }

  const n = steps.length;
  const cell = (row, cls, body, i) => html`<div class="jg-cell ${cls}" style="grid-row:${row};grid-column:${i + 2}">${body}</div>`;
  let col = 0;
  const stageHeads = stages.map((s, si) => {
    const start = col + 2; col += s.steps.length;
    return html`<div class="jg-stage" style="grid-row:1;grid-column:${start} / span ${s.steps.length}">
      <span class="jg-stage-n">${si + 1}</span>
      <span class="jg-stage-t"><b>${s.name}</b>${s.l1Phase && html`<small>${s.l1Phase}</small>`}</span>
    </div>`;
  });

  const doing = steps.map((st, i) => {
    const m = moments.get(st.id);
    const actor = st.actor && !roleHead.startsWith(String(st.actor).toLowerCase()) ? st.actor : "";
    return cell(2, `jg-step${m ? " is-moment" : ""}`, html`
      ${m && html`<span class="moment-badge" title="Moment that matters">★ Moment</span>`}
      <span class="jg-step-t">${st.name}</span>
      <span class="jg-step-m">${[actor && html`<span class="chip chip-ink">${actor}</span>`, st.channel && html`<span class="chip">${st.channel}</span>`]}</span>`, i);
  });
  const thinking = steps.map((st, i) => (st.thinking ? cell(3, "jg-think", html`<q>${st.thinking}</q>`, i) : cell(3, "jg-blank", "", i)));
  const pains = steps.map((st, i) => {
    const xs = asList(st.painPoints);
    return xs.length ? cell(5, "jg-pain", html`<ul>${xs.map((t) => html`<li>${t}</li>`)}</ul>`, i) : cell(5, "jg-blank", "", i);
  });
  const opps = steps.map((st, i) => {
    const xs = asList(st.opportunities);
    return xs.length ? cell(6, "jg-opp", html`<ul>${xs.map((t) => html`<li>${t}</li>`)}</ul>`, i) : cell(6, "jg-blank", "", i);
  });
  const curve = feelingCurve(steps, id);
  const label = (t, row) => html`<div class="jg-label" style="grid-row:${row}">${t}</div>`;

  const grid = html`
    <div class="jg-scroll" tabindex="0" role="region" aria-label="${j.title || "Journey"} — journey map, scrolls sideways">
      <div class="jg" style="--n:${n}">
        <div class="jg-corner" style="grid-row:1"></div>
        ${stageHeads}
        ${label("Doing", 2)}${doing}
        ${label("Thinking", 3)}${thinking}
        ${curve && html`${label(html`Feeling<span class="jc-key"><span><i class="k-today"></i>Today</span><span><i class="k-target"></i>Tomorrow</span></span>`, 4)}<div class="jg-curve" style="grid-row:4;grid-column:2 / span ${n}">${curve}</div>`}
        ${label("Pain points", 5)}${pains}
        ${label("Opportunities", 6)}${opps}
      </div>
    </div>`;

  const stepById = new Map(steps.map((s) => [s.id, s]));
  const mtm = (j.momentsThatMatter || []).length > 0 && html`
    <section class="mtm">
      <h4 class="h4">Moments that matter</h4>
      <div class="mtm-grid">
        ${j.momentsThatMatter.map((m) => html`
          <article class="mtm-card">
            <h5 class="mtm-t"><span class="moment-badge" aria-hidden="true">★</span>${stepById.get(m.stepId)?.name || "Moment that matters"}</h5>
            ${m.why && html`<p><b>Why it matters.</b> ${m.why}</p>`}
            ${m.designResponse && html`<p class="mtm-resp"><b>What changes.</b> ${m.designResponse}</p>`}
          </article>`)}
      </div>
    </section>`;

  return html`
    <section class="jv card" data-show="personas/journeys/${j.id}" aria-label="${j.title || "Journey"}">
      ${head}
      ${grid}
      ${mtm}
    </section>`;
}
