// The links a finished workflow puts in front of the user.
//
// The bug this file pins: the chat announced NOTHING after an approval. Every
// link the UI has ever shown came from `extractLinks`, a regex over the issue's
// COMMENT bodies — and nothing writes a URL into a comment. The engine narrates
// an `exec` by its label and an agent by its duration and cost, deliberately;
// the publish agent prints the page URL as its last line of stdout, which is
// not a comment and is never read again. So a run could publish a wiki page,
// create forty-five work items, close green, and leave the client looking at an
// empty links panel.
//
// The URLs were never missing. They are recorded on disk, in the two files the
// publish VERIFIER already refuses to pass without: `.published.json`'s
// `ado.<artefact>` record, and every story's `adoId` in `stories.json`. This
// module reads them from there, which is why it also works for runs that
// finished before it existed.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { wikiUrl, workItemUrl, artefactKeysFor, mergeLinks, publishedLinks } from "./publishedLinks.js";

const TARGET = { org: "Scyne-AI-Lab", project: "Scyne AI Project", wiki: "Scyne-AI-Project-Wiki" };

describe("wikiUrl", () => {
  it("uses the recorded URL verbatim when the publisher wrote one", () => {
    // `ado-publish.mjs` records the URL it actually used. Rebuilding one over
    // the top of that is how a page published to a renamed wiki acquires a
    // second, broken link.
    const recorded = "https://dev.azure.com/o/p/_wiki/wikis/w?pagePath=%2FThing";
    expect(wikiUrl({ url: recorded, wikiPath: "/Other" }, TARGET)).toBe(recorded);
  });

  it("builds one from the target and the recorded path when there is no URL", () => {
    // An agent that published through the MCP tool rather than the script
    // records the path and often no URL — the verifier accepts that, so this
    // has to as well, or the common case yields no link.
    const url = wikiUrl({ wikiPath: "/Appeals/Salesforce Data Model" }, TARGET);
    expect(url).toBe(
      "https://dev.azure.com/Scyne-AI-Lab/Scyne%20AI%20Project/_wiki/wikis/Scyne-AI-Project-Wiki" +
      "?pagePath=%2FAppeals%2FSalesforce%20Data%20Model");
  });

  it("prefers the wiki named on the record over the project's default", () => {
    expect(wikiUrl({ wikiPath: "/X", wiki: "Other-Wiki" }, TARGET))
      .toContain("/_wiki/wikis/Other-Wiki?");
  });

  it("accepts `path` as a synonym for `wikiPath`", () => {
    // verify-published.mjs reads both, for the reason it gives: this record is
    // written by an agent, and failing a good publish over a key name is worse
    // than accepting a reasonable synonym.
    expect(wikiUrl({ path: "/X" }, TARGET)).toContain("pagePath=%2FX");
  });

  it("returns null rather than a half-built URL when it cannot make one", () => {
    expect(wikiUrl({ wikiPath: "/X" }, { org: "o" })).toBeNull();
    expect(wikiUrl(null, TARGET)).toBeNull();
    expect(wikiUrl({}, TARGET)).toBeNull();
  });
});

describe("workItemUrl", () => {
  it("builds the edit URL the links panel already matches on", () => {
    // extractLinks looks for `_workitems/edit/<digits>`. Anything else is
    // dropped silently, so the shape is the contract.
    expect(workItemUrl(41, TARGET))
      .toBe("https://dev.azure.com/Scyne-AI-Lab/Scyne%20AI%20Project/_workitems/edit/41");
  });

  it("refuses an id that is not a number", () => {
    // `adoId` is written back by an agent or by ado-workitems.mjs. A stray
    // string would render as a link to nothing.
    expect(workItemUrl("not-an-id", TARGET)).toBeNull();
    expect(workItemUrl(null, TARGET)).toBeNull();
  });
});

describe("artefactKeysFor", () => {
  it("maps a stage to the key it is recorded under", () => {
    expect(artefactKeysFor("datamodel", "Appeals")).toEqual(["Appeals/datamodel"]);
    expect(artefactKeysFor("capabilities")).toEqual(["capabilities"]);
  });

  it("reads a revise and a republish as the SAME stage", () => {
    // They are variants, not stages — `variantOf` says so on the workflow. A
    // revision publishes to the page the generate run created, so it must
    // resolve to the same record or a revised document announces no link.
    expect(artefactKeysFor("revise-datamodel", "Appeals")).toEqual(["Appeals/datamodel"]);
    expect(artefactKeysFor("publish-requirements", "Appeals")).toEqual(["Appeals/requirements"]);
  });

  it("covers both halves of the baseline, because it runs both", () => {
    expect(artefactKeysFor("baseline")).toEqual(["capabilities", "personas"]);
  });

  it("gives a stage that publishes nothing no keys at all", () => {
    // The UI mockups and the companion app are local artefacts. Offering a
    // wiki link for them would be a link to a page that does not exist.
    expect(artefactKeysFor("ui", "Appeals")).toEqual([]);
    expect(artefactKeysFor("app")).toEqual([]);
  });

  it("returns nothing for a workflow key it does not know", () => {
    expect(artefactKeysFor("not-a-workflow", "Appeals")).toEqual([]);
  });
});

describe("mergeLinks", () => {
  it("keeps both sources and drops the duplicates", () => {
    // Not "disk wins": a URL someone pasted into a comment is still a link
    // worth showing, and the comment set was the only one there was until now.
    const merged = mergeLinks(
      { confluence: ["a"], jira: ["1"] },
      { confluence: ["a", "b"], jira: ["2"] });
    expect(merged).toEqual({ confluence: ["a", "b"], jira: ["1", "2"] });
  });
});

describe("publishedLinks", () => {
  let ws: string;

  beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "scyne-links-"));
    const proj = path.join(ws, "projects", "RTWSA");
    await fs.mkdir(path.join(proj, "Appeals", "outputs"), { recursive: true });
    await fs.writeFile(path.join(proj, ".published.json"), JSON.stringify({
      adoTarget: TARGET,
      ado: {
        capabilities: { wikiPath: "/Capability & Process Map", url: "https://dev.azure.com/cap" },
        "Appeals/requirements": { wikiPath: "/Appeals/Product Summary" },
        "Appeals/datamodel": { wikiPath: "/Appeals/Salesforce Data Model" },
      },
    }));
    await fs.writeFile(path.join(proj, "Appeals", "outputs", "stories.json"), JSON.stringify([
      { adoId: 41, fields: { summary: "one" } },
      { fields: { adoId: 42, summary: "two" } },
      { fields: { summary: "never pushed" } },
    ]));
  });

  afterAll(async () => { await fs.rm(ws, { recursive: true, force: true }); });

  it("returns the wiki page for the stage that just ran", async () => {
    const links = await publishedLinks(ws, { project: "RTWSA", feature: "Appeals", workflowKey: "datamodel" });
    expect(links.confluence).toEqual([
      "https://dev.azure.com/Scyne-AI-Lab/Scyne%20AI%20Project/_wiki/wikis/Scyne-AI-Project-Wiki" +
      "?pagePath=%2FAppeals%2FSalesforce%20Data%20Model",
    ]);
    expect(links.jira).toEqual([]);
  });

  it("does not announce another stage's page", async () => {
    // The chat announces links the first time it SEES them, so returning every
    // artefact the project has ever published would dump the whole back
    // catalogue into the transcript on the first poll of any run.
    const links = await publishedLinks(ws, { project: "RTWSA", feature: "Appeals", workflowKey: "datamodel" });
    expect(links.confluence.join(" ")).not.toContain("Capability");
  });

  it("adds the work items for the requirements stage, and only that stage", async () => {
    const links = await publishedLinks(ws, { project: "RTWSA", feature: "Appeals", workflowKey: "requirements" });
    expect(links.jira).toEqual([
      "https://dev.azure.com/Scyne-AI-Lab/Scyne%20AI%20Project/_workitems/edit/41",
      "https://dev.azure.com/Scyne-AI-Lab/Scyne%20AI%20Project/_workitems/edit/42",
    ]);
    expect(links.confluence).toHaveLength(1);
  });

  it("reads a project-level stage with no feature", async () => {
    const links = await publishedLinks(ws, { project: "RTWSA", workflowKey: "capabilities" });
    expect(links.confluence).toEqual(["https://dev.azure.com/cap"]);
  });

  it("is empty, never throwing, for a stage that has not published", async () => {
    const links = await publishedLinks(ws, { project: "RTWSA", feature: "Appeals", workflowKey: "qa" });
    expect(links).toEqual({ confluence: [], jira: [] });
  });

  it("is empty for a project that has no .published.json at all", async () => {
    // A run in flight, or a project whose Azure DevOps step failed in the
    // wizard. Neither is an error worth failing a status poll over.
    const links = await publishedLinks(ws, { project: "Nope", workflowKey: "capabilities" });
    expect(links).toEqual({ confluence: [], jira: [] });
  });
});
