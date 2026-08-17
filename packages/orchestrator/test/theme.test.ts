import { describe, it, expect } from "vitest";
import { SCYNE_THEME, resolveTheme, themeCss } from "../src/http/theme.js";

describe("theme", () => {
  it("defaults to the Scyne palette", () => {
    expect(resolveTheme().brand).toBe("#464E7E");
    expect(resolveTheme().logoText).toBe("Scyne Orchestrator");
  });

  it("merges a partial override without dropping the rest", () => {
    const t = resolveTheme({ brand: "#1f4c71", logoText: "Acme Delivery" });
    expect(t.brand).toBe("#1f4c71");
    expect(t.logoText).toBe("Acme Delivery");
    expect(t.accent).toBe(SCYNE_THEME.accent);   // untouched
    expect(t.fontFamily).toBe(SCYNE_THEME.fontFamily);
  });

  it("emits kebab-case custom properties for every colour token", () => {
    const css = themeCss(resolveTheme());
    expect(css).toContain("--brand: #464E7E;");
    expect(css).toContain("--brand-deep: #363C63;");
    expect(css).toContain("--ink-500: #5C6593;");
    expect(css).not.toContain("--logo-text");   // not a colour
  });

  it("defines both light and dark explicitly", () => {
    const css = themeCss(resolveTheme());
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css.match(/--bg:/g)?.length).toBe(2);   // light and dark
  });

  it("references no external resource", () => {
    const css = themeCss(resolveTheme());
    expect(css).not.toMatch(/@import|https?:\/\/|url\(/);
  });
});
