// What a retry of document extraction targets, and what it refuses.
//
// Extraction is normally not a step anybody runs — all three upload routes
// start it the moment a document lands. This is the exception: a document that
// FAILED, or one wedged at `extracting` behind a claim whose owner was killed.
// Nothing here spawns anything; it decides, and the route acts on the decision.
//
// Kept out of the route for the reason `decideCreate` in names.ts is: the thing
// worth testing is the refusals, and a refusal that names the wrong cause sends
// somebody to fix something that was never broken.

/** One document's extraction state, as `scripts/extract-state.mjs` reports it. */
export interface ExtractDoc {
  /** Path relative to the document's own level root — `documents/a.md`. */
  docId: string;
  /** `"project"`, or the feature folder the document belongs to. */
  scope: string;
  state: "ready" | "missing" | "failed" | "extracting";
  reason?: string;
  attempts?: number;
  firstFailedAt?: string;
  lastFailedAt?: string;
}

export interface RetryTarget {
  doc: string;
  scope: string;
  state: ExtractDoc["state"];
  reason?: string;
  attempts?: number;
  lastFailedAt?: string;
}

export type RetryPlan =
  | { ok: true; retrying: RetryTarget[]; args: string[] }
  | {
      ok: false;
      error: "no_documents" | "no_such_document" | "nothing_to_retry" | "already_ready";
      message: string;
      known?: string[];
    };

/** How a document is addressed across the two surfaces — unique within a project. */
const address = (d: ExtractDoc) => `${d.scope}/${d.docId}`;

const target = (d: ExtractDoc): RetryTarget => ({
  doc: d.docId,
  scope: d.scope,
  state: d.state,
  ...(d.reason ? { reason: d.reason } : {}),
  ...(d.attempts != null ? { attempts: d.attempts } : {}),
  ...(d.lastFailedAt ? { lastFailedAt: d.lastFailedAt } : {}),
});

export function planRetry(
  documents: ExtractDoc[],
  opts: { doc?: string; force?: boolean },
): RetryPlan {
  if (!documents.length) {
    return {
      ok: false, error: "no_documents",
      message: "This project holds no documents, so there is nothing to extract.",
    };
  }

  const force = Boolean(opts.force);

  if (opts.doc) {
    // Accepted with or without the scope prefix, because the two surfaces name
    // it both ways: `extract_status` reports the bare `docId`, while the address
    // that is actually unique within a project carries the scope.
    const wanted = opts.doc.replace(/^\.\//, "");
    const found = documents.find((d) => d.docId === wanted || address(d) === wanted);
    if (!found) {
      return {
        ok: false, error: "no_such_document",
        message: `No document named ${opts.doc} in this project.`,
        known: documents.map(address),
      };
    }
    // Naming a document that is already extracted is more likely a mistake than
    // a request to spend an agent run redoing it, so it is refused rather than
    // quietly obeyed — and the refusal names the flag that means it.
    if (found.state === "ready" && !force) {
      return {
        ok: false, error: "already_ready",
        message: `${address(found)} is already extracted. Pass force to extract it again.`,
      };
    }
    return { ok: true, retrying: [target(found)], args: ["--doc", address(found), ...(force ? ["--force"] : [])] };
  }

  // `extracting` is included deliberately. It usually means a live pass owns the
  // claim and the answer is to wait — but it is also exactly how a document
  // looks when the pass holding its claim was killed, and that is the state a
  // person most needs a way out of.
  const targets = force ? documents : documents.filter((d) => d.state !== "ready");
  if (!targets.length) {
    return {
      ok: false, error: "nothing_to_retry",
      message: "Every document in this project is already extracted.",
    };
  }
  return { ok: true, retrying: targets.map(target), args: force ? ["--force"] : [] };
}
