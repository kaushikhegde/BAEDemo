// The file pickers must offer exactly what the converter can read.
//
// The browser bundle cannot import `scripts/convert-to-md.mjs` — it pulls in
// `node:fs` and `node:module` — so DOC_ACCEPT is a literal, and a literal
// copy of somebody else's list is a copy that drifts. It already had: the Docs
// tab offered `.pptx`, `.xls` and `.csv` when the converter could read none of
// them, while the chat attach button offered no PowerPoint at all. A client's
// deck was uploadable or not depending on which screen you were on.
//
// This test is the seam. It runs in node, where both sides can be imported.

import { describe, expect, it } from "vitest";
import { CONVERTIBLE, PLAIN_TEXT, ALREADY_MD } from "../../../scripts/convert-to-md.mjs";
import { DOC_ACCEPT, AUDIO_ACCEPT, IMAGE_ACCEPT } from "./uploadFormats";

const offered = new Set(DOC_ACCEPT.split(","));
const readable = new Set<string>([...CONVERTIBLE, ...PLAIN_TEXT, ...ALREADY_MD]);

describe("DOC_ACCEPT", () => {
  // Both directions, because the copy that was here had drifted both ways.
  it("offers every format the converter can read", () => {
    expect([...readable].filter(e => !offered.has(e)).sort()).toEqual([]);
  });

  it("offers nothing the converter cannot read", () => {
    expect([...offered].filter(e => !readable.has(e)).sort()).toEqual([]);
  });

  it("keeps images and audio out of the document list — they have their own paths", () => {
    for (const ext of [...IMAGE_ACCEPT.split(","), ...AUDIO_ACCEPT.split(",")]) {
      expect([ext, offered.has(ext)]).toEqual([ext, false]);
    }
  });

  it("includes PowerPoint, which is the format that started all this", () => {
    expect(offered.has(".pptx")).toBe(true);
  });
});
