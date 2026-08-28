// The Docs tab's list, assembled from the STORE.
//
// `documents.ts` beside this walks disk, and that is still the right thing to
// do inside a materialised tree during a run — the files really are there. It
// is not the right thing to do for the tab. Documents live in the store now:
// `projects/<p>/` is a scratch surface the engine creates per step and deletes
// after, so outside a run there is nothing on disk to walk, and a list built
// from that walk reports an empty project. SA-DEMO measured it — nine documents
// in the store, `projects/SA-DEMO/` absent entirely, "0 documents" on screen.
//
// The disk walk is kept, INVERTED: it no longer answers "what exists", it
// reports files that have no row. That is the same safety net the old route had
// pointing the other way (`inDb`), and it is worth keeping — a file that landed
// outside the upload routes is invisible to every platform surface, and this
// installation has already been measured at 20 documents on disk against 2
// rows.
//
// Everything here is PURE. The I/O lives in the route; these are the decisions,
// so they can be tested without a store, a disk or a running orchestrator.

import path from "node:path";
import { kindOf, DISCOVERY_SUBFOLDERS, type DocumentEntry } from "./documents.js";
import type { DocumentExtractState } from "../../../scripts/extract-state.mjs";

/** One document row as the platform API returns it. */
export interface StoreDocument {
  /** Relative to the document's own LEVEL root, as `produces[]` names things. */
  path: string;
  /** null means the document belongs to the project itself, not to a feature. */
  feature: string | null;
  bytes: number;
  /** When this VERSION was written. A document is never edited in place. */
  createdAt: string;
  version: number;
  category: string | null;
}

/**
 * Is this row a DISCOVERY document, or something the pipeline generated?
 *
 * The disk walk got this for free by only ever reading two places —
 * `documents/` at project level, `requirements/<sub>/` at feature level. The
 * store holds everything a project owns, so listing it whole puts every
 * generated artefact in the tab beside the client's own material: SA-DEMO
 * would show its seven `solutions/Extracts/*.extract.json` files alongside its
 * nine documents.
 *
 * Level matters, not just prefix. A row carries only its path, and
 * `documents/x.md` is a project document and not a feature one — without the
 * level a feature would list its project's material as its own.
 *
 * `original-files/` is excluded for the reason `SKIP_DIRS` excludes it: it
 * holds the `.pdf` a document was converted FROM, and counting those makes
 * every converted document appear twice.
 */
export const isDiscoveryDocument = (docPath: string, feature: string | null): boolean => {
  const parts = docPath.split("/");
  if (parts.includes("original-files")) return false;
  return feature
    ? parts.length >= 3 && parts[0] === "requirements"
      && (DISCOVERY_SUBFOLDERS as readonly string[]).includes(parts[1])
    : parts.length >= 2 && parts[0] === "documents";
};

/**
 * A store row as the tab's entry.
 *
 * The subfolder is derived from the path rather than passed in, which is the
 * one real difference from the disk walk: `readFolder` knew the folder because
 * it was told which one to read, and a row carries only its path. The tab
 * groups by subfolder, so getting this wrong files every SOP under Transcripts.
 */
export const entryFromStoreRow = (d: StoreDocument): DocumentEntry => {
  const name = path.basename(d.path);
  const dir = path.dirname(d.path);
  return {
    name,
    path: d.path,
    // `documents` at project level; `SOP` / `Transcripts` / `Notes` / `UI` at
    // feature level, which is the last segment either way.
    subfolder: dir === "." ? "" : path.basename(dir),
    level: d.feature ? "feature" : "project",
    feature: d.feature,
    bytes: d.bytes,
    modifiedAt: d.createdAt,
    kind: kindOf(name),
    // Genuinely unknowable from a row. The upload source is archived in S3
    // under its job id, not in `original-files/`, so there is no name to give.
    // Deriving `Introduction.pdf` from `Introduction.md` would send somebody
    // looking for a file that may never have existed.
    original: null,
    version: d.version,
    inDb: true,
  };
};

/** Two documents are the same document only if they share a LEVEL as well as a
 *  path — two features can each hold `requirements/SOP/Onboarding.md`. */
const keyOf = (d: DocumentEntry): string => `${d.feature ?? ""}::${d.path}`;

/**
 * The store's list, plus any disk file that has no row.
 *
 * The store wins a collision: disk inside a leftover scratch tree can be stale,
 * and the row is the record. A disk-only entry keeps `inDb: false`, which is
 * the flag the tab already renders as a fault.
 */
export const mergeDocumentSources = (
  store: DocumentEntry[], disk: DocumentEntry[],
): DocumentEntry[] => {
  const out = new Map<string, DocumentEntry>();
  for (const d of disk) out.set(keyOf(d), { ...d, inDb: false });
  // Second, so it overwrites.
  for (const d of store) out.set(keyOf(d), { ...d, inDb: true });
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
};

/**
 * Did a delete actually remove anything?
 *
 * Both stores are asked, and either alone is enough. The route used to bail
 * with 404 the moment the DISK delete found nothing, before it ever reached the
 * row — so a document that lives only in the store, which is now every
 * document, could not be deleted at all. It reported "No document at
 * documents/ARC-CX-014_….md" while the tab listed that exact document one row
 * above the message.
 *
 * A store row with no retrievable bytes still deletes. That is the case worth
 * getting right: those are precisely the documents somebody wants rid of, and
 * refusing because the content cannot be fetched would strand them for ever.
 */
export const deleteOutcome = (
  onDisk: boolean, rowState: "created" | "exists" | "skipped" | "failed",
): { removed: boolean; reason: string | null } => {
  // `created` is this codebase's word for "the write happened" — here, that the
  // row was retired.
  if (rowState === "created" || onDisk) return { removed: true, reason: null };
  if (rowState === "failed") return { removed: false, reason: "the database refused the delete" };
  if (rowState === "skipped") return { removed: false, reason: "not signed in, and it is not on disk" };
  return { removed: false, reason: null };
};

/**
 * Each document's extraction progress, on its own card.
 *
 * A document is not USABLE until it has been extracted — `capabilities`
 * hard-requires every one of them and refuses `documents_not_ready` otherwise —
 * so "uploaded" and "ready" are different states and the tab has to show which
 * is which. Before this, the only way to learn that was a separate
 * `extract_status` call, and the only way to learn WHY one failed was to open
 * its `.extract.failed.json` by hand.
 *
 * A document with no state is `missing`, not undefined: "uploaded, not yet
 * extracted" is the normal state for the first minute after an upload and the
 * one every stage gate refuses on. A card with no badge reads as "nothing to do
 * here", which is the opposite of true.
 */
export const attachExtractState = (
  entries: DocumentEntry[], states: readonly DocumentExtractState[],
): DocumentEntry[] => {
  const by = new Map(states.map((s) => [`${s.scope}/${s.docId}`, s]));
  return entries.map((e) => {
    // Only markdown is extracted. Badging a PNG `missing` invites a retry that
    // can never succeed.
    if (e.kind !== "markdown") return e;
    const hit = by.get(`${e.feature ?? "project"}/${e.path}`);
    return {
      ...e,
      extract: hit
        ? {
            state: hit.state,
            ...(hit.reason ? { reason: hit.reason } : {}),
            ...(hit.attempts ? { attempts: hit.attempts } : {}),
            ...(hit.firstFailedAt ? { firstFailedAt: hit.firstFailedAt } : {}),
            ...(hit.lastFailedAt ? { lastFailedAt: hit.lastFailedAt } : {}),
          }
        : { state: "missing" as const },
    };
  });
};
