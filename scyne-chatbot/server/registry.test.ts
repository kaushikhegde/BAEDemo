import { describe, it, expect } from "vitest";
import { pickRegistryEntry } from "./registry.js";

/**
 * The UI tab asks `/api/preview/:project` whether a companion app exists, and
 * that answer came from `generated-apps/registry.json` on the install's disk.
 * The app stage runs in a scratch tree and harvests into the DOCUMENT STORE, so
 * BAE's app was built, stored and served (`/api/companion-app/BAE/` → 200)
 * while the tab said "No companion app for BAE yet".
 */
const reg = (o: Record<string, unknown>) => JSON.stringify(o);

describe("pickRegistryEntry", () => {
  it("finds the entry in the stored registry when the disk copy is empty", () => {
    const got = pickRegistryEntry(reg({ BAE: { htmlPath: "generated-apps/BAE/index.html" } }), "{}", "BAE");
    expect(got).toEqual({ error: null, entry: { htmlPath: "generated-apps/BAE/index.html" } });
  });

  it("prefers the stored entry over a stale disk one", () => {
    const got = pickRegistryEntry(reg({ BAE: { generatedAt: "new" } }), reg({ BAE: { generatedAt: "old" } }), "BAE");
    expect(got.entry).toEqual({ generatedAt: "new" });
  });

  it("falls back to disk when the store has no registry", () => {
    const got = pickRegistryEntry(null, reg({ BAE: { generatedAt: "disk" } }), "BAE");
    expect(got.entry).toEqual({ generatedAt: "disk" });
  });

  it("reports no_entry when neither has the project", () => {
    expect(pickRegistryEntry(reg({ OTHER: {} }), "{}", "BAE")).toEqual({ error: "no_entry", entry: null });
  });

  it("reports no_registry when neither copy exists or parses", () => {
    expect(pickRegistryEntry(null, null, "BAE")).toEqual({ error: "no_registry", entry: null });
    expect(pickRegistryEntry("not json", null, "BAE")).toEqual({ error: "no_registry", entry: null });
  });
});
