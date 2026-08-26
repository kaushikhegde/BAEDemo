// `scripts/extract-state.mjs` is plain JavaScript, for the same reason
// `pipeline.mjs` is: it is shared by `extract-documents.mjs`,
// `validate-extracts.mjs` and this server's document gates, and a build step
// added to satisfy one consumer's type checker would undo that.
//
// Only what this server imports is declared — `projectState`, the one
// function `extractionGate` and `/api/extract-status/:project` read.

declare module "*/scripts/extract-state.mjs" {
  export interface DocumentExtractState {
    /** Path relative to the document's own level root (project or feature). */
    docId: string;
    /** `"project"` for projects/<p>/documents/, or the feature folder name. */
    scope: string;
    state: "ready" | "missing" | "failed" | "extracting";
    reason?: string;
    /** Present only on a `failed` document, from its `.extract.failed.json`. */
    attempts?: number;
    firstFailedAt?: string;
    lastFailedAt?: string;
    extractPath: string;
  }

  export interface ProjectExtractState {
    ready: number;
    missing: number;
    failed: number;
    extracting: number;
    documents: DocumentExtractState[];
  }

  export function projectState(workspaceRoot: string, project: string): Promise<ProjectExtractState>;
}
