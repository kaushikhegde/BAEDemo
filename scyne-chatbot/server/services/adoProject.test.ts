// Which work item type a project ends up recorded with.
//
// The case that motivated this: `ensureAdoProject` defaulted to Agile's "User
// Story" and ASSERTED it, so an existing project on the Basic template — Epic,
// Issue, Task, no User Story anywhere — failed the step whose whole job is to
// guarantee there is somewhere to publish to. A project that had been
// publishing happily could not publish, and the message was about work item
// types rather than about anything the person had done.
//
// The rule now: a supplied type is a PREFERENCE unless the caller says it is a
// requirement. `ado-workitems.mjs` has always discovered the type rather than
// insisting on one; this brings the two into line.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { ensureAdoProject } from "./adoProject.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(() => { process.env.ADO_PAT = "fake"; });

/** An org holding one project that already exists, with the given types. */
function stub(types: string[]) {
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    const body = u.includes("/_apis/wit/workitemtypes")
      ? { value: types.map(name => ({ name })) }
      : u.includes("/_apis/wiki/wikis")
        ? { value: [{ id: "w1", name: "P.wiki" }] }
        : { id: "pid", name: "P" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as any;
}

const BASIC = ["Epic", "Issue", "Task", "Test Case"];
const AGILE = ["Epic", "Feature", "User Story", "Task", "Bug"];

describe("ensureAdoProject work item type", () => {
  it("resolves Basic to Issue instead of failing on the Agile default", async () => {
    stub(BASIC);
    const r = await ensureAdoProject({ org: "O", project: "P" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.target.workItemType).toBe("Issue");
  });

  it("still prefers User Story where the project has one", async () => {
    stub(AGILE);
    const r = await ensureAdoProject({ org: "O", project: "P" });
    expect(r.ok && r.target.workItemType).toBe("User Story");
  });

  // The recorded value is our own note, written before anyone checked. Being
  // wrong about it must not block every publish that follows.
  it("corrects a recorded type the project does not have", async () => {
    stub(BASIC);
    const r = await ensureAdoProject({ org: "O", project: "P", workItemType: "User Story" });
    expect(r.ok && r.target.workItemType).toBe("Issue");
  });

  it("honours a type that IS available", async () => {
    stub(AGILE);
    const r = await ensureAdoProject({ org: "O", project: "P", workItemType: "Bug" });
    expect(r.ok && r.target.workItemType).toBe("Bug");
  });

  // A typed flag is an assertion — being wrong about one you typed is worth
  // hearing about rather than absorbing.
  it("fails when a REQUIRED type is missing, naming what is there", async () => {
    stub(BASIC);
    const r = await ensureAdoProject({
      org: "O", project: "P", workItemType: "User Story", requireWorkItemType: true,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("has no \"User Story\" work item type");
    expect(!r.ok && r.error).toContain("Issue");
  });

  it("fails when nothing a story could be created as exists", async () => {
    stub(["Task", "Bug"]);
    const r = await ensureAdoProject({ org: "O", project: "P" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("no work item type stories can be created as");
  });
});
