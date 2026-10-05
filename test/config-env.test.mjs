import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * `.env` has to be loaded before `orchestrator.workflows.ts` is evaluated.
 *
 * That module reads PUBLISH_TARGET at load time, and ESM evaluates a module's
 * imports before its body — so a `.env` loop in the body of
 * `orchestrator.config.ts` ran AFTER the workflows had already been compiled
 * against the default, `atlassian`. `PUBLISH_TARGET=none` in `.env` was
 * ignored, and an approved gate went on to create a Confluence space.
 */
test("PUBLISH_TARGET=none in .env compiles workflows with no publish step", () => {
  const root = mkdtempSync(join(tmpdir(), "scyne-env-"));
  writeFileSync(join(root, ".env"), "PUBLISH_TARGET=none\n");

  const repo = resolve(import.meta.dirname, "..");
  const env = { ...process.env, SCYNE_INSTALL_ROOT: root };
  delete env.PUBLISH_TARGET;

  const probe = join(root, "probe.mts");
  writeFileSync(probe, [
    `import { pathToFileURL } from "node:url";`,
    `const cfg = (await import(pathToFileURL(${JSON.stringify(join(repo, "orchestrator.config.ts"))}).href)).default;`,
    `const caps = cfg.workflows.find((w) => w.key === "capabilities");`,
    `console.log(JSON.stringify(caps.steps.map((s) => s.phase ?? s.type)));`,
  ].join("\n"));

  const out = execFileSync(join(repo, "node_modules", ".bin", "tsx"), [probe],
    { cwd: repo, env, encoding: "utf8" });

  const phases = JSON.parse(out.trim().split("\n").pop());
  assert.ok(phases.length > 0, "capabilities compiled no steps");
  assert.ok(!phases.includes("publish"), `publish step still compiled: ${phases.join(" ")}`);
});
