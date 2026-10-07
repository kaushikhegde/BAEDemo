// The companion app's browser script. Every view is already in the page —
// rendered by scripts/companion/render.mjs — so this only routes between them,
// opens dialogs and the capability slide-over, filters, searches, and switches
// the theme. Inlined into the page; it must never contain a closing script tag.
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var ROUTES = JSON.parse($("#routes").textContent);
  var DEFAULTS = ROUTES.defaults || {};
  var TABS = ROUTES.tabs || [];

  // ---------------------------------------------------------------- routing
  // #/<tab>[/<view>[/<item>]]. A route that names a container resolves to that
  // container's default child (DEFAULTS), so #/personas means the overview and
  // #/personas/journeys means the first journey. An element with
  // data-show="a/b" is visible while the route is a/b or anything under it.
  function withDefaults(path) {
    for (var guard = 0; guard < 6 && DEFAULTS[path]; guard++) path += "/" + DEFAULTS[path];
    return path;
  }
  function exists(panel, path) {
    var shows = $$("[data-show]", panel);
    if (!shows.length) return true;
    return shows.some(function (el) { return el.getAttribute("data-show") === path; });
  }
  function resolve(hash) {
    var segs = String(hash || "").replace(/^#\/?/, "").split("/").filter(Boolean).map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    });
    if (TABS.indexOf(segs[0]) < 0) segs = [TABS[0]];
    var panel = $('[data-panel="' + segs[0] + '"]');
    var path = withDefaults(segs.join("/"));
    // An unknown deep link falls back to its nearest known parent.
    while (panel && !exists(panel, path) && path.indexOf("/") > 0) {
      path = path.slice(0, path.lastIndexOf("/"));
      var parent = withDefaults(path);
      if (parent !== path && exists(panel, parent)) { path = parent; break; }
    }
    return path;
  }

  var current = null;
  function apply(path, focusMain) {
    var tab = path.split("/")[0];
    var tabChanged = !current || current.split("/")[0] !== tab;
    $$(".panel").forEach(function (p) { p.hidden = p.getAttribute("data-panel") !== tab; });
    $$(".tab").forEach(function (a) {
      var on = a.getAttribute("data-tab") === tab;
      a.setAttribute("aria-selected", on ? "true" : "false");
      a.tabIndex = on ? 0 : -1;
    });
    var panel = $('[data-panel="' + tab + '"]');
    if (panel) {
      $$("[data-show]", panel).forEach(function (el) {
        var s = el.getAttribute("data-show");
        el.hidden = !(path === s || path.indexOf(s + "/") === 0);
      });
    }
    $$("[data-link]").forEach(function (a) {
      var l = a.getAttribute("data-link");
      var on = path === l || path.indexOf(l + "/") === 0;
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (current && current !== path) {
      window.scrollTo({ top: 0, behavior: "auto" });
      if (focusMain && !tabChanged) $("#main").focus({ preventScroll: true });
    }
    current = path;
    clearMarks();
    var q = $("#q");
    if (q && q.value.trim().length >= 2) runSearch(q.value.trim());
  }
  function route(focusMain) { apply(resolve(location.hash), focusMain); }
  window.addEventListener("hashchange", function () { route(true); });
  route(false);

  // Tab bar keyboard: roving tabindex, Arrow/Home/End move and activate.
  $$("[role=tablist]").forEach(function (list) {
    list.addEventListener("keydown", function (e) {
      var tabs = $$("[role=tab]", list);
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var next = null;
      if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); next.focus(); next.click(); }
    });
  });

  // ---------------------------------------------------------------- dialogs
  document.addEventListener("click", function (e) {
    var opener = e.target.closest("[data-dialog]");
    if (opener) {
      var dlg = document.getElementById(opener.getAttribute("data-dialog"));
      if (dlg && typeof dlg.showModal === "function") { dlg.showModal(); e.preventDefault(); }
      return;
    }
    var closer = e.target.closest("dialog [data-close]");
    if (closer) { closer.closest("dialog").close(); return; }
    if (e.target.tagName === "DIALOG") e.target.close(); // backdrop click
  });

  // ---------------------------------------------- capability slide-over
  var so = $("#so"), scrim = $("#so-scrim"), soBody = $("#so-body"), soReturn = null;
  function openCap(id) {
    var tpl = $('template[data-cap-detail="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!tpl || !so) return;
    if (so.hidden) soReturn = document.activeElement;
    soBody.replaceChildren(tpl.content.cloneNode(true));
    so.hidden = false; scrim.hidden = false;
    document.body.classList.add("no-scroll");
    $("#so-x").focus();
  }
  function closeCap() {
    if (!so || so.hidden) return;
    so.hidden = true; scrim.hidden = true;
    document.body.classList.remove("no-scroll");
    if (soReturn && soReturn.focus) soReturn.focus();
  }
  document.addEventListener("click", function (e) {
    var c = e.target.closest("[data-cap]");
    if (c) { e.preventDefault(); openCap(c.getAttribute("data-cap")); return; }
    if (e.target.closest("#so a[href]")) closeCap();
  });
  if (so) {
    $("#so-x").addEventListener("click", closeCap);
    scrim.addEventListener("click", closeCap);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeCap(); });
  }

  // ------------------------------------------------- capability filters
  // Non-matching tiles are DIMMED, never hidden: the shape of the map stays put.
  var capq = $("#capq");
  if (capq) {
    var domains = $$(".cap-domains input");
    var applyCap = function () {
      var q = capq.value.trim().toLowerCase();
      var picked = domains.filter(function (d) { return d.checked; }).map(function (d) { return d.value; });
      var active = !!(q || picked.length);
      $$(".cap-tile").forEach(function (t) {
        var ok = (!q || t.getAttribute("data-hay").indexOf(q) >= 0) &&
                 (!picked.length || picked.indexOf(t.getAttribute("data-root")) >= 0);
        t.classList.toggle("dim", active && !ok);
      });
      $$(".cap-sec").forEach(function (sec) {
        var any = $$(".cap-tile", sec).some(function (t) { return !t.classList.contains("dim"); });
        sec.classList.toggle("dim", active && !any);
      });
    };
    capq.addEventListener("input", applyCap);
    domains.forEach(function (d) { d.addEventListener("change", applyCap); });
    $("#cap-clear").addEventListener("click", function () {
      capq.value = ""; domains.forEach(function (d) { d.checked = false; }); applyCap();
    });
  }

  // ------------------------------------------------------------ swimlanes
  // A task names the activity it performs; selecting it finds that activity in
  // the step cards below and flashes it.
  function pickNode(node) {
    var name = node.getAttribute("data-activity");
    var view = node.closest(".phase-view");
    if (!name || !view) return;
    $$(".sl-node.is-sel", view).forEach(function (n) { n.classList.remove("is-sel"); });
    node.classList.add("is-sel");
    var row = $$("[data-activity-row]", view).filter(function (r) { return r.getAttribute("data-activity-row") === name; })[0];
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
  }
  document.addEventListener("click", function (e) {
    var n = e.target.closest(".sl-node[data-activity]");
    if (n) pickNode(n);
    var fit = e.target.closest("[data-fit]");
    if (fit) {
      var on = fit.closest(".swim").classList.toggle("fit");
      fit.setAttribute("aria-pressed", on ? "true" : "false");
      fit.textContent = on ? "Actual size" : "Fit to width";
    }
  });
  document.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".sl-node[data-activity]")) {
      e.preventDefault(); pickNode(e.target);
    }
  });

  // ---------------------------------------------------------------- search
  // Searches the view on screen only, marks every hit and scrolls to the first.
  function clearMarks() {
    $$("mark.hit").forEach(function (m) {
      var p = m.parentNode; p.replaceChild(document.createTextNode(m.textContent), m); p.normalize();
    });
  }
  function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
  function runSearch(term) {
    clearMarks();
    var panel = $(".panel:not([hidden])");
    if (!panel || term.length < 2) return;
    var needle = term.toLowerCase(), hits = [];
    var walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!p || p.closest("svg,template,dialog,script,style,mark") || !visible(p)) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.toLowerCase().indexOf(needle) >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var text = node.nodeValue, low = text.toLowerCase(), frag = document.createDocumentFragment(), at = 0, i;
      while ((i = low.indexOf(needle, at)) >= 0) {
        frag.appendChild(document.createTextNode(text.slice(at, i)));
        var m = document.createElement("mark"); m.className = "hit"; m.textContent = text.slice(i, i + needle.length);
        frag.appendChild(m); hits.push(m); at = i + needle.length;
      }
      frag.appendChild(document.createTextNode(text.slice(at)));
      node.parentNode.replaceChild(frag, node);
    });
    var q = $("#q");
    if (q) q.setAttribute("aria-label", hits.length + " match" + (hits.length === 1 ? "" : "es") + " on this view");
    if (hits[0]) hits[0].scrollIntoView({ behavior: "smooth", block: "center" });
  }
  var q = $("#q"), timer = null;
  if (q) q.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(function () { runSearch(q.value.trim()); }, 160);
  });

  // ------------------------------------------------------- theme and print
  var themeBtn = $("#theme");
  function syncTheme() {
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    themeBtn.setAttribute("aria-pressed", dark ? "true" : "false");
    themeBtn.title = dark ? "Light mode" : "Dark mode";
  }
  if (themeBtn) {
    syncTheme();
    themeBtn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("scyne-theme", next); } catch (e) { /* private window */ }
      syncTheme();
    });
  }
  var printer = $("#printer");
  if (printer) printer.addEventListener("click", function () { window.print(); });
})();
