// The two pure helpers behind the ops views.
//
// `summariseDetail` earns a test because its failure is silent: an audit row's
// `detail` is an object, and rendering it directly puts `[object Object]` in
// the column that is supposed to say what happened — which reads as a broken
// renderer rather than as the missing information it is. Caught against a live
// response while building this, not in review.

import { describe, it, expect } from "vitest";
import { summariseDetail, sinceFor, OpsError } from "./api";

describe("summariseDetail", () => {
  it("prefers the path, which is what someone scanning the column is after", () => {
    expect(summariseDetail({ path: "requirements/Notes/Intro.md", version: 1, changed: true }))
      .toBe("requirements/Notes/Intro.md");
  });

  it("never renders an object as [object Object]", () => {
    const out = summariseDetail({ version: 3, changed: true });
    expect(out).not.toContain("[object Object]");
    expect(out).toBe("version 3 · changed true");
  });

  it("drops nested objects rather than stringifying them", () => {
    expect(summariseDetail({ version: 2, nested: { a: 1 } })).toBe("version 2");
  });

  it("passes a string through, and renders nothing for null", () => {
    expect(summariseDetail("already text")).toBe("already text");
    expect(summariseDetail(null)).toBe("");
    expect(summariseDetail(undefined)).toBe("");
  });
});

describe("OpsError", () => {
  it("distinguishes a refusal from an outage, because the views render them differently", () => {
    expect(new OpsError(403, "forbidden", "no").forbidden).toBe(true);
    expect(new OpsError(403, "forbidden", "no").unreachable).toBe(false);
    expect(new OpsError(503, "orchestrator_unreachable", "down").unreachable).toBe(true);
    expect(new OpsError(500, "upstream_error", "boom").forbidden).toBe(false);
  });
});

describe("sinceFor", () => {
  // Midday on the 21st, local time — so a UTC-computed boundary would land on
  // the wrong side of it for anyone east of Greenwich.
  const noon = new Date(2026, 7, 21, 12, 0, 0).getTime();

  it("returns null for all time, so the default filters nothing", () => {
    expect(sinceFor("", noon)).toBeNull();
  });

  it("starts today at local midnight, not UTC midnight", () => {
    const d = new Date(sinceFor("today", noon)!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(21);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it("starts this month on the first, at local midnight", () => {
    const d = new Date(sinceFor("mtd", noon)!);
    expect(d.getDate()).toBe(1);
    expect(d.getMonth()).toBe(7);
    expect(d.getHours()).toBe(0);
  });

  it("counts back whole days, so a range never depends on the time of day", () => {
    // 7 days back from the 21st is the 14th at midnight — not the 14th at
    // noon, which would silently move every time the page was reloaded.
    const d = new Date(sinceFor("7d", noon)!);
    expect(d.getDate()).toBe(14);
    expect(d.getHours()).toBe(0);
  });

  it("crosses a month boundary correctly", () => {
    const d = new Date(sinceFor("30d", noon)!);
    expect(d.getMonth()).toBe(6);      // July
    expect(d.getDate()).toBe(22);
  });
});
