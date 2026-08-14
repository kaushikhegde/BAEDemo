#!/usr/bin/env node
// Validate the Service Designer's companion-app data against the contract in
// skills/persona-journey-map/SKILL.md (Appendix C).
//
//   node scripts/validate-experience.mjs <project> <feature>
//
// Reads   projects/<project>/<feature>/solutions/Experience/outputs/
//           personas.json      { personas: [...] }
//           journey-map.json   { journeys: [...] }
//
// These two files are consumed by a build, not read by a person: the companion
// app is scaffolded last, and a malformed field there surfaces weeks later with
// nothing to point at. This is the only guard between the two, so it checks the
// referential integrity the app depends on — every journey resolves to a
// persona, every "moment that matters" resolves to a step — not just the shape.
//
// Exits non-zero listing every problem found (not just the first), so one run
// tells the agent everything it has to fix.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE = process.env.WORKSPACE_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_NAME = /^[A-Za-z0-9._ &-]+$/;

// Must match the palette in the skill's Appendix C and the companion app's
// Tailwind config — an unknown class renders as no background at all.
const PALETTE = new Set([
  "bg-blue-900", "bg-amber-500", "bg-teal-600", "bg-sky-400",
  "bg-rose-600", "bg-violet-700", "bg-emerald-600",
]);

const problems = [];
const bad = (file, msg) => problems.push(`${file}: ${msg}`);

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);

async function readJson(file, label) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    console.error(`[validate-experience] ${label} not found: ${path.relative(WORKSPACE, file)}`);
    console.error(`  Run the persona-journey-map skill first — it writes this file.`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[validate-experience] ${label} is not valid JSON (${path.relative(WORKSPACE, file)}): ${e.message}`);
    process.exit(1);
  }
}

function validatePersonas(doc) {
  const F = "personas.json";
  if (!doc || !Array.isArray(doc.personas)) {
    bad(F, `expected { "personas": [...] }`);
    return [];
  }
  const { personas } = doc;
  if (personas.length === 0) bad(F, "no personas — the skill must not produce an empty set");
  if (personas.length > 7) bad(F, `${personas.length} personas — more than 7 means the set is segmenting on job titles (see Step 3)`);

  const seen = new Set();
  personas.forEach((p, i) => {
    const at = `personas[${i}]${isStr(p?.id) ? ` (${p.id})` : ""}`;
    if (!p || typeof p !== "object") return bad(F, `${at}: not an object`);

    for (const f of ["id", "name", "role", "context", "keyBenefit", "journeySummary", "avatarColor"]) {
      if (!isStr(p[f])) bad(F, `${at}: "${f}" must be a non-empty string`);
    }
    if (isStr(p.id)) {
      if (!/^[a-z0-9-]+$/.test(p.id)) bad(F, `${at}: "id" must be lowercase and hyphenated`);
      if (seen.has(p.id)) bad(F, `${at}: duplicate id "${p.id}"`);
      seen.add(p.id);
    }
    if (isStr(p.avatarColor) && !PALETTE.has(p.avatarColor)) {
      bad(F, `${at}: avatarColor "${p.avatarColor}" is not in the app palette (${[...PALETTE].join(", ")})`);
    }
    for (const f of ["today", "tomorrow"]) {
      if (!isStrArray(p[f])) { bad(F, `${at}: "${f}" must be an array of non-empty strings`); continue; }
      if (p[f].length < 3 || p[f].length > 5) bad(F, `${at}: "${f}" has ${p[f].length} items, expected 3–5`);
      // The app's CSV loader joins these with "; " — a semicolon inside an item
      // silently splits it into two bullets on the way through.
      p[f].forEach((v, j) => { if (v.includes(";")) bad(F, `${at}: ${f}[${j}] contains a semicolon, which the CSV loader treats as an item separator`); });
    }
    if (p.sources !== undefined && !isStrArray(p.sources)) bad(F, `${at}: "sources" must be an array of filenames when present`);
    else if (!p.sources || p.sources.length === 0) bad(F, `${at}: no "sources" — every persona must cite the document it came from`);
  });
  return [...seen];
}

function validateJourneys(doc, personaIds) {
  const F = "journey-map.json";
  if (!doc || !Array.isArray(doc.journeys)) {
    bad(F, `expected { "journeys": [...] }`);
    return;
  }
  const { journeys } = doc;
  if (journeys.length === 0) bad(F, "no journeys");

  const seenJourney = new Set();
  const covered = new Set();

  journeys.forEach((j, i) => {
    const at = `journeys[${i}]${isStr(j?.id) ? ` (${j.id})` : ""}`;
    if (!j || typeof j !== "object") return bad(F, `${at}: not an object`);

    for (const f of ["id", "personaId", "title", "scenario"]) {
      if (!isStr(j[f])) bad(F, `${at}: "${f}" must be a non-empty string`);
    }
    if (isStr(j.id)) {
      if (seenJourney.has(j.id)) bad(F, `${at}: duplicate journey id "${j.id}"`);
      seenJourney.add(j.id);
    }
    if (isStr(j.personaId)) {
      if (!personaIds.includes(j.personaId)) bad(F, `${at}: personaId "${j.personaId}" does not resolve to any persona in personas.json`);
      covered.add(j.personaId);
    }

    if (!Array.isArray(j.stages) || j.stages.length === 0) {
      return bad(F, `${at}: "stages" must be a non-empty array`);
    }
    if (j.stages.length < 3) bad(F, `${at}: ${j.stages.length} stage(s) — a journey with fewer than 3 is a summary, not a map`);

    const stepIds = new Set();
    let stepCount = 0;
    j.stages.forEach((st, si) => {
      const sat = `${at}.stages[${si}]${isStr(st?.id) ? ` (${st.id})` : ""}`;
      if (!isStr(st?.id) || !isStr(st?.name)) bad(F, `${sat}: "id" and "name" are required`);
      if (!Array.isArray(st?.steps) || st.steps.length === 0) return bad(F, `${sat}: "steps" must be a non-empty array`);

      st.steps.forEach((step, pi) => {
        stepCount++;
        const pat = `${sat}.steps[${pi}]${isStr(step?.id) ? ` (${step.id})` : ""}`;
        for (const f of ["id", "name", "actor", "doing", "thinking", "feeling"]) {
          if (!isStr(step?.[f])) bad(F, `${pat}: "${f}" must be a non-empty string`);
        }
        if (isStr(step?.id)) {
          if (stepIds.has(step.id)) bad(F, `${pat}: duplicate step id "${step.id}" within this journey`);
          stepIds.add(step.id);
        }
        for (const f of ["todayScore", "targetScore"]) {
          const v = step?.[f];
          if (!Number.isInteger(v) || v < 1 || v > 5) bad(F, `${pat}: "${f}" must be an integer 1–5 (got ${JSON.stringify(v)})`);
        }
        // A colon breaks the mermaid `journey` field separator; a semicolon
        // terminates the statement. Either produces a misleading parse error.
        if (isStr(step?.name) && /[:;]/.test(step.name)) {
          bad(F, `${pat}: step name contains ":" or ";", which breaks the mermaid journey diagram`);
        }
        for (const f of ["painPoints", "opportunities", "capabilityIds", "sources"]) {
          if (step?.[f] !== undefined && !isStrArray(step[f]) && !(Array.isArray(step[f]) && step[f].length === 0)) {
            bad(F, `${pat}: "${f}" must be an array of strings when present`);
          }
        }
      });
    });

    if (stepCount < 8) bad(F, `${at}: ${stepCount} steps — below 8 the map is a summary (see Appendix B)`);

    // Moments that matter must point at real steps, and be a subset — the whole
    // point is prioritisation, so "everything matters" is the same as nothing.
    const moments = j.momentsThatMatter;
    if (!Array.isArray(moments) || moments.length === 0) {
      bad(F, `${at}: "momentsThatMatter" must list 3–5 steps — without them the map gives no way to prioritise`);
    } else {
      if (moments.length > 5) bad(F, `${at}: ${moments.length} moments that matter — keep it to 3–5`);
      moments.forEach((m, mi) => {
        if (!isStr(m?.stepId)) return bad(F, `${at}.momentsThatMatter[${mi}]: "stepId" required`);
        if (!stepIds.has(m.stepId)) bad(F, `${at}.momentsThatMatter[${mi}]: stepId "${m.stepId}" does not resolve to a step in this journey`);
        if (!isStr(m?.why) || !isStr(m?.designResponse)) bad(F, `${at}.momentsThatMatter[${mi}]: "why" and "designResponse" are required`);
      });
      if (moments.length >= stepCount) bad(F, `${at}: every step is a moment that matters — that is not a prioritisation`);
    }

    if (j.metrics !== undefined && !Array.isArray(j.metrics)) bad(F, `${at}: "metrics" must be an array when present`);
  });

  for (const id of personaIds) {
    if (!covered.has(id)) bad(F, `persona "${id}" has no journey — every persona needs exactly one`);
  }
}

async function main() {
  // Personas describe the CLIENT, not one slice of work, so they live at
  // project level. A trailing feature name is accepted and ignored rather than
  // rejected, because muscle memory and older agent instructions still pass one.
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const [project, ...rest] = argv;
  if (!project) {
    console.error("Usage: node scripts/validate-experience.mjs <project>");
    process.exit(1);
  }
  if (!SAFE_NAME.test(project)) {
    console.error("[validate-experience] project name contains unexpected characters");
    process.exit(1);
  }
  if (rest.length) {
    console.warn(`[validate-experience] ignoring "${rest.join(" ")}" — personas are project-level now`);
  }

  const out = path.join(WORKSPACE, "projects", project, "solutions", "Experience", "outputs");
  const personasDoc = await readJson(path.join(out, "personas.json"), "personas.json");
  const journeysDoc = await readJson(path.join(out, "journey-map.json"), "journey-map.json");

  const personaIds = validatePersonas(personasDoc);
  validateJourneys(journeysDoc, personaIds);

  if (problems.length) {
    console.error(`\n[validate-experience] ${problems.length} problem(s) in ${project}:\n`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`\nFix these and re-run. The companion app build has no other guard.\n`);
    process.exit(2);
  }

  const nJourneys = journeysDoc.journeys.length;
  const nSteps = journeysDoc.journeys.reduce((a, j) => a + j.stages.reduce((b, s) => b + (s.steps?.length || 0), 0), 0);
  console.log(`[validate-experience] ${project} OK — ${personaIds.length} personas, ${nJourneys} journeys, ${nSteps} steps`);
}

main().catch((e) => {
  console.error(`[validate-experience] ${e.stack || e}`);
  process.exit(1);
});
