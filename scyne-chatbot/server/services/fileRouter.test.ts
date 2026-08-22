// Where an uploaded file lands when nobody said.
//
// The routing rules only ever applied to `.docx`, `.pdf` and `.doc`, so a
// PowerPoint matched no branch and fell out of the catch-all as ambiguous —
// refused with `409 ambiguous_kind` even when its own name said "SOP". DOC_EXT
// now comes from the converter, so every readable format is routed alike.

import { describe, expect, it } from "vitest";
import { routeFile } from "./fileRouter.js";

describe("routeFile", () => {
  it("routes a deck by the same name rules as a Word document", () => {
    expect(routeFile("SOP - Case Handling.pptx").subfolder).toBe("sop");
    expect(routeFile("Kickoff meeting deck.pptx").subfolder).toBe("transcripts");
    expect(routeFile("Q3 policy.odp").subfolder).toBe("sop");
  });

  it("still asks when a document's name says nothing", () => {
    const r = routeFile("Slides for Scyne.pptx");
    expect(r.ambiguous).toBe(true);
    expect(r.subfolder).toBe("notes");
  });

  it("takes an explicit hint over any inference", () => {
    const r = routeFile("Slides for Scyne.pptx", "sop");
    expect([r.subfolder, r.ambiguous]).toEqual(["sop", false]);
  });

  // The paths that are not about documents at all, unchanged.
  it("leaves images, audio and plain text where they were", () => {
    expect(routeFile("wireframe.png").subfolder).toBe("ui");
    expect(routeFile("standup.mp3")).toMatchObject({ subfolder: "transcripts", isAudio: true });
    expect(routeFile("scratch.txt")).toMatchObject({ subfolder: "notes", ambiguous: false });
    expect(routeFile("readme.md")).toMatchObject({ subfolder: "notes", ambiguous: false });
  });
});
