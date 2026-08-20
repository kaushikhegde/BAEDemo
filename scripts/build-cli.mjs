#!/usr/bin/env node
// Build the `scyne` CLI into a package a user can install WITHOUT cloning this
// repository.
//
// The CLI is unusually easy to detach, and deliberately so: every command goes
// over HTTP to the same API the browser uses, it has no npm dependency at all
// (only `node:` builtins and global `fetch`), and since cli/stages.ts it reads
// the stage catalogue from `GET /config` rather than from scripts/pipeline.mjs.
// So "ship the CLI" is bundling six files, not extracting a subsystem.
//
// Output: dist/cli/
//   scyne.mjs     one file, executable, no dependencies, readable
//   package.json  generated — the repo's own root package is `private: true`
//                 and carries the whole stack's scripts, so it can never be
//                 the thing published
//   README.md     install + point-at-a-server, which is all a user needs
//
// From there:
//   npm pack ./dist/cli            → a tarball to hand over or attach to a release
//   npm publish ./dist/cli         → a registry, public or private
//   cp dist/cli/scyne.mjs ~/bin/scyne   → no npm involved at all
//
// Not minified on purpose. This is a file people are asked to install from an
// email or a release page and run against their own credentials; being able to
// read it is worth more than the kilobytes.

import { build } from "esbuild";
import { mkdir, writeFile, rm, chmod, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "cli");

const PKG_NAME = process.env.SCYNE_CLI_NAME || "@scyne/cli";

const rootPkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = process.env.SCYNE_CLI_VERSION || rootPkg.version || "0.0.0";

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "cli", "index.ts")],
  outfile: path.join(outDir, "scyne.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  // Syntax target only — esbuild does not polyfill runtime APIs, and the two
  // this CLI needs (global `fetch`, `node:readline/promises`) both landed well
  // before Node 20. `engines` below is the honest floor.
  target: "node20",
  // No `banner` adding a shebang: esbuild HOISTS the entry file's own
  // `#!/usr/bin/env node` above its preamble already, and adding a second one
  // produces a file that installs perfectly and then fails every invocation
  // with `SyntaxError: Invalid or unexpected token` on line 2. The assertion
  // after the build is what keeps that from being discovered by a user.
  // Everything is a node: builtin; nothing to mark external, and a bare
  // specifier appearing here later should FAIL the build rather than be
  // silently left as a runtime import the package does not declare.
  external: [],
  legalComments: "inline",
  metafile: true,
});

const outFile = path.join(outDir, "scyne.mjs");
await chmod(outFile, 0o755);

// Prove the artefact is runnable before it is packaged. Both of these have
// already been shipped wrong by this script: a duplicated shebang, and a mode
// that is not executable. Neither shows up until a user runs it.
const built = await readFile(outFile, "utf8");
const lines = built.split("\n");
if (lines[0] !== "#!/usr/bin/env node") {
  throw new Error(`dist/cli/scyne.mjs must open with a shebang, found: ${JSON.stringify(lines[0]?.slice(0, 60))}`);
}
if (lines[1]?.startsWith("#!")) {
  throw new Error("dist/cli/scyne.mjs has TWO shebangs — the second is a syntax error at runtime");
}
{
  // Run it for real, so the help path is exercised end to end: parsed,
  // imported, executed. A bundle that throws on load fails HERE rather than on
  // somebody else's machine.
  //
  // `--help` and not a bare `scyne`, which opens the interactive session and
  // therefore wants a server. This is the one command that is entirely offline.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(process.execPath, [outFile, "--help"], {
    env: { ...process.env, SCYNE_HOME: path.join(outDir, ".probe-home") },
  }).catch(err => { throw new Error(`dist/cli/scyne.mjs failed to run: ${err.stderr || err.message}`); });
  if (!stdout.includes("the Scyne pipeline, from the command line")) {
    throw new Error("dist/cli/scyne.mjs ran but printed no help");
  }
  await rm(path.join(outDir, ".probe-home"), { recursive: true, force: true });
}

const pkg = {
  name: PKG_NAME,
  version,
  description: "Command-line client for the Scyne requirements pipeline.",
  type: "module",
  bin: { scyne: "scyne.mjs" },
  files: ["scyne.mjs", "README.md"],
  // No dependencies, and this is load-bearing: `npm i -g` on a locked-down
  // machine pulls nothing from the network beyond this package itself.
  dependencies: {},
  engines: { node: ">=20" },
  license: rootPkg.license || "UNLICENSED",
  ...(rootPkg.repository ? { repository: rootPkg.repository } : {}),
};
await writeFile(path.join(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

await writeFile(path.join(outDir, "README.md"), `# ${PKG_NAME}

The \`scyne\` command line client.

Everything it does goes over HTTP to a Scyne orchestrator, so this package is
the client only — there is no engine, no database and no workspace here, and
nothing to clone.

## Install

\`\`\`bash
npm install -g ${PKG_NAME}
\`\`\`

Or, with no registry involved, from a tarball you were sent:

\`\`\`bash
npm install -g ./scyne-cli-${version}.tgz
\`\`\`

Requires **Node 20 or newer** (\`node --version\`). It has no dependencies.

## Point it at your server, and sign in

\`\`\`bash
scyne login --api-url https://scyne.example.com
scyne whoami
\`\`\`

The server URL and session are kept in \`~/.scyne/config.json\`, written 0600
inside a 0700 directory because it holds a token. \`SCYNE_API_URL\` overrides
the stored URL for one shell; \`SCYNE_HOME\` moves the whole directory.

## Everyday use

\`\`\`bash
scyne use <project> [<feature>]   # pin a target, so later commands need no flags
scyne run                          # what this server can run
scyne run requirements             # start a stage
scyne status SCY-7                 # activity, work products, gates
scyne gate list                    # what is waiting for approval
scyne run pause  SCY-7 [--force]   # stop a run: gracefully, or now
scyne run cancel SCY-7
scyne logout
\`\`\`

\`scyne\` on its own lists every command.

## Upgrading

\`\`\`bash
npm install -g ${PKG_NAME}@latest
\`\`\`

The stage list comes from the server at call time rather than from this
package, so a server that gains a stage does not need every user to upgrade
before they can run it.
`);

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`✓ dist/cli/scyne.mjs   ${(bytes / 1024).toFixed(1)} KB, 0 dependencies`);
console.log(`  ${PKG_NAME}@${version}, node >=20`);
console.log(``);
console.log(`  hand over a tarball : npm pack ./dist/cli`);
console.log(`  publish to registry : npm publish ./dist/cli`);
console.log(`  no npm at all       : cp dist/cli/scyne.mjs ~/bin/scyne`);
