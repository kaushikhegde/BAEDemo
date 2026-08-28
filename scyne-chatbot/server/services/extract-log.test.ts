// Finding the run that extracted ONE document.
//
// `scripts/extract-documents.mjs` is a fan-out: a single `exec` step that spawns
// one agent per document and records one `runs` row for each, phased
// `extract: <docId>`. The engine cannot narrate inside a step, so that phase is
// the only thing tying an agent's transcript to the document it read — there is
// no per-document issue, and `agent_id` is the same on every row because the
// spend all belongs to the Capabilities Process Architect.
//
// Picking the wrong row shows somebody a clean transcript for a document that
// failed, or another document's failure against this one's name.

import { describe, it, expect } from "vitest";
import { phaseFor, pickExtractRun, type ExtractRun } from "./extract-log.js";

const run = (over: Partial<ExtractRun> & { runId: string }): ExtractRun => ({
  phase: null, status: "succeeded", startedAt: "2026-08-28T09:00:00.000Z",
  issueId: "i1", ...over,
});

describe("phaseFor", () => {
  it("builds the phase the extractor writes", () => {
    expect(phaseFor("documents/Introduction.md")).toBe("extract: documents/Introduction.md");
  });

  it("uses the docId as-is, spaces and all", () => {
    // `Attachment 1 - SAPN Customer Conceptual Data Model - Draft V1.md` is a
    // real document here. The extractor does not encode or slug the id, so
    // neither may this — a normalised copy matches nothing.
    const id = "documents/Attachment 1 - SAPN Customer Conceptual Data Model - Draft V1.md";
    expect(phaseFor(id)).toBe(`extract: ${id}`);
  });
});

describe("pickExtractRun", () => {
  const docId = "documents/a.md";

  it("finds the row for this document and no other", () => {
    const runs = [
      run({ runId: "r1", phase: "extract: documents/b.md" }),
      run({ runId: "r2", phase: "extract: documents/a.md" }),
    ];
    expect(pickExtractRun(runs, docId)?.runId).toBe("r2");
  });

  it("prefers the FAILED attempt when a document was retried into success", () => {
    // The question being asked is "why did this fail", and a document that
    // failed twice and then succeeded has three rows. Handing back the
    // successful one answers a question nobody asked and hides the fault.
    const runs = [
      run({ runId: "ok", phase: `extract: ${docId}`, status: "succeeded", startedAt: "2026-08-28T09:30:00.000Z" }),
      run({ runId: "bad", phase: `extract: ${docId}`, status: "failed", startedAt: "2026-08-28T09:10:00.000Z" }),
    ];
    expect(pickExtractRun(runs, docId)?.runId).toBe("bad");
  });

  it("takes the LATEST failure when there are several", () => {
    // Two failures mean the first one's cause may already have been addressed.
    // The most recent attempt is the one whose reason is still true.
    const runs = [
      run({ runId: "old", phase: `extract: ${docId}`, status: "failed", startedAt: "2026-08-28T09:00:00.000Z" }),
      run({ runId: "new", phase: `extract: ${docId}`, status: "failed", startedAt: "2026-08-28T09:20:00.000Z" }),
    ];
    expect(pickExtractRun(runs, docId)?.runId).toBe("new");
  });

  it("falls back to the latest run of any status when none failed", () => {
    // A document can be `missing` with a succeeded run behind it — the extract
    // was harvested into a tree that was then discarded. The transcript is
    // still the useful thing to show.
    const runs = [
      run({ runId: "a", phase: `extract: ${docId}`, status: "succeeded", startedAt: "2026-08-28T09:00:00.000Z" }),
      run({ runId: "b", phase: `extract: ${docId}`, status: "succeeded", startedAt: "2026-08-28T09:40:00.000Z" }),
    ];
    expect(pickExtractRun(runs, docId)?.runId).toBe("b");
  });

  it("returns null when nothing extracted this document", () => {
    // A document uploaded thirty seconds ago has no run at all, and saying so
    // is different from showing an empty transcript.
    expect(pickExtractRun([run({ runId: "r1", phase: "extract: documents/other.md" })], docId)).toBeNull();
  });

  it("ignores the step's own run rows", () => {
    // The engine writes its own row for the `exec` step, phased with the step's
    // label rather than a document. It carries the whole fan-out's stdout and
    // is not any single document's transcript.
    const runs = [
      run({ runId: "step", phase: "Building the document extraction" }),
      run({ runId: "step2", phase: null }),
    ];
    expect(pickExtractRun(runs, docId)).toBeNull();
  });

  it("does not match a document whose id merely starts the same", () => {
    // `documents/a.md` and `documents/a.md.bak` share a prefix. A `startsWith`
    // match would hand back the wrong file's transcript.
    const runs = [run({ runId: "r1", phase: "extract: documents/a.md.bak", status: "failed" })];
    expect(pickExtractRun(runs, docId)).toBeNull();
  });
});
