// The shape of one document's extract, and a validator for it.
//
// PURE and dependency-free on purpose: the repo root has no runtime
// dependencies, and this file is imported by scripts/, by the chatbot server
// and by the plugin. Adding zod to the root to check eight arrays is not worth
// a dependency.
//
// The field list is not invented here — it is capability-process-map/SKILL.md
// Step 1's own "For each document, extract:" list, given a structure.

export const EXTRACT_VERSION = 1;

/** The eight arrays. Frozen because the reduce reads these names literally. */
export const ITEM_KINDS = Object.freeze([
  "businessFunctions", "processSteps", "actors", "serviceTiers",
  "components", "maturitySignals", "lifecyclePhases", "painPoints",
]);

const TOP_LEVEL = Object.freeze([
  "version", "docId", "scope", "category", "windows", ...ITEM_KINDS,
  "coverage", "usage",
]);

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isInt = (v) => Number.isInteger(v) && v >= 0;

const checkSrc = (src, where, errors) => {
  if (!src || typeof src !== "object") {
    errors.push(`${where}: src is required — every item must be traceable to its pages`);
    return;
  }
  if (!isInt(src.pageStart)) errors.push(`${where}.src.pageStart must be a non-negative integer`);
  if (!isInt(src.pageEnd)) errors.push(`${where}.src.pageEnd must be a non-negative integer`);
  if (isInt(src.pageStart) && isInt(src.pageEnd) && src.pageEnd < src.pageStart) {
    errors.push(`${where}.src.pageEnd (${src.pageEnd}) precedes pageStart (${src.pageStart})`);
  }
};

export const emptyExtract = ({ docId, scope, category }) => ({
  version: EXTRACT_VERSION,
  docId, scope, category,
  windows: [],
  ...Object.fromEntries(ITEM_KINDS.map((k) => [k, []])),
  coverage: { pagesRead: 0, pagesTotal: 0, truncated: false },
  usage: { inputTokens: 0, outputTokens: 0 },
});

/**
 * Reports EVERY problem in one pass rather than throwing on the first.
 * A map pass that produced six bad items should be told about six, not made to
 * discover them one agent run at a time.
 */
export const validateExtract = (obj) => {
  const errors = [];
  if (!obj || typeof obj !== "object") return { ok: false, errors: ["not an object"] };

  if (obj.version !== EXTRACT_VERSION) {
    errors.push(`version must be ${EXTRACT_VERSION}, got ${JSON.stringify(obj.version)}`);
  }
  for (const f of ["docId", "scope", "category"]) {
    if (!isStr(obj[f])) errors.push(`${f} is required and must be a non-empty string`);
  }

  // An unknown top-level key is nearly always a typo, and a typo here is SILENT
  // data loss: the reduce reads the correct name, finds nothing, and produces a
  // smaller map with no error anywhere.
  for (const k of Object.keys(obj)) {
    if (!TOP_LEVEL.includes(k)) errors.push(`unknown field ${k} — check the spelling against ITEM_KINDS`);
  }

  if (!Array.isArray(obj.windows)) errors.push("windows must be an array");
  else obj.windows.forEach((w, i) => checkSrc(w, `windows[${i}]`, errors));

  for (const kind of ITEM_KINDS) {
    const arr = obj[kind];
    if (!Array.isArray(arr)) { errors.push(`${kind} must be an array`); continue; }
    arr.forEach((item, i) => {
      const where = `${kind}[${i}]`;
      if (!item || typeof item !== "object") { errors.push(`${where} is not an object`); return; }
      checkSrc(item.src, where, errors);
      // painPoints are the one kind that must carry the client's own words:
      // a paraphrased pain point is not evidence in a room with a client.
      if (kind === "painPoints" && !isStr(item.quote)) {
        errors.push(`${where}.quote is required and must be verbatim`);
      }
      if (kind !== "painPoints" && !isStr(item.name) && !isStr(item.step) && !isStr(item.statement)) {
        errors.push(`${where} needs one of name / step / statement`);
      }
    });
  }

  const c = obj.coverage;
  if (!c || typeof c !== "object") errors.push("coverage is required");
  else {
    if (!isInt(c.pagesRead)) errors.push("coverage.pagesRead must be a non-negative integer");
    if (!isInt(c.pagesTotal)) errors.push("coverage.pagesTotal must be a non-negative integer");
    if (typeof c.truncated !== "boolean") errors.push("coverage.truncated must be a boolean");
    // The check that makes coverage mean something: a pass that read 10 of 25
    // pages and reported truncated:false is the silent-omission failure.
    if (isInt(c.pagesRead) && isInt(c.pagesTotal) && c.pagesRead < c.pagesTotal && c.truncated === false) {
      errors.push(`coverage says truncated:false but read ${c.pagesRead} of ${c.pagesTotal} pages`);
    }
  }

  return { ok: errors.length === 0, errors };
};
