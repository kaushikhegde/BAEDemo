// One rule for what a new project is called, and what it becomes.
//
// A project name is also the Azure DevOps project, the wiki path segment, the
// folder every agent resolves paths against, and the `--project` argument on
// every CLI verb. It was refused outright when it had a space, by a rule the
// wizard did not share — so the Next button lit up on a name the server was
// about to reject, and the suggestion the server sent back was never shown.

import { describe, it, expect } from "vitest";
import { slugProjectName, isNewProjectName, decideCreate } from "./names.js";

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

/**
 * The project-exists decision, which used to be `fs.access` on a folder.
 *
 * It is here rather than in a route test because the input is now the project
 * ROW: the whole point of the change is that a directory no longer decides
 * whether a project exists. These are the four states, and the ones that
 * matter are the two that are NOT simple.
 */
describe("decideCreate", () => {
  const complete = { ado_target: { org: "Scyne-AI-Lab", project: "SA-Demo" } };
  const incomplete = { ado_target: null };

  it("creates when no row holds the name", () => {
    expect(decideCreate({ existing: null, requested: "SA Demo", project: "SA-Demo" })).toBe("create");
  });

  it("refuses when a fully set-up project holds it", () => {
    expect(decideCreate({ existing: complete, requested: "SA-Demo", project: "SA-Demo" })).toBe("exists");
  });

  it("completes an incomplete project when the caller typed its name exactly", () => {
    // This is the state a failed Azure DevOps setup leaves behind, and this
    // route is the only thing that can repair it — so it must not be refused.
    expect(decideCreate({ existing: incomplete, requested: "SA-Demo", project: "SA-Demo" })).toBe("complete");
  });

  it("refuses to complete a project the caller only SLUGGED onto", () => {
    // `SA Demo` and `SA-Demo` are two different projects that exist side by
    // side in this install. Completing one rewrites its Azure DevOps target
    // and its branding, so adopting it because a typed name happened to slug
    // onto it would hand one client's tree another client's target.
    expect(decideCreate({ existing: incomplete, requested: "SA Demo", project: "SA-Demo" }))
      .toBe("slug_collision");
  });

  it("treats a target with no project in it as no target", () => {
    // A half-succeeded setup leaves an object, not a usable target. Reading
    // truthiness on the object rather than on `.project` would call that
    // project taken and strand it permanently.
    for (const half of [{}, { org: "Scyne-AI-Lab" }, { project: "" }]) {
      expect(decideCreate({ existing: { ado_target: half }, requested: "X", project: "X" }))
        .toBe("complete");
    }
  });

  it("treats an absent ado_target field the same as a null one", () => {
    // A row read back from an API that omits nulls must not read as complete.
    expect(decideCreate({ existing: {}, requested: "X", project: "X" })).toBe("complete");
  });
});
