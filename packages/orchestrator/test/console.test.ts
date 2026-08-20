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
    for (const tab of ["Runs", "Issues", "Gates", "Org", "Skills", "Budgets", "Config", "Health"]) {
      expect(html, `missing tab ${tab}`).toContain(`>${tab}</a>`);
    }
  });

  it("uses no class the stylesheet does not define", () => {
    // Every one of these shipped at once on the admin tabs, and they are all
    // the same mistake — markup naming a class that is not what it thinks:
    //
    //   class="grid" on a <table>  — `.grid` is the metric-TILE card grid
    //     (display: grid), so it destroyed table layout entirely: the header
    //     cells and the body cells landed in different tracks and the action
    //     buttons stacked vertically outside the header's background.
    //   class="r" for right-alignment — never defined at all; the console's
    //     right-align is `.num`.
    //   class="orgpick" on a standalone select — defined only as
    //     `.whoami .orgpick`, so it did nothing outside the header.
    //
    // None of them is a syntax error, none fails a render, and the page looks
    // fine until somebody opens the tab.
    const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
    // The markup is BUILT by this script, so every class attribute appears in
    // it as text. Stripping them is what makes the hook test below mean
    // "something selects this" rather than "the attribute exists" — which is
    // true by construction, and would pass anything at all.
    const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"))
      .replace(/class="[^"]*"/g, "");
    const defined = new Set(Array.from(css.matchAll(/\.([a-zA-Z][\w-]*)/g), m => m[1]));

    const used = new Set<string>();
    for (const m of html.matchAll(/class="([^"$'+]+)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) used.add(c);
    }
    expect(used.size).toBeGreaterThan(10);   // the scan found something to check

    // A class may also be a HOOK the browser script selects on and nothing
    // styles — `.x-k`, `.b-cost` and friends on the Config and Budgets tabs
    // are read back with querySelectorAll and never painted. Those are
    // deliberate, so the rule is: styled, or selected, or a mistake.
    // Matched as a SELECTOR or a quoted argument, and terminated: a bare
    // `script.includes("r")` is true of every script ever written, and even
    // `includes(".r")` matches `.role` — so the one-character class that
    // started all this passed both. The name has to END where it ends.
    const hook = (c: string): boolean => {
      const name = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp("\\." + name + "(?![\\w-])").test(script)
          || new RegExp("[\"']" + name + "[\"']").test(script);
    };
    const orphans = [...used].filter(c => !defined.has(c) && !hook(c)).sort();
    expect(orphans, "class(es) neither styled nor selected — a typo").toEqual([]);
  });

  it("declares no function it never calls, and switches organisation for real", () => {
    // `currentOrg()` was declared, documented as "sent as X-Scyne-Org on every
    // request", and never called once — while api(), send() and whoami() all
    // used a bare fetch. So a superadmin could pick another organisation and
    // nothing whatsoever happened: whoami answered for the home org, and
    // renderOrgPicker() rebuilt the select from that answer, snapping the
    // control back to where it started.
    //
    // Comments and string literals are stripped first. The first version of
    // this check passed because a COMMENT elsewhere mentioned the dead
    // function by name, which is precisely the fig leaf it was meant to catch.
    const raw = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, " ")     // block comments
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")  // line comments (not "http://")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')  // double-quoted strings
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''"); // single-quoted strings

    const orphans: string[] = [];
    for (const m of code.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      const uses = [...code.matchAll(new RegExp("\\b" + name + "\\b", "g"))].length;
      if (uses <= 1) orphans.push(name);
    }
    expect(orphans, "function(s) declared and never called").toEqual([]);

    // And the switch itself is wired: the header travels, and both routes into
    // it — the header picker and the Act as button — go through one function.
    expect(raw).toContain("X-Scyne-Org");
    expect([...code.matchAll(/\bactAs\b/g)].length,
      "actAs should be declared once and called from the picker and from Act as").toBe(3);
  });

  it("never puts the card-grid class on a table", () => {
    // Called out separately from the check above, because this one is worse:
    // `.grid` IS defined, so nothing looks wrong until the table renders as a
    // pile of cards.
    expect(html).not.toMatch(/<table[^>]*class="[^"]*\bgrid\b/);
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

  // IMPORTANT 3: the browser script used to sum `cost_usd` with a plain
  // `+ (r.cost_usd || 0)` reduce, so an all-Codex issue (every run's cost_usd
  // is null — Codex does not price its own runs) rendered "$0.0000", the
  // exact "reads as a free run" outcome closingNote (core/engine.ts) was
  // fixed to avoid for the issue timeline. `spendSummary` is the console's own
  // fix for the same defect in its Issue and Agent detail views.
  //
  // Extracts the real function out of the rendered page (between its own
  // `const money =` and the next top-level `const num =`) and calls it —
  // proving the SHIPPED code behaves correctly, not just a reimplementation
  // of it in the test.
  it("spendSummary reports unpriced runs instead of summing them to a misleading $0.0000", () => {
    const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
    const start = script.indexOf("const money =");
    const end = script.indexOf("const num =");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const src = script.slice(start, end);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const spendSummary = new Function(src + "; return spendSummary;")();

    // Every run in the set is unpriced: no dollar figure, and the count named.
    expect(spendSummary([{ cost_usd: null }, { cost_usd: null }]))
      .toEqual({ text: "—", unpriced: 2 });

    // A mix: the total covers only what was actually priced, plus a count of
    // what was not — never silently folded into the total as zero.
    expect(spendSummary([{ cost_usd: 1.5 }, { cost_usd: null }]))
      .toEqual({ text: "$1.5000", unpriced: 1 });

    // Regression guard: an all-priced set behaves exactly as before.
    expect(spendSummary([{ cost_usd: 1 }, { cost_usd: 2.5 }]))
      .toEqual({ text: "$3.5000", unpriced: 0 });
  });

  // IMPORTANT 4: a cost budget cannot fire on a run whose adapter reports no
  // cost (Codex does not price its own runs) — only its token and duration
  // ceilings still can. The design called for a warning beside such a
  // workflow (and, here, such an agent) on the Budgets tab; it never existed.
  it("costCeilingWarning names an adapter that cannot honour a cost ceiling, and says nothing for one that can", () => {
    const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
    const start = script.indexOf("const esc =");
    const end = script.indexOf("const mdlite =");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const src = script.slice(start, end);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const costCeilingWarning = new Function(src + "; return costCeilingWarning;")();

    expect(costCeilingWarning("codex")).toMatch(/cost ceiling/i);
    expect(costCeilingWarning("codex")).toContain("codex");
    // claude_local prices its own runs — no warning belongs beside it.
    expect(costCeilingWarning("claude_local")).toBe("");
    expect(costCeilingWarning(undefined)).toBe("");
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

  it("edits an agent's instructions rather than only displaying them", () => {
    expect(html).toContain('id="b-text"');                     // the editor
    expect(html).toContain('send("/agents/" + key + "/bundle", "PUT"');
    expect(html).toContain('id="b-revert"');                   // an undo that is not the back button
    // Cmd/Ctrl-S in a full-screen textarea otherwise opens the browser's
    // Save-page dialog over the top of the editor.
    expect(html).toContain('(e.metaKey || e.ctrlKey) && e.key === "s"');
    // And the path itself is settable, or an agent with no bundlePath could
    // never be given instructions at all.
    expect(html).toContain('id="a-bundlepath"');
    expect(html).toContain("body.bundlePath =");
  });

  it("lists skills, names who invokes each, and edits them", () => {
    expect(html).toContain("async function renderSkills(");
    expect(html).toContain("async function renderSkill(");
    expect(html).toContain('send("/skills/" + encodeURIComponent(name), "PUT"');
    expect(html).toContain("Invoked by");
  });

  it("carries the theme's wordmark, with logoText as its accessible name", () => {
    // The mark is inline SVG painted with currentColor: the page makes no
    // network requests, so an <img src> would simply not load, and a second
    // copy for dark mode would be the same paths twice.
    expect(html).toContain('class="wordmark"');
    expect(html).toContain('aria-label="Scyne Orchestrator"');
    expect(html).toContain('fill="currentColor"');
    // An inline SVG's <style> is NOT scoped to it — the source file's
    // `.cls-1{fill:#363C63}` would leak into the page's global cascade.
    const mark = html.slice(html.indexOf('class="wordmark"'), html.indexOf("</aside>"));
    expect(mark).not.toContain("<style");
    expect(mark).not.toContain("cls-1");
  });

  it("drops the wordmark when a consumer renames the product", () => {
    // Their name under our mark is worse than no mark, and not something they
    // would notice until a client did.
    const acme = renderConsole(resolveTheme({ logoText: "Acme Delivery" }));
    expect(acme).toContain("Acme Delivery");
    expect(acme).not.toContain('class="wordmark"');
    // Supplying their own opts back in.
    const own = renderConsole(resolveTheme({ logoText: "Acme", logoSvg: "<svg id=\"acme\"></svg>" }));
    expect(own).toContain('id="acme"');
  });

  it("never emits logoSvg as a CSS custom property", () => {
    // It is markup, not a colour; themeCss iterates the whole theme object.
    expect(html).not.toContain("--logo-svg");
  });

  it("cross-links agents and skills in both directions", () => {
    // Skill page -> its agents, agent page -> its skills, org node -> the skill
    // it invokes. One /skills fetch feeds all three, so the inverse mapping
    // cannot disagree with the forward one.
    expect(html).toContain("const skillLink =");
    expect(html).toContain("const agentLink =");
    expect(html).toContain('href="#skill/');
    expect(html).toContain('href="#agent/');
    expect(html).toContain("Skills it invokes");          // on the agent page
    expect(html).toContain("const skillsFor =");
  });

  it("stops a cross-link from also firing the clickable row under it", () => {
    // The Skills table rows navigate to the skill; an agent chip inside one
    // would otherwise navigate twice, landing wherever the race left it.
    expect(html).toContain('a[data-stop]');
    expect(html).toContain("e.stopPropagation()");
  });

  it("invalidates the cached skill inventory after a save", () => {
    // Size, summary and status all change on save — a `missing` skill becomes
    // `ok` — and the inventory is cached for the session.
    const save = html.slice(html.indexOf('send("/skills/'), html.indexOf('send("/skills/') + 400);
    expect(save).toContain("SKILLS = null");
  });

  it("groups workflow variants instead of listing them as peers", () => {
    // Eighteen rows for ten stages buries the ones anyone starts. The grouping
    // reads `variantOf` — declared by the consumer — and never greps the key
    // for a `revise-` prefix, which is one consumer's naming convention.
    expect(html).toContain("w.variantOf");
    expect(html).toContain("<optgroup");
    expect(html).not.toMatch(/["'`]revise-/);
    expect(html).not.toContain('startsWith("revise');
  });

  it("keeps a variant's budget as its own row, never merged into its parent", () => {
    // The engine looks a budget up by the literal workflow key, so merging them
    // in the UI would imply setting one sets both. A revision is a small diff
    // and should be allowed less than a generation from scratch.
    expect(html).toContain("orderedWf");
    expect(html).toContain("setting ");
    expect(html).toContain("does not set the other");
  });

  it("shows the prompt each agent step actually sends, read-only", () => {
    // There is no other way to see it: the prompt reaches Claude Code on stdin
    // rather than argv, /config strips prompts, and the transcript filter has
    // no event kind for it.
    expect(html).toContain("async function renderWorkflow(");
    expect(html).toContain('api("/workflows/"');
    expect(html).toContain("const withVars =");           // {placeholder} highlighting
    // Read-only: no PUT, and the page says where edits DO belong.
    const page = html.slice(html.indexOf("async function renderWorkflow("),
                            html.indexOf("/* ---- health"));
    expect(page).not.toContain('"PUT"');
    expect(page).toContain("Changing what an agent is told");
    expect(page).toContain("#bundle/");
  });
});

describe("the admin section", () => {
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

  it("renders every admin tab, below a divider", () => {
    for (const label of ["Organisations", "Users", "Projects", "Spend", "Audit"]) {
      expect(html, `missing admin tab ${label}`).toContain(`>${label}</a>`);
    }
    expect(html).toContain('id="navdiv"');
  });

  it("hides admin tabs until a role is known, rather than flashing them", () => {
    // The shell is served to anyone — it has to be, or there would be nowhere
    // to show a login form. Admin tabs must therefore start hidden and be
    // revealed by applyRoleToNav(), not the other way round.
    const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
    const adminLinks = nav.split("<a ").filter(a => a.includes("data-admin"));
    expect(adminLinks).toHaveLength(5);
    for (const a of adminLinks) expect(a, a.slice(0, 60)).toContain('style="display:none"');
  });

  it("marks Organisations superadmin-only and the rest administrator-only", () => {
    expect(html).toContain('data-tab="orgs" data-admin="super"');
    for (const id of ["users", "projects", "spend", "audit"]) {
      expect(html).toContain(`data-tab="${id}" data-admin="admin"`);
    }
  });

  it("boots through the gate, not straight into a data fetch", () => {
    // route() before authentication would fire a screenful of 401s and render
    // an error page to someone who simply has not signed in yet.
    expect(script).toContain("start();");
    expect(script).toMatch(/async function start\(\)/);
    expect(script).toContain("showGate");
  });

  it("never puts a credential anywhere the page can read", () => {
    // The session is an httpOnly cookie set by POST /auth/login. If this ever
    // starts stashing a token in localStorage, an injected script can take it.
    expect(script).not.toMatch(/localStorage/);
    expect(script).not.toMatch(/sessionStorage/);
    expect(script).not.toMatch(/Bearer/);
  });

  it("routes each admin tab to a renderer", () => {
    for (const r of ["renderOrgs", "renderUsers", "renderProjects", "renderSpend", "renderAudit"]) {
      expect(script, `${r} is not wired into ROUTES`).toContain(r);
    }
  });

  it("shows reported and estimated cost separately, never added together", () => {
    // A merged total cannot be audited: nobody reading it can tell which half
    // came from a vendor's billing and which from a price table we typed.
    expect(script).toContain("reported_cost_usd");
    expect(script).toContain("estimated_cost_usd");
    expect(script).toContain("unpriced_run_count");
    expect(script).toContain("costCell");
  });

  it("offers every spend dimension", () => {
    for (const d of ["project", "feature", "user", "agent", "adapter", "model"]) {
      expect(script).toContain(`"${d}"`);
    }
  });

  it("still parses as JavaScript with the admin code spliced in", () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it("still contains no nested template literal", () => {
    expect(script).not.toContain("`");
    expect(script).not.toMatch(/\$\{/);
  });
});
