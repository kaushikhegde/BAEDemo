// `scripts/lib/extract-schema.mjs` is plain JavaScript for the same reason
// `pipeline.mjs` and `extract-state.mjs` are: it is shared by
// `extract-documents.mjs`, `validate-extracts.mjs` and this server, and a
// build step added to satisfy one consumer's type checker would undo that.
//
// Only `validateExtract` is declared — the one function this server calls, to
// keep a malformed extract from being reported `ready`.

declare module "*/scripts/lib/extract-schema.mjs" {
  export type ExtractValidation =
    | { ok: true; errors: [] }
    | { ok: false; errors: string[] };

  export function validateExtract(obj: unknown): ExtractValidation;
}
