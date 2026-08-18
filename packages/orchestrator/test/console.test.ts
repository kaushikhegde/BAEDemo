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

  it("routes to a detail view for every drillable entity", () => {
    // The Issues tab used to be able to tell you an issue was blocked but never
    // why: #issue/<id> was never routed and renderBundle was called but never
    // defined, so the agent Instructions link threw.
    for (const route of ["run/", "issue/", "bundle/", "agent/"]) {
      expect(html, `no route for #${route}`).toContain(`hash.indexOf("${route}") === 0`);
    }
    for (const fn of ["renderIssue", "renderBundle", "renderRun", "renderAgent"]) {
      expect(html, `${fn} is routed to but not defined`).toContain(`async function ${fn}(`);
    }
  });

  it("can start a run, and builds the form from the workflow's declared params", () => {
    expect(html).toContain('id="newrun"');
    expect(html).toContain("async function newRunModal(");
    expect(html).toContain('send("/issues", "POST"');
    expect(html).toContain("w.params");
  });

  it("uses inline SVG for nav icons, never emoji", () => {
    // Emoji are font-dependent, render differently per platform and cannot be
    // themed. Every nav item carries a real vector glyph.
    expect(html).toContain('<svg class="ic"');
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("pairs every status colour with its word, so colour is never the only carrier", () => {
    // st() prints the state name next to the dot; the dot alone would fail
    // WCAG 1.4.1 and would be unreadable to anyone who does not already know
    // the palette.
    expect(html).toContain('.replace(/_/g, " ")');
  });

  it("keeps a visible focus ring on everything focusable", () => {
    expect(html).toContain("a:focus-visible, button:focus-visible");
    expect(html).not.toMatch(/outline:\s*(none|0)\s*;?\s*}/);
  });

  it("respects prefers-reduced-motion for its only animation", () => {
    expect(html).toContain("prefers-reduced-motion: no-preference");
  });

  it("scrolls wide content inside its own container, not the page", () => {
    // A twelve-agent org chart is wider than any viewport; the page body must
    // never scroll sideways to accommodate it.
    expect(html).toContain(".chartwrap { overflow-x: auto");
    expect(html).toContain(".scroll-x { overflow-x: auto; }");
  });

  it("has exactly one poll timer and clears it on every route change", () => {
    // Leaving a live transcript and navigating away used to be the way to leak
    // a second poller; route() clears first, unconditionally.
    expect(html).toContain("async function route() {\n  stopPolling();");
  });

  it("never uses a raw semantic colour as text, so light mode stays readable", () => {
    // The brand palette is tuned for a dark ground. Measured against white,
    // --accent is 2.25:1, --success 2.54:1, --danger 3.67:1 and --info 3.68:1 —
    // all below the 4.5:1 floor. Text usages therefore go through an --on-*
    // token, darkened for light and restored to the raw colour under dark.
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    for (const token of ["accent", "success", "danger", "info"]) {
      expect(css, `--on-${token} is not defined`).toContain(`--on-${token}`);
      // `color: var(--danger)` as a bare declaration is the regression.
      // Anchored so `border-color: var(--danger)` — a border, which is not
      // text and needs only 3:1 — is not mistaken for a text declaration.
      const bare = new RegExp(`(^|[;{\\s])color:\\s*var\\(--${token}\\)`, "m");
      expect(bare.test(css), `a raw var(--${token}) is used as text colour`).toBe(false);
    }
    // Dark mode must put the undarkened values back, or the chips go muddy.
    const dark = css.slice(css.indexOf("prefers-color-scheme: dark"));
    expect(dark).toContain("--on-accent: var(--accent)");
    expect(dark).toContain("--on-danger: var(--danger)");
  });
});
