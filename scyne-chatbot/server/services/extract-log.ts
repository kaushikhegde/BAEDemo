// Which agent run extracted ONE document.
//
// Extraction is a fan-out inside a single `exec` step: `extract-documents.mjs`
// spawns one agent per document and opens one `runs` row for each, phased
// `extract: <docId>`. The engine narrates STEPS and cannot narrate inside one,
// so that phase string is the only thing connecting a transcript to the
// document it read. `agent_id` cannot do it — every row carries the same
// Capabilities Process Architect, deliberately, because that is whose spend it
// is — and `step_index` cannot either, since all of them sit at the one step.
//
// Pure, so the matching can be tested without an orchestrator: the I/O is in
// the route.

/** One `runs` row, narrowed to what choosing between them needs. */
export interface ExtractRun {
  runId: string;
  issueId: string;
  /** `extract: documents/a.md` for a fan-out row; the step's label otherwise. */
  phase: string | null;
  status: string;
  startedAt: string | null;
}

/**
 * The phase `extract-documents.mjs` writes for a document.
 *
 * The docId goes in verbatim — not encoded, not slugged. Real ids here contain
 * spaces and hyphens (`documents/Attachment 1 - SAPN Customer Conceptual Data
 * Model - Draft V1.md`), and a normalised copy matches no row at all.
 */
export const phaseFor = (docId: string): string => `extract: ${docId}`;

/**
 * The run whose transcript answers "what happened to this document".
 *
 * A FAILED attempt wins over a successful one. A document that failed twice and
 * then extracted has three rows, and handing back the successful one answers a
 * question nobody asked while hiding the fault that was actually being
 * investigated. Among failures, the most recent: an earlier cause may already
 * have been addressed, and the latest attempt is the one whose reason still
 * holds.
 *
 * Null when nothing extracted this document — a document uploaded thirty
 * seconds ago has no row, and saying so is not the same as showing an empty
 * transcript.
 */
export const pickExtractRun = (
  runs: readonly ExtractRun[], docId: string,
): ExtractRun | null => {
  // Exact equality, never a prefix: `documents/a.md` and `documents/a.md.bak`
  // share one, and a loose match hands back the wrong file's transcript.
  const want = phaseFor(docId);
  const mine = runs.filter((r) => r.phase === want);
  if (!mine.length) return null;

  const latest = (rows: readonly ExtractRun[]) =>
    [...rows].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];

  const failed = mine.filter((r) => r.status === "failed");
  return latest(failed.length ? failed : mine) ?? null;
};
