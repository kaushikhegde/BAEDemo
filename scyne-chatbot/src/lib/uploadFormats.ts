// What a file picker offers, in one place.
//
// These strings were written out three times — twice in AttachmentButton's
// zones and once in DocumentsView — and had already drifted apart: the Docs
// tab offered `.pptx`, `.xls` and `.csv` while the chat attach button offered
// none of them, so whether a client's deck could be uploaded at all depended
// on which screen you happened to be looking at.
//
// DOC_ACCEPT must stay equal to what `scripts/convert-to-md.mjs` can actually
// read. It cannot IMPORT that module — the converter pulls in `node:fs` and
// `node:module`, which do not belong in a browser bundle — so the two are
// pinned together by `uploadFormats.test.ts` instead, in both directions. A
// format added to the converter fails that test until it is offered here.
export const DOC_ACCEPT = [
  // markitdown-ts
  ".docx", ".doc", ".pdf", ".xlsx", ".html", ".htm", ".xml", ".ipynb",
  // @firecrawl/anydoc
  ".pptx", ".ppt", ".pptm", ".ppsx", ".pps", ".pot", ".ppsm",
  ".odt", ".ods", ".odp",
  ".xls", ".xlsm", ".xlsb", ".docm",
  ".rtf", ".epub", ".csv",
  // already text
  ".txt", ".md", ".markdown",
].join(",");

/** Transcribed by Gemini on the way in, never converted to markdown. */
export const AUDIO_ACCEPT = ".mp3,.wav,.m4a,.webm,.ogg,.flac";

/** Read as images by the agents — a markdown rendering would lose the point. */
export const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";
