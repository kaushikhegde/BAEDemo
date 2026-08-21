// `scripts/convert-to-md.mjs` is plain JavaScript, for the same reason
// `pipeline.mjs` is: it is shared by `stage.mjs`, both upload routes and this
// server's document gates, and a build step added to satisfy one consumer's
// type checker would undo that. So the shape is declared here.
//
// Only what this server imports is declared. Unlike pipeline.d.ts, which had
// to be COMPLETE because it declares the whole module for every consumer, this
// one is imported at exactly one site — but the same rule applies to whatever
// it does declare: a wrong shape here is silence, not an error.

declare module "*/scripts/convert-to-md.mjs" {
  /** `.docx`, `.pdf`, `.xlsx`, … — sources the converter turns into markdown. */
  export const CONVERTIBLE: Set<string>;
  /** `.txt` — already text, copied across under a `.md` name. */
  export const PLAIN_TEXT: Set<string>;
  /** `.md`, `.markdown`. */
  export const ALREADY_MD: Set<string>;
  /**
   * Every extension a stage can read once step 0 has run — the union of the
   * three above. What the 409 document gates count.
   */
  export const READABLE_AFTER_CONVERSION: Set<string>;
}
