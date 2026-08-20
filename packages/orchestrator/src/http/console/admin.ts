// The admin tabs: Orgs, Users, Projects, Spend, Audit.
//
// A string spliced into the console page, so the same rule applies as to every
// other line of that script: **no backtick and no dollar-brace anywhere**,
// comments included. `console.test.ts` asserts it, and it also parses the
// finished script with `new Function`, so a syntax error here fails the suite
// rather than the browser.
//
// Every one of these is admin-gated in the ROUTER too. The rail hiding them is
// convenience; the router refusing them is the boundary.

export const ADMIN_JS = `
/* ---- shared bits ------------------------------------------------------- */

/* Reported and estimated are rendered SEPARATELY, everywhere, and never added
   into one figure. Codex reports no cost of its own, so on a Codex-first
   install the estimated column is most of the bill — and a merged total cannot
   be audited, because nobody reading it can tell which half came from a
   vendor's billing and which from a price table somebody typed. */
const costCell = (row) => {
  const rep = Number(row.reported_cost_usd || 0);
  const est = Number(row.estimated_cost_usd || 0);
  const unpriced = Number(row.unpriced_run_count || 0);
  const bits = [];
  if (rep) bits.push('<span title="Reported by the CLI that ran it">' + money(rep) + '</span>');
  if (est) bits.push('<span class="muted" title="Our arithmetic, from the model price table">~' + money(est) + '</span>');
  if (!bits.length) bits.push('<span class="muted">--</span>');
  let out = bits.join(' <span class="muted">+</span> ');
  if (unpriced) {
    out += ' <span class="muted" title="These runs carry no figure at all: the model has no recorded price">' +
      '(' + unpriced + ' unpriced)</span>';
  }
  return out;
};

const adminDenied = (what) => {
  view.innerHTML = '<div class="empty"><b>Not for you</b>' +
    esc(what) + ' is administrator-only. You are signed in as ' +
    esc(ME ? ME.role : "nobody") + '.</div>';
};

/* ---- Orgs -------------------------------------------------------------- */

async function renderOrgs() {
  setHead("Organisations", "Every client in this installation.");
  if (!isSuper()) { adminDenied("Organisations"); return; }
  const orgs = await api("/orgs");
  if (!orgs.length) { view.innerHTML = '<div class="empty"><b>No organisations</b>Create one below.</div>'; return; }

  view.innerHTML =
    '<table class="grid"><thead><tr>' +
      '<th>Name</th><th>Slug</th><th>Status</th>' +
      '<th class="r">Users</th><th class="r">Projects</th><th class="r">Features</th><th class="r">Issues</th><th></th>' +
    '</tr></thead><tbody>' +
    orgs.map(o =>
      '<tr><td><b>' + esc(o.name) + '</b></td>' +
      '<td class="mono">' + esc(o.slug) + '</td>' +
      '<td>' + st(o.status) + '</td>' +
      '<td class="r">' + num(o.stats.users) + '</td>' +
      '<td class="r">' + num(o.stats.projects) + '</td>' +
      '<td class="r">' + num(o.stats.features) + '</td>' +
      '<td class="r">' + num(o.stats.issues) + '</td>' +
      '<td class="r"><button class="ghost sm" data-act="' + esc(o.slug) + '">Act as</button>' +
      '<button class="ghost sm" data-arch="' + esc(o.id) + '" data-name="' + esc(o.name) + '">Archive</button></td>' +
      '</tr>').join("") +
    '</tbody></table>' +
    '<div class="card" style="margin-top:1rem">' +
      '<h3 style="margin-top:0">New organisation</h3>' +
      '<label for="on">Name</label><input id="on" placeholder="Alpha Council of SA">' +
      '<div class="actions"><button id="ocreate">Create</button><span id="omsg"></span></div>' +
      '<div class="muted" style="font-size:.74rem;margin-top:.5rem">' +
        'The slug is derived from the name and never changes afterwards ' +
        '— it is what an operator pins and what an authorisation header carries.</div>' +
    '</div>';

  on("button[data-act]", "click", async (e) => {
    const sel = document.getElementById("orgpick");
    if (sel) { sel.value = e.currentTarget.dataset.act; ME = await whoami(); }
    await renderOrgPicker();
    location.hash = "#projects";
  });

  on("button[data-arch]", "click", async (e) => {
    const name = e.currentTarget.dataset.name;
    if (!confirm("Archive " + name + "?\\n\\nIts users, projects and spend are KEPT and stay reachable by id. It simply stops appearing.")) return;
    const msg = document.getElementById("omsg");
    try {
      await send("/orgs/" + e.currentTarget.dataset.arch, "DELETE", null);
      renderOrgs();
    } catch (err) { msg.textContent = String(err.message || err); msg.className = "bad"; }
  });

  document.getElementById("ocreate").addEventListener("click", async () => {
    const msg = document.getElementById("omsg");
    msg.textContent = ""; msg.className = "";
    try {
      await send("/orgs", "POST", { name: document.getElementById("on").value });
      renderOrgs();
    } catch (err) { msg.textContent = String(err.message || err); msg.className = "bad"; }
  });
}

/* ---- Users ------------------------------------------------------------- */

async function renderUsers() {
  setHead("Users", "Who can sign in, and what they have spent.");
  if (!isAdmin()) { adminDenied("Users"); return; }

  const users = await api("/users");
  const spend = await api("/spend?by=user").catch(() => []);
  const byUser = {};
  spend.forEach(s => { if (s.user_id) byUser[s.user_id] = s; });

  view.innerHTML =
    '<table class="grid"><thead><tr>' +
      '<th>Email</th><th>Name</th><th>Role</th><th>Status</th>' +
      '<th class="r">Runs</th><th class="r">Spend</th><th></th>' +
    '</tr></thead><tbody>' +
    users.map(u => {
      const s = byUser[u.id];
      return '<tr><td class="mono">' + esc(u.email) + '</td>' +
        '<td>' + esc(u.name || "--") + '</td>' +
        '<td>' + st(u.role) + '</td>' +
        '<td>' + st(u.status || "active") + '</td>' +
        '<td class="r">' + (s ? num(s.run_count) : "--") + '</td>' +
        '<td class="r">' + (s ? costCell(s) : '<span class="muted">--</span>') + '</td>' +
        '<td class="r">' +
          '<select class="orgpick" data-role="' + esc(u.id) + '">' +
            ["superadmin", "admin", "member", "viewer"].map(r =>
              '<option value="' + r + '"' + (u.role === r ? " selected" : "") + '>' + r + '</option>').join("") +
          '</select>' +
          '<button class="ghost sm" data-tog="' + esc(u.id) + '" data-status="' + esc(u.status || "active") + '">' +
            ((u.status || "active") === "active" ? "Disable" : "Enable") + '</button>' +
        '</td></tr>';
    }).join("") +
    '</tbody></table>' +
    '<div id="umsg" style="margin-top:.6rem"></div>' +
    '<div class="card" style="margin-top:1rem">' +
      '<h3 style="margin-top:0">New user</h3>' +
      '<label for="ue">Email</label><input id="ue" type="email" placeholder="person@client.com">' +
      '<label for="up">Password</label><input id="up" type="password" placeholder="they can change it later">' +
      '<label for="ur">Role</label>' +
      '<select id="ur" class="orgpick">' +
        '<option value="member">member</option><option value="admin">admin</option>' +
        '<option value="viewer">viewer</option>' +
        (isSuper() ? '<option value="superadmin">superadmin</option>' : "") +
      '</select>' +
      '<div class="actions"><button id="ucreate">Create</button><span id="ucmsg"></span></div>' +
    '</div>';

  const say = (id, text, bad) => {
    const el = document.getElementById(id);
    el.textContent = text; el.className = bad ? "bad" : "good";
  };

  on("select[data-role]", "change", async (e) => {
    try {
      await send("/users/" + e.currentTarget.dataset.role, "PATCH", { role: e.currentTarget.value });
      say("umsg", "Role updated.", false);
    } catch (err) { say("umsg", String(err.message || err), true); renderUsers(); }
  });

  on("button[data-tog]", "click", async (e) => {
    const next = e.currentTarget.dataset.status === "active" ? "disabled" : "active";
    try {
      await send("/users/" + e.currentTarget.dataset.tog, "PATCH", { status: next });
      renderUsers();
    } catch (err) { say("umsg", String(err.message || err), true); }
  });

  document.getElementById("ucreate").addEventListener("click", async () => {
    try {
      await send("/users", "POST", {
        email: document.getElementById("ue").value,
        password: document.getElementById("up").value,
        role: document.getElementById("ur").value,
      });
      renderUsers();
    } catch (err) { say("ucmsg", String(err.message || err), true); }
  });
}

/* ---- Projects ---------------------------------------------------------- */

async function renderProjects() {
  setHead("Projects", "Every project in this organisation, and what it has cost.");
  if (!isAdmin()) { adminDenied("Projects"); return; }

  const projects = await api("/projects");
  const spend = await api("/spend?by=project").catch(() => []);
  const byName = {};
  spend.forEach(s => { if (s.project_name) byName[s.project_name] = s; });

  if (!projects.length) {
    view.innerHTML = '<div class="empty"><b>No projects</b>' +
      'Create one from the chatbot, or with <span class="mono">scyne project create</span>.</div>';
    return;
  }

  const rows = await Promise.all(projects.map(async p => {
    const features = await api("/projects/" + p.id + "/features").catch(() => []);
    return { p: p, features: features };
  }));

  view.innerHTML =
    '<table class="grid"><thead><tr>' +
      '<th>Project</th><th>Features</th><th class="r">Runs</th><th class="r">Tokens</th><th class="r">Spend</th>' +
    '</tr></thead><tbody>' +
    rows.map(r => {
      const s = byName[r.p.name];
      return '<tr><td><b>' + esc(r.p.name) + '</b>' +
        (r.p.description ? '<div class="muted" style="font-size:.72rem">' +
          esc(String(r.p.description).slice(0, 90)) + '</div>' : "") + '</td>' +
        '<td>' + (r.features.length
          ? r.features.map(f => '<span class="chip"><span class="l">' + esc(f.name) + '</span></span>').join(" ")
          : '<span class="muted">none yet</span>') + '</td>' +
        '<td class="r">' + (s ? num(s.run_count) : "--") + '</td>' +
        '<td class="r">' + (s ? num(Number(s.input_tokens) + Number(s.output_tokens)) : "--") + '</td>' +
        '<td class="r">' + (s ? costCell(s) : '<span class="muted">--</span>') + '</td>' +
        '</tr>';
    }).join("") +
    '</tbody></table>';
}

/* ---- Spend ------------------------------------------------------------- */

const SPEND_BY = ["project", "feature", "user", "agent", "adapter", "model"];

async function renderSpend() {
  setHead("Spend", "Reported and estimated, kept apart.");
  if (!isAdmin()) { adminDenied("Spend"); return; }

  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const by = params.get("by") || "project";
  const since = params.get("since") || "";

  const q = new URLSearchParams({ by: by });
  if (since) q.set("since", since);
  const rows = await api("/spend?" + q.toString());

  const label = (r) =>
    r.project_name || r.feature_name || r.user_email || r.agent_key || r.adapter || r.model || "--";

  let totalRep = 0, totalEst = 0, unpriced = 0;
  rows.forEach(r => {
    totalRep += Number(r.reported_cost_usd || 0);
    totalEst += Number(r.estimated_cost_usd || 0);
    unpriced += Number(r.unpriced_run_count || 0);
  });

  view.innerHTML =
    '<div class="wrap" style="gap:.5rem;margin-bottom:.8rem">' +
      '<label for="sby" class="muted" style="font-size:.74rem">Group by</label>' +
      '<select id="sby" class="orgpick">' +
        SPEND_BY.map(d => '<option value="' + d + '"' + (d === by ? " selected" : "") + '>' + d + '</option>').join("") +
      '</select>' +
      '<label for="ssince" class="muted" style="font-size:.74rem">Since</label>' +
      '<input id="ssince" type="date" class="orgpick" value="' + esc(since) + '">' +
    '</div>' +
    (rows.length
      ? '<table class="grid"><thead><tr>' +
          '<th>' + esc(by) + '</th><th class="r">Runs</th><th class="r">In</th><th class="r">Out</th><th class="r">Cost</th>' +
        '</tr></thead><tbody>' +
        rows.map(r =>
          '<tr><td>' + esc(label(r)) + '</td>' +
          '<td class="r">' + num(r.run_count) + '</td>' +
          '<td class="r">' + num(r.input_tokens) + '</td>' +
          '<td class="r">' + num(r.output_tokens) + '</td>' +
          '<td class="r">' + costCell(r) + '</td></tr>').join("") +
        '</tbody></table>'
      : '<div class="empty"><b>Nothing recorded</b>No runs match those filters.</div>') +
    '<div class="card" style="margin-top:1rem">' +
      '<div><b>' + money(totalRep) + '</b> reported' +
      (totalEst ? ' <span class="muted">+</span> <b>~' + money(totalEst) + '</b> estimated' : "") + '</div>' +
      '<div class="muted" style="font-size:.74rem;margin-top:.35rem">' +
        'Reported is the figure the CLI billed and returned. Estimated is ours, computed from ' +
        'token counts and the recorded price for the model — every Codex run, which reports no ' +
        'cost of its own. They are never added together.' +
        (unpriced ? ' <b>' + unpriced + ' run(s) carry no figure at all</b>: their model has no recorded price.' : "") +
      '</div>' +
    '</div>';

  const go = () => {
    const q2 = new URLSearchParams({ by: document.getElementById("sby").value });
    const d = document.getElementById("ssince").value;
    if (d) q2.set("since", d);
    location.hash = "#spend?" + q2.toString();
    renderSpend();
  };
  document.getElementById("sby").addEventListener("change", go);
  document.getElementById("ssince").addEventListener("change", go);
}

/* ---- Audit ------------------------------------------------------------- */

async function renderAudit() {
  setHead("Audit", "Who did what, and when.");
  if (!isAdmin()) { adminDenied("Audit"); return; }

  const actions = await api("/actions?limit=300");
  if (!actions.length) {
    view.innerHTML = '<div class="empty"><b>Nothing recorded yet</b>' +
      'Sign-ins, project changes, gate decisions and run controls all land here.</div>';
    return;
  }

  /* The actor comes joined on the row. Resolving it here against THIS
     organisation's users could not name a superadmin acting in it from
     outside — the actor an audit trail most needs to name. The map below is
     only a fallback for rows written before the join existed. */
  const users = await api("/users").catch(() => []);
  const email = {};
  users.forEach(u => { email[u.id] = u.email; });

  view.innerHTML =
    '<table class="grid"><thead><tr>' +
      '<th>When</th><th>Who</th><th>Did</th><th>Project</th><th>To</th><th>Detail</th>' +
    '</tr></thead><tbody>' +
    actions.map(a =>
      '<tr><td class="mono" title="' + esc(when(a.created_at)) + '">' + esc(ago(a.created_at)) + '</td>' +
      '<td class="mono">' + esc(a.user_email || (a.user_id ? (email[a.user_id] || a.user_id.slice(0, 8)) : (a.agent_key || "--"))) + '</td>' +
      '<td>' + st(a.verb) + '</td>' +
      '<td>' + esc(a.project_name || "--") + '</td>' +
      '<td class="mono">' + esc(a.target_type || "--") + '</td>' +
      '<td class="muted" style="font-size:.72rem">' +
        esc(JSON.stringify(a.detail || {}).slice(0, 80)) + '</td></tr>').join("") +
    '</tbody></table>';
}
`;
