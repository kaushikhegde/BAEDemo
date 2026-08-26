// What a retry targets, and what it refuses.
//
// The decision is separated from the route for the reason `decideCreate` in
// names.ts was: a refusal that says the wrong thing is the failure mode here,
// and none of it needs a server, a workspace or a spawned process to check.

import { describe, it, expect } from "vitest";
import { planRetry, type ExtractDoc } from "./extractRetry.js";

const doc = (over: Partial<ExtractDoc> = {}): ExtractDoc => ({
  docId: "documents/a.md", scope: "project", state: "failed",
  reason: "no text layer in PDF", attempts: 3,
  lastFailedAt: "2026-08-26T09:00:00.000Z", ...over,
});

describe("planRetry", () => {
  it("targets every document that is not ready", () => {
    const plan = planRetry([
      doc(),
      doc({ docId: "documents/b.md", state: "ready", reason: undefined, attempts: undefined }),
      doc({ docId: "requirements/SOP/c.md", scope: "Appeals", state: "missing", reason: undefined }),
    ], {});

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.retrying.map((r) => r.doc)).toEqual(["documents/a.md", "requirements/SOP/c.md"]);
    expect(plan.args).toEqual([]);
  });

  it("carries the reason and the attempt count into the answer", () => {
    // The whole point of the call: a caller who has just been told "extraction
    // failed" learns WHICH document and WHY in the same round trip that retries
    // it, rather than being sent to a second tool to find out.
    const plan = planRetry([doc()], {});

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.retrying[0]).toMatchObject({
      doc: "documents/a.md", scope: "project", state: "failed",
      reason: "no text layer in PDF", attempts: 3,
    });
  });

  it("narrows to one document, addressed with or without its scope", () => {
    const docs = [doc(), doc({ docId: "requirements/SOP/c.md", scope: "Appeals" })];

    for (const named of ["documents/a.md", "project/documents/a.md"]) {
      const plan = planRetry(docs, { doc: named });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.retrying.map((r) => r.doc)).toEqual(["documents/a.md"]);
      expect(plan.args).toEqual(["--doc", "project/documents/a.md"]);
    }
  });

  it("refuses a document it does not know, and says what it does know", () => {
    const plan = planRetry([doc()], { doc: "documents/nope.md" });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toBe("no_such_document");
    expect(plan.known).toEqual(["project/documents/a.md"]);
  });

  it("refuses when the project holds no documents at all", () => {
    const plan = planRetry([], {});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toBe("no_documents");
  });

  it("refuses when every document is already ready", () => {
    // Separate from no_documents because the fix is different: nothing is wrong,
    // as against upload something.
    const plan = planRetry([doc({ state: "ready" })], {});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toBe("nothing_to_retry");
  });

  it("refuses a named document that is already ready, rather than silently redoing it", () => {
    const plan = planRetry([doc({ state: "ready" })], { doc: "documents/a.md" });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toBe("already_ready");
    expect(plan.message).toMatch(/force/);
  });

  it("force re-extracts a ready document, and says so in the args", () => {
    const plan = planRetry([doc({ state: "ready" })], { doc: "documents/a.md", force: true });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.args).toEqual(["--doc", "project/documents/a.md", "--force"]);
  });

  it("force with no document named re-extracts everything, ready included", () => {
    const plan = planRetry([doc({ state: "ready" }), doc({ docId: "documents/b.md" })], { force: true });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.retrying).toHaveLength(2);
    expect(plan.args).toEqual(["--force"]);
  });

  it("still retries a document stuck at extracting, which is what a wedged claim looks like", () => {
    const plan = planRetry([doc({ state: "extracting", reason: undefined })], {});
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.retrying.map((r) => r.state)).toEqual(["extracting"]);
  });
});
