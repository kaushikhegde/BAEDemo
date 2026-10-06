import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * The `app` stage's attach step named `generated-apps/"{project}"/index.html`.
 *
 * `swap()` quotes `<project>` because it builds SHELL commands. `attachFiles`
 * reused it for FILE PATHS, which are never shell-parsed, so the quotes became
 * part of the path and every companion-app run blocked on "Expected output not
 * produced" after rendering successfully.
 */
test("the app stage attaches generated-apps/{project}/index.html, unquoted", () => {
  const repo = resolve(import.meta.dirname, "..");
  const dir = mkdtempSync(join(tmpdir(), "scyne-attach-"));
  const probe = join(dir, "probe.mts");
  writeFileSync(probe, [
    `import { pathToFileURL } from "node:url";`,
    `const { buildWorkflows } = await import(pathToFileURL(${JSON.stringify(join(repo, "orchestrator.workflows.ts"))}).href);`,
    `const app = buildWorkflows().find((w) => w.key === "app");`,
    `console.log(JSON.stringify(app.steps.filter((s) => s.type === "attach").flatMap((s) => s.files)));`,
  ].join("\n"));

  const out = execFileSync(join(repo, "node_modules", ".bin", "tsx"), [probe], { cwd: repo, encoding: "utf8" });
  const files = JSON.parse(out.trim().split("\n").pop());

  assert.ok(files.includes("generated-apps/{project}/index.html"), `attach files: ${files.join(", ")}`);
  assert.ok(!files.some((f) => f.includes('"')), `a quote reached a file path: ${files.join(", ")}`);
});
