#!/usr/bin/env node
/**
 * Prove the Azure DevOps MCP is wired up, without spending an agent run.
 *
 *   npm run mcp:test              # read-only checks
 *   npm run mcp:test -- --write   # also create and delete a real work item
 *
 * Run through `tsx`, not bare `node`: it imports `readMcpServers` from
 * core/codex-runner.ts on purpose — testing a reimplementation of it here
 * would prove nothing about what actually runs — and plain node cannot resolve
 * that module's `.js` specifiers back to `.ts`.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Does the MCP work" is the easy half and not the half that breaks. What
 * breaks is the WIRING between this repository and it, and every one of those
 * failures looks like something else:
 *
 *   - `.mcp.json` holds ${MCP_TOKEN_FOR_AZURE}. Claude Code expands that
 *     itself; the Codex path does NOT go through Claude Code, so without our
 *     own expansion the server receives the literal string and answers 401 —
 *     with a credential that looks perfectly present in the config file.
 *   - The Codex path re-encodes the same config as `codex -c` TOML overrides.
 *     TOML inline tables are `{ k = "v" }`, not JSON's `{"k":"v"}`, and a value
 *     that fails to parse is silently used as a raw string — losing every
 *     credential in the map rather than erroring.
 *   - Azure DevOps answers a MISSING SCOPE with 401, not 403. A token that can
 *     write work items but not wiki pages looks exactly like a bad token.
 *
 * So this loads `.mcp.json` through the SAME function the runner uses, starts
 * the server with exactly the argv and env an agent would get, and asks it to
 * do the two things the publish step actually does.
 */

import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const REPO = resolve(join(fileURLToPath(import.meta.url), "..", ".."));
const WRITE = process.argv.includes("--write");

let pass = 0, fail = 0, skip = 0;
const ok = (l, d = "") => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}${d ? "  " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${l}${d ? "\n      " + String(d).split("\n").join("\n      ") : ""}`); };
const meh = (l, d = "") => { skip++; console.log(`  \x1b[33m–\x1b[0m ${l}${d ? "  " + d : ""}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ---------------------------------------------------------------- 1. config

head("1. The configuration the runner would hand an agent");

// Import the config file rather than only reading .env: it is what derives
// ADO_MCP_BASIC from the raw PAT, and that derivation is precisely what this
// test exists to check. Reading .env alone would test a different setup from
// the one an agent gets.
process.loadEnvFile?.(join(REPO, ".env"));
await import(join(REPO, "orchestrator.config.ts"));

let servers = {};
try {
  // The SAME function core/codex-runner.ts uses. Testing a reimplementation
  // here would prove nothing about what actually runs.
  const { readMcpServers } = await import(join(REPO, "packages/orchestrator/src/core/codex-runner.ts"));
  servers = await readMcpServers(join(REPO, ".mcp.json"));
  ok(".mcp.json parses", Object.keys(servers).join(", ") || "(no servers)");
} catch (err) {
  bad(".mcp.json parses", err.message);
  process.exit(1);
}

const ado = servers["azure-devops"];
if (!ado) {
  bad("an 'azure-devops' server is configured", "found: " + Object.keys(servers).join(", "));
  process.exit(1);
}
ok("an 'azure-devops' server is configured", `${ado.command} ${(ado.args || []).join(" ")}`);

const pat = ado.env?.PERSONAL_ACCESS_TOKEN;
if (!pat) bad("a PAT reaches the server");
else if (pat.includes("${")) {
  bad("the ${VAR} in .mcp.json was expanded",
      `the server would receive the literal string "${pat}" and answer 401`);
} else {
  ok("the ${VAR} in .mcp.json was expanded", `${pat.length} chars, ends …${pat.slice(-4)}`);

  // MEASURED against the live server: it wants BASIC CREDENTIALS, base64 of
  // ":<pat>", not the raw PAT. A raw PAT 401s every call while the same value
  // answers 200 over REST — which sends you hunting through scopes instead of
  // encoding. Catching the shape here turns that into one line of output.
  let decoded = null;
  try { decoded = Buffer.from(pat, "base64").toString("utf8"); } catch { /* not base64 */ }
  const looksBasic = typeof decoded === "string" && decoded.includes(":");
  looksBasic
    ? ok("it is BASIC credentials, which is what this server wants", "base64 of \":<pat>\"")
    : bad("it is BASIC credentials, which is what this server wants",
          "This looks like a RAW PAT. @azure-devops/mcp wants base64 of \":<pat>\" — a raw one\n" +
          "401s every call, while the same value works fine over REST.\n" +
          "orchestrator.config.ts derives ADO_MCP_BASIC for exactly this; .mcp.json should\n" +
          "reference ${ADO_MCP_BASIC}, not ${MCP_TOKEN_FOR_AZURE}.");
}

// The Codex path re-encodes all of this as `-c` TOML overrides. A mis-encoded
// inline table is used as a raw string and every credential in it is lost.
try {
  const { buildCodexArgs } = await import(join(REPO, "packages/orchestrator/src/core/codex-runner.ts"));
  const args = buildCodexArgs(
    { agent: { key: "ba", mcpEnabled: true }, prompt: "", cwd: REPO, logPath: "/tmp/x" }, servers);
  const envArg = args[args.indexOf("-c", args.indexOf("mcp_servers.azure-devops.env=") >= 0 ? 0 : 0)];
  const envOverride = args.find(a => typeof a === "string" && a.startsWith("mcp_servers.azure-devops.env="));
  if (!envOverride) bad("the Codex path passes the env through");
  else if (!/^mcp_servers\.azure-devops\.env=\{ [A-Z_]+ = ".*" \}$/.test(envOverride)) {
    bad("the Codex env override is valid TOML",
        `TOML inline tables use ' = ', not ':'. Got: ${envOverride.slice(0, 70)}`);
  } else {
    ok("the Codex env override is valid TOML", "{ KEY = \"…\" }");
  }
} catch (err) {
  bad("buildCodexArgs runs", err.message);
}

// ------------------------------------------------------------------ 2. live

head("2. The server, started exactly as an agent would start it");

const child = spawn(ado.command, ado.args ?? [], {
  env: { ...process.env, ...(ado.env ?? {}) },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const waiting = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  }
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });

const rpc = (method, params, timeoutMs = 45000) => new Promise((res, rej) => {
  const id = nextId++;
  waiting.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error(`${method} timed out`)); } }, timeoutMs);
});

const stop = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", stop);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { stop(); process.exit(130); });

let tools = [];
try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scyne-mcp-test", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await rpc("tools/list", {});
  tools = (listed.result?.tools ?? []).map(t => t.name);
  ok("the server starts and speaks MCP", `${tools.length} tools`);
} catch (err) {
  bad("the server starts and speaks MCP", err.message + (stderr ? "\n" + stderr.slice(-300) : ""));
  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(1);
}

for (const t of ["wiki_upsert_page", "wit_work_item_write", "wit_work_item_link_write", "wiki"]) {
  tools.includes(t) ? ok(`the publish step's tool '${t}' exists`) : bad(`'${t}' is missing`);
}
// The one thing it CANNOT do, which is why the type is a workflow parameter.
tools.some(t => /work.?item.?type/i.test(t))
  ? meh("a work item TYPE listing tool exists", "then the type could be discovered instead of recorded")
  : ok("no tool lists work item types — hence the type is recorded per project");

// -------------------------------------------------------------- 3. it works

head("3. What the publish step actually does");

const ORG = process.env.ADO_ORG;
// There is no installation-wide ADO project any more — each Scyne project has
// its own, recorded in its .published.json. This is a hand-run diagnostic, so
// it takes the one to probe explicitly rather than guessing at a client's.
const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const PROJECT = argOf("project");
const TYPE = argOf("type") || "Issue";
const text = (r) => (r.result?.content ?? []).map(c => c.text ?? "").join("\n");
const failed = (r) => r.error || r.result?.isError;

if (!ORG || !PROJECT) {
  meh("a live target is configured",
      'set ADO_ORG in .env and pass --project "<ADO project>" to run the live checks');
} else {
  // Read: proves auth end to end through the MCP, not just over REST.
  try {
    const r = await rpc("tools/call", { name: "core_list_projects", arguments: {} });
    failed(r) ? bad("the PAT authenticates THROUGH the MCP", text(r).slice(0, 200))
              : ok("the PAT authenticates THROUGH the MCP", PROJECT);
  } catch (err) { bad("core_list_projects", err.message); }

  // Wiki: the half that needs vso.wiki_write.
  try {
    const r = await rpc("tools/call", { name: "wiki", arguments: { action: "list_wikis", project: PROJECT } });
    if (failed(r)) {
      bad("the PAT has the WIKI scope",
        text(r).slice(0, 240) +
        "\n\nAzure DevOps answers a missing scope with 401, not 403 — so this reads like a" +
        "\nbad token and is not one. Add vso.wiki_write at" +
        `\nhttps://dev.azure.com/${ORG}/_usersSettings/tokens`);
    } else ok("the PAT has the WIKI scope", text(r).slice(0, 90).replace(/\s+/g, " "));
  } catch (err) { bad("wiki list_wikis", err.message); }

  // Work items: the half that needs vso.work_write.
  if (!WRITE) {
    meh(`creating a '${TYPE}' work item`, "pass --write to actually create and then delete one");
  } else {
    let created = null;
    try {
      const r = await rpc("tools/call", {
        name: "wit_work_item_write",
        arguments: {
          action: "create", project: PROJECT, workItemType: TYPE,
          // An ARRAY of {name, value, format}, not an object keyed by field
          // name. The server validates this and rejects the object form.
          fields: [
            { name: "System.Title", value: "Scyne MCP wiring test — safe to delete" },
            { name: "System.Description", format: "Markdown",
              value: "Created by `npm run mcp:test -- --write`. Deleted immediately." },
          ],
        },
      });
      if (failed(r)) {
        bad(`creating a '${TYPE}' work item`, text(r).slice(0, 280) +
          `\n\nIf it says the type does not exist, adoTarget.workItemType is wrong for this project.` +
          `\nRun 'npm run ado:verify' — it prints the types the project actually has.`);
      } else {
        const m = /\b(\d{1,7})\b/.exec(text(r));
        created = m ? m[1] : null;
        ok(`creating a '${TYPE}' work item`, created ? `#${created}` : "created");
      }
    } catch (err) { bad("wit_work_item_write create", err.message); }

    if (created) {
      try {
        const r = await rpc("tools/call", {
          name: "wit_work_item_write",
          arguments: { action: "update", project: PROJECT, id: Number(created),
                       updates: [{ op: "add", path: "/fields/System.Title", value: "Scyne MCP wiring test — updated" }] },
        });
        failed(r) ? bad("updating it (what a REVISION does)", text(r).slice(0, 200))
                  : ok("updating it (what a REVISION does)", `#${created}`);
      } catch (err) { bad("wit_work_item_write update", err.message); }

      // Tidy up over REST — there is no delete tool, and leaving test items in
      // a client's backlog is not acceptable just because the MCP lacks one.
      try {
        // The RAW pat, not `pat` — which by now holds the BASE64 the MCP wants.
        // Encoding that again produces Basic base64(":" + base64(...)), which
        // Azure DevOps answers with a 404 that reads like a missing work item.
        // It is not: it is a credential this script mangled, and the cost is a
        // test item left behind in a client's backlog.
        const rawPat = process.env.ADO_PAT || process.env.MCP_TOKEN_FOR_AZURE || "";
        const auth = "Basic " + Buffer.from(`:${rawPat}`).toString("base64");
        const del = await fetch(
          `https://dev.azure.com/${encodeURIComponent(ORG)}/${encodeURIComponent(PROJECT)}` +
          `/_apis/wit/workitems/${created}?api-version=7.1`,
          { method: "DELETE", headers: { Authorization: auth } });
        del.ok ? ok("deleting it again, so nothing is left behind", `#${created} removed`)
               : bad("deleting it again", `HTTP ${del.status} — delete work item #${created} by hand`);
      } catch (err) { bad("deleting it again", `${err.message} — delete #${created} by hand`); }
    }
  }
}

stop();
console.log(`\n\x1b[1m${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""}\x1b[0m`);
if (!fail && !WRITE) console.log(`\nRe-run with \x1b[1m--write\x1b[0m to prove work item creation end to end.`);
process.exit(fail ? 1 : 0);
