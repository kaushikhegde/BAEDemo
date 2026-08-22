/**
 * Labels for the published-links card.
 *
 * Both `LinksPanel` and `HistoryView` render the same two link kinds and each
 * carried its own byte-identical copy of the page-title helper — so the bug
 * below existed twice and would have been fixed twice.
 *
 * The wire keys they render are `links.wiki` / `links.workItems`, naming what
 * they hold. A transcript stored before that rename still carries the old keys,
 * which `migrateLinkKeys` in App.tsx maps on read.
 */

/**
 * The page title behind a wiki URL.
 *
 * An Azure DevOps wiki page is
 * `…/_wiki/wikis/<WikiName>?pagePath=<encoded /Feature/Page>` — the title is in
 * the QUERY STRING, and the last path segment is the name of the wiki itself.
 * Reading the path alone therefore labelled every link with the same wiki name
 * ("SA-Power-Networks-Transformation.wiki") no matter which page it opened, so
 * a project with five published artefacts showed five identical buttons.
 *
 * The path segment stays as the fallback: a record written before `wikiUrl`
 * added `pagePath`, or a link pasted into a comment by hand, still has to
 * render as something better than the raw URL.
 */
export function prettyWikiPage(u: string): string {
  try {
    const url = new URL(u);
    const pagePath = url.searchParams.get("pagePath");
    const segment = pagePath
      ? pagePath.split("/").filter(Boolean).pop()
      : url.pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(segment ?? url.hostname).replace(/[+]/g, " ");
  } catch {
    return u;
  }
}

/**
 * The id shown on a work item badge — the trailing digits of
 * `…/_workitems/edit/<id>`, which `workItemUrl` guarantees is the last segment.
 */
export function workItemId(u: string): string {
  return u.split("/").pop() || u;
}
