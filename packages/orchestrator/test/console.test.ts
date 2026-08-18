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
    // `http://www.w3.org/2000/svg` is allowed through by name: it is the XML
    // namespace identifier the inline favicon needs to render, and it is never
    // fetched. Everything else that looks like an off-box URL is a failure.
    const external = html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "");
    expect(external).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
  });

  it("carries the theme's brand colour and every tab", () => {
    expect(html).toContain(resolveTheme().brand);
    for (const tab of ["Runs", "Issues", "Gates", "Org", "Budgets", "Config", "Health"]) {
      expect(html, `missing tab ${tab}`).toContain(`>${tab}</a>`);
    }
  });

  it("the browser script actually parses", () => {
    // The real guard. Grepping the HTML for `id="hire"` proves a string is
    // present, not that the page RUNS — a stray apostrophe inside a
    // single-quoted JS string shipped a console that rendered "Loading…" and
    // nothing else, with the failure only visible in the browser's own
    // devtools. `new Function` parses without executing, which is exactly the
    // check that was missing.
    const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
    expect(() => new Function(script)).not.toThrow();
  });

  it("has no nested template literal in the browser script", () => {
    // The whole page is one TypeScript template literal, so a backtick or a
    // dollar-brace inside the browser <script> — comments included — closes it
    // early and gets interpolated at build time against variables that only
    // exist in the browser. It fails as a confusing syntax error hundreds of
    // lines away from the cause. Cost an hour once; pinned here instead.
    const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
    expect(script).not.toContain("`");
    expect(script).not.toMatch(/\$\{/);
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
