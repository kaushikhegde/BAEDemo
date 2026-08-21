// One rule for what a new project is called, and what it becomes.
//
// A project name is also the Azure DevOps project, the wiki path segment, the
// folder every agent resolves paths against, and the `--project` argument on
// every CLI verb. It was refused outright when it had a space, by a rule the
// wizard did not share — so the Next button lit up on a name the server was
// about to reject, and the suggestion the server sent back was never shown.

import { describe, it, expect } from "vitest";
import { slugProjectName, isNewProjectName } from "./names.js";

describe("slugProjectName", () => {
  it("hyphenates the spaces a person naturally types", () => {
    expect(slugProjectName("SA Power Networks")).toBe("SA-Power-Networks");
  });

  it("leaves a name that needs nothing alone", () => {
    // The overwhelmingly common case, and it must be an identity — a slug that
    // rewrote a working name would rename every existing project.
    for (const n of ["SAPN", "SA-Demo", "SAPN_DEMO", "RTWSA", "acme.co"]) {
      expect(slugProjectName(n)).toBe(n);
    }
  });

  it("collapses runs of whitespace rather than emitting empty segments", () => {
    expect(slugProjectName("SA   Power  Networks")).toBe("SA-Power-Networks");
    expect(slugProjectName("SA \t Power")).toBe("SA-Power");
  });

  it("trims, so a trailing space cannot produce a trailing hyphen", () => {
    // A pasted name routinely carries one, and `SAPN-` is a different folder.
    expect(slugProjectName("  SAPN  ")).toBe("SAPN");
    expect(slugProjectName("SA Power ")).toBe("SA-Power");
  });

  it("does not double up hyphens a person typed themselves", () => {
    expect(slugProjectName("SA - Power")).toBe("SA-Power");
    expect(slugProjectName("SA--Power")).toBe("SA-Power");
  });

  it("is idempotent — slugging a slug changes nothing", () => {
    for (const n of ["SA Power Networks", "  SA   Power ", "SA - Power"]) {
      expect(slugProjectName(slugProjectName(n))).toBe(slugProjectName(n));
    }
  });

  it("is empty for a name with nothing in it", () => {
    for (const n of ["", "   ", "-", " - "]) expect(slugProjectName(n)).toBe("");
  });
});

describe("isNewProjectName", () => {
  it("accepts what a slug produces", () => {
    for (const n of ["SAPN", "SA-Power-Networks", "SAPN_DEMO", "acme.co", "R&D"]) {
      expect(isNewProjectName(n)).toBe(true);
    }
  });

  it("rejects a character that is not legal in a folder or a wiki path", () => {
    for (const n of ["SA/Power", "SA\\Power", "SA:Power", "SA*", "SA?", "SA|x"]) {
      expect(isNewProjectName(n)).toBe(false);
    }
  });

  it("rejects a leading dot and a path climb", () => {
    // These satisfy the character class and are not names — `..` would climb
    // out of `projects/` on every route that joins one into a path.
    for (const n of ["..", ".", ".hidden"]) expect(isNewProjectName(n)).toBe(false);
  });

  it("rejects a trailing dot or space, which some filesystems silently strip", () => {
    // Two different names resolving to one folder is worse than a refusal.
    for (const n of ["SAPN.", "SAPN "]) expect(isNewProjectName(n)).toBe(false);
  });

  it("rejects a space, because a slug is applied before this is asked", () => {
    // The rule is unchanged — what changed is that nobody is asked to obey it.
    expect(isNewProjectName("SA Power Networks")).toBe(false);
  });

  it("rejects nothing at all", () => {
    expect(isNewProjectName("")).toBe(false);
  });
});
