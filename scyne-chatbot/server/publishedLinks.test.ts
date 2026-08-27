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
import {
  wikiUrl, workItemUrl, confluenceUrl, jiraUrl, artefactKeysFor, mergeLinks, publishedLinks,
} from "./publishedLinks.js";

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
      { wiki: ["a"], workItems: ["1"] },
      { wiki: ["a", "b"], workItems: ["2"] });
    expect(merged).toEqual({ wiki: ["a", "b"], workItems: ["1", "2"] });
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
    expect(links.wiki).toEqual([
      "https://dev.azure.com/Scyne-AI-Lab/Scyne%20AI%20Project/_wiki/wikis/Scyne-AI-Project-Wiki" +
      "?pagePath=%2FAppeals%2FSalesforce%20Data%20Model",
    ]);
    expect(links.workItems).toEqual([]);
  });

  it("does not announce another stage's page", async () => {
    // The chat announces links the first time it SEES them, so returning every
    // artefact the project has ever published would dump the whole back
    // catalogue into the transcript on the first poll of any run.
    const links = await publishedLinks(ws, { project: "RTWSA", feature: "Appeals", workflowKey: "datamodel" });
    expect(links.wiki.join(" ")).not.toContain("Capability");
  });

  it("adds the work items for the requirements stage, and only that stage", async () => {
    const links = await publishedLinks(ws, { project: "RTWSA", feature: "Appeals", workflowKey: "requirements" });
    expect(links.workItems).toEqual([
      "https://dev.azure.com/Scyne-AI-Lab/Scyne%20AI%20Project/_workitems/edit/41",
      "https://dev.azure.com/Scyne-AI-Lab/Scyne%20AI%20Project/_workitems/edit/42",
    ]);
    expect(links.wiki).toHaveLength(1);
  });

  it("reads a project-level stage with no feature", async () => {
    const links = await publishedLinks(ws, { project: "RTWSA", workflowKey: "capabilities" });
    expect(links.wiki).toEqual(["https://dev.azure.com/cap"]);
  });

  it("is empty, never throwing, for a stage that has not published", async () => {
    const links = await publishedLinks(ws, { project: "RTWSA", feature: "Appeals", workflowKey: "qa" });
    expect(links).toEqual({ wiki: [], workItems: [] });
  });

  it("is empty for a project that has no .published.json at all", async () => {
    // A run in flight, or a project whose Azure DevOps step failed in the
    // wizard. Neither is an error worth failing a status poll over.
    const links = await publishedLinks(ws, { project: "Nope", workflowKey: "capabilities" });
    expect(links).toEqual({ wiki: [], workItems: [] });
  });
});

// ---------------------------------------------------------------------------
// The Atlassian half. Publishing has two live back ends — Confluence + Jira,
// and the Azure DevOps wiki + work items — and the wire keys stay `wiki` /
// `workItems` for BOTH. Renaming the wire format in the same change as moving
// what fills it is how this panel went empty the first time; doing it again,
// back the other way, would be the same mistake with more history behind it.
// ---------------------------------------------------------------------------

describe("confluenceUrl", () => {
  const target = { site: "https://acme.atlassian.net", space: "SAPN" };

  it("prefers the recorded url over rebuilding one", () => {
    // `confluence-publish.mjs` writes the URL it actually used. Rebuilding over
    // the top of it is how a page published into a renamed space acquires a
    // link that 404s.
    expect(confluenceUrl({ url: "https://acme.atlassian.net/wiki/x", pageId: "9" }, target))
      .toBe("https://acme.atlassian.net/wiki/x");
  });

  it("rebuilds from a pageId when no url was recorded", () => {
    // The fallback for a record written by hand after an MCP call, which
    // carries the id but not the URL.
    expect(confluenceUrl({ pageId: "27230209", space: "SAPN" }, target))
      .toBe("https://acme.atlassian.net/wiki/spaces/SAPN/pages/27230209");
  });

  it("tolerates a trailing slash on the site", () => {
    expect(confluenceUrl({ pageId: "1" }, { site: "https://acme.atlassian.net/", space: "S" }))
      .toBe("https://acme.atlassian.net/wiki/spaces/S/pages/1");
  });

  it("returns null rather than a broken link when it cannot build one", () => {
    expect(confluenceUrl(null, target)).toBeNull();
    expect(confluenceUrl({ pageId: "1" }, null)).toBeNull();
    expect(confluenceUrl({ space: "S" }, target)).toBeNull();
  });
});

describe("jiraUrl", () => {
  const target = { site: "https://acme.atlassian.net" };

  it("builds a browse link from an issue key", () => {
    expect(jiraUrl("SAPN-42", target)).toBe("https://acme.atlassian.net/browse/SAPN-42");
  });

  it("refuses anything that is not an issue key", () => {
    // This ends up in an href a client clicks, and stories.json is written by
    // an agent — so the shape is validated rather than interpolated blindly.
    for (const bad of ["", "42", "sapn-42", "SAPN", "SAPN-", "../../evil", null, undefined, 42]) {
      expect(jiraUrl(bad as unknown, target), String(bad)).toBeNull();
    }
  });

  it("returns null with no site rather than a relative link", () => {
    expect(jiraUrl("SAPN-42", {})).toBeNull();
  });
});

describe("publishedLinks — Atlassian", () => {
  let ws: string;

  beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "atl-links-"));
    const proj = path.join(ws, "projects", "ATL");
    await fs.mkdir(path.join(proj, "Appeals", "outputs"), { recursive: true });
    await fs.writeFile(path.join(proj, ".published.json"), JSON.stringify({
      atlassianTarget: { site: "https://acme.atlassian.net", space: "ATL", jiraProject: "ATL" },
      atlassian: {
        capabilities: {
          pageId: "111", title: "Capability & Process Map", space: "ATL",
          url: "https://acme.atlassian.net/wiki/spaces/ATL/pages/111",
        },
        "Appeals/requirements": {
          pageId: "222", title: "Appeals — Requirements & Product Summary", space: "ATL",
          url: "https://acme.atlassian.net/wiki/spaces/ATL/pages/222",
        },
      },
    }));
    await fs.writeFile(path.join(proj, "Appeals", "outputs", "stories.json"), JSON.stringify([
      { fields: { summary: "one" }, jiraKey: "ATL-1" },
      { fields: { summary: "two" }, jiraKey: "ATL-2" },
    ]));
  });

  afterAll(async () => { await fs.rm(ws, { recursive: true, force: true }); });

  it("returns a Confluence page under the `wiki` key", async () => {
    const links = await publishedLinks(ws, { project: "ATL", workflowKey: "capabilities" });
    expect(links.wiki).toEqual(["https://acme.atlassian.net/wiki/spaces/ATL/pages/111"]);
    expect(links.workItems).toEqual([]);
  });

  it("returns Jira issues under the `workItems` key, for requirements only", async () => {
    const links = await publishedLinks(ws, {
      project: "ATL", feature: "Appeals", workflowKey: "requirements",
    });
    expect(links.wiki).toEqual(["https://acme.atlassian.net/wiki/spaces/ATL/pages/222"]);
    expect(links.workItems).toEqual([
      "https://acme.atlassian.net/browse/ATL-1",
      "https://acme.atlassian.net/browse/ATL-2",
    ]);
  });

  it("carries a revision through the same keys as its stage", async () => {
    const links = await publishedLinks(ws, { project: "ATL", workflowKey: "revise-capabilities" });
    expect(links.wiki).toEqual(["https://acme.atlassian.net/wiki/spaces/ATL/pages/111"]);
  });
});
