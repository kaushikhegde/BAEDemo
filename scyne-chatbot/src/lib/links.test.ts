import { describe, it, expect } from "vitest";
import { prettyWikiPage, workItemId } from "./links";

const WIKI = "https://dev.azure.com/Scyne-AI-Lab/SA-Power-Networks-Transformation/_wiki/wikis";

describe("prettyWikiPage", () => {
  it("names the PAGE, not the wiki", () => {
    // The bug this exists for: reading the last path segment gave the wiki's
    // own name, so every artefact's button read the same thing.
    expect(prettyWikiPage(
      `${WIKI}/SA-Power-Networks-Transformation.wiki?pagePath=%2FCapability%20%26%20Process%20Map`))
      .toBe("Capability & Process Map");
  });

  it("takes the last segment of a nested feature page", () => {
    expect(prettyWikiPage(
      `${WIKI}/SAPN.wiki?pagePath=%2FAppeals%2FSalesforce%20Data%20Model`))
      .toBe("Salesforce Data Model");
  });

  it("tells two artefacts of one project apart", () => {
    const a = prettyWikiPage(`${WIKI}/SAPN.wiki?pagePath=%2FCapability%20%26%20Process%20Map`);
    const b = prettyWikiPage(`${WIKI}/SAPN.wiki?pagePath=%2FPersonas%20%26%20Journeys`);
    expect(a).not.toBe(b);
  });

  it("falls back to the path when there is no pagePath", () => {
    // A link pasted into a comment by hand, or a record written before
    // `wikiUrl` carried the query string.
    expect(prettyWikiPage(`${WIKI}/SAPN.wiki`)).toBe("SAPN.wiki");
  });

  it("returns a non-URL unchanged rather than throwing", () => {
    expect(prettyWikiPage("not a url")).toBe("not a url");
  });
});

describe("workItemId", () => {
  it("reads the trailing id", () => {
    expect(workItemId("https://dev.azure.com/org/proj/_workitems/edit/1234")).toBe("1234");
  });

  it("falls back to the whole string when there is no segment", () => {
    expect(workItemId("")).toBe("");
  });
});
