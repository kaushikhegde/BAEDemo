// The console's login gate.
//
// Its own module rather than more lines in console.ts, which is already 2100.
// Everything here is a STRING spliced into that page — so the same rule
// applies as to the rest of the browser script: **no backtick and no
// dollar-brace anywhere inside**, comments included, because it all lives
// inside a TypeScript template literal. `console.test.ts` asserts it.
//
// The credential is the httpOnly `scyne_session` cookie, set by
// `POST /auth/login`. None of the code below ever sees a token: the fetches
// are same-origin and the browser attaches it. That is the whole reason for
// preferring a cookie to localStorage here — a credential the page cannot read
// is one an injected script cannot steal.

export const AUTH_CSS = `
.gate {
  position: fixed; inset: 0; z-index: 60;
  display: grid; place-items: center;
  background: var(--bg);
}
.gate form {
  width: min(23rem, calc(100vw - 3rem));
  background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 1.5rem 1.4rem; box-shadow: 0 12px 40px rgb(0 0 0 / .18);
}
.gate h2 { margin: 0 0 .2rem; font-size: 1.05rem; }
.gate .sub { color: var(--muted); font-size: .78rem; margin-bottom: 1.1rem; }
.gate label { display: block; font-size: .72rem; color: var(--muted); margin: .7rem 0 .25rem; }
.gate input {
  width: 100%; box-sizing: border-box; padding: .55rem .6rem;
  border: 1px solid var(--line); border-radius: 7px;
  background: var(--bg); color: var(--fg); font: inherit; font-size: .85rem;
}
.gate input:focus { outline: 2px solid var(--brand); outline-offset: 1px; border-color: var(--brand); }
.gate button { width: 100%; margin-top: 1.1rem; }
.gate .err {
  /* --on-danger, not --danger: the raw palette is tuned for a dark ground and
     measures 3.67:1 against white, under the 4.5:1 floor for text. The --on-*
     token is darkened for light mode and restored to the raw value under dark.
     console.test.ts fails the build on a bare "color: var(--danger)" — and a
     backtick in THIS comment would end the template literal, which is the very
     rule this file's header states. */
  margin-top: .8rem; font-size: .78rem; color: var(--on-danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  border-radius: 7px; padding: .45rem .6rem;
}
.gate .hint { margin-top: .9rem; font-size: .72rem; color: var(--muted); line-height: 1.5; }
.whoami { display: flex; align-items: center; gap: .45rem; font-size: .72rem; color: var(--muted); }
.whoami .orgpick {
  background: var(--bg); color: var(--fg); border: 1px solid var(--line);
  border-radius: 6px; padding: .18rem .35rem; font: inherit; font-size: .72rem;
}
`;

export const AUTH_JS = `
/* ---- who is looking at this ------------------------------------------- */

let ME = null;

const isAdmin = () => Boolean(ME) && (ME.role === "admin" || ME.role === "superadmin");
const isSuper = () => Boolean(ME) && ME.role === "superadmin";

async function whoami() {
  const r = await fetch("/auth/whoami", { headers: { accept: "application/json" } });
  if (!r.ok) return null;
  return r.json();
}

/* The rail hides what a role cannot use. That is CONVENIENCE ONLY — the
   router refuses those routes regardless, and it is the router that is the
   security boundary. A hidden tab is a tidier screen, not a permission. */
function applyRoleToNav() {
  document.querySelectorAll("nav a[data-admin]").forEach(a => {
    const need = a.dataset.admin;
    const allowed = need === "super" ? isSuper() : isAdmin();
    a.style.display = allowed ? "" : "none";
  });
  const div = document.getElementById("navdiv");
  if (div) div.style.display = isAdmin() ? "" : "none";
}

/* The organisation a superadmin is acting in. Sent as X-Scyne-Org on every
   request; the server refuses it from anyone else rather than ignoring it, so
   this is only ever populated for a superadmin. */
function currentOrg() {
  const sel = document.getElementById("orgpick");
  return sel && sel.value ? sel.value : null;
}

async function renderOrgPicker() {
  const host = document.getElementById("whoami");
  if (!host) return;
  const label = ME ? esc(ME.email) : "";
  if (!isSuper()) {
    host.innerHTML = '<span>' + label +
      (ME && ME.company ? ' · ' + esc(ME.company.name) : "") + '</span>' +
      '<button class="ghost sm" id="signout">Sign out</button>';
  } else {
    const orgs = await api("/orgs").catch(() => []);
    const active = ME && ME.company ? ME.company.slug : "";
    host.innerHTML = '<span>' + label + '</span>' +
      '<select class="orgpick" id="orgpick" title="Act inside this organisation">' +
      orgs.map(o => '<option value="' + esc(o.slug) + '"' +
        (o.slug === active ? " selected" : "") + '>' + esc(o.name) + '</option>').join("") +
      '</select>' +
      '<button class="ghost sm" id="signout">Sign out</button>';
    const pick = document.getElementById("orgpick");
    if (pick) pick.addEventListener("change", async () => {
      /* Re-read who we are AS the newly chosen org, so every screen and the
         org label agree about which one is active. */
      ME = await whoami();
      await renderOrgPicker();
      route();
      renderStrip();
    });
  }
  const out = document.getElementById("signout");
  if (out) out.addEventListener("click", async () => {
    await send("/auth/logout", "POST", {}).catch(() => {});
    ME = null;
    showGate();
  });
}

/* ---- the gate ---------------------------------------------------------- */

function showGate(message) {
  stopPolling();
  const host = document.getElementById("gate");
  host.style.display = "";
  host.innerHTML =
    '<form id="gateform">' +
      '<h2>Sign in</h2>' +
      '<div class="sub">This console shows every organisation, user and dollar in the install.</div>' +
      '<label for="ge">Email</label>' +
      '<input id="ge" type="email" autocomplete="username" required autofocus>' +
      '<label for="gp">Password</label>' +
      '<input id="gp" type="password" autocomplete="current-password" required>' +
      '<button type="submit" id="gsubmit">Sign in</button>' +
      (message ? '<div class="err">' + esc(message) + '</div>' : "") +
      '<div class="hint">No account yet? The first one claims the installation:' +
        '<br><span class="mono">scyne init</span></div>' +
    '</form>';

  document.getElementById("gateform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("gsubmit");
    btn.disabled = true;
    btn.textContent = "Signing in...";
    try {
      const r = await fetch("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          email: document.getElementById("ge").value,
          password: document.getElementById("gp").value,
        }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        /* One message for an unknown address and a wrong password alike — the
           server gives one deliberately, and inventing a friendlier split here
           would turn this form into a directory of who has an account. */
        showGate(b.error || "Invalid email or password.");
        return;
      }
      await start();
    } catch (err) {
      showGate("Cannot reach the orchestrator. Is it running?");
    }
  });
}

function hideGate() {
  const host = document.getElementById("gate");
  host.style.display = "none";
  host.innerHTML = "";
}

/* Boot. The shell renders unauthenticated and this decides what happens next,
   which is why /orch itself needs no credential — the DATA behind it does. */
async function start() {
  ME = await whoami();
  if (!ME) { showGate(); return; }
  hideGate();
  applyRoleToNav();
  await renderOrgPicker();
  renderStrip();
  route();
}
`;
