import { describe, it, expect } from "vitest";
import { renderConsole } from "../src/http/console.js";
import { resolveTheme } from "../src/http/theme.js";

const html = renderConsole(resolveTheme());

describe("console", () => {
  it("is a complete, self-contained HTML document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  it("makes no external requests", () => {
    // The same rule render-companion-app.mjs follows: a console that needs the
    // network is useless on a client's laptop, and a CDN version bump is a
    // silent visual regression nobody attributes to a CDN.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
  });

  it("carries the theme's brand colour and every tab", () => {
    expect(html).toContain(resolveTheme().brand);
    for (const tab of ["Runs", "Issues", "Gates", "Org", "Budgets", "Config", "Health"]) {
      expect(html, `missing tab ${tab}`).toContain(`>${tab}</a>`);
    }
  });

  it("defines both light and dark palettes", () => {
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("renders a consumer's rebrand rather than the Scyne default", () => {
    const custom = renderConsole(resolveTheme({ brand: "#1F4C71", logoText: "Acme Delivery" }));
    expect(custom).toContain("#1F4C71");
    expect(custom).toContain("Acme Delivery");
  });
});
