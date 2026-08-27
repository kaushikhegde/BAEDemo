import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const skill = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../skills/scyne/SKILL.md"), "utf8");

describe("SKILL.md — one skill, both planes", () => {
  it("covers the WORKSPACE plane too, not only the file plane", () => {
    // Three skills became one so there is a single `/scyne` to invoke. The
    // merge is only correct if nothing was dropped: the workspace verbs and
    // the file-plane sequence must both survive in the same file.
    for (const token of ["start_stage", "ingest_document", "approve_gate",
                         "revise_artefact", "stages", "spend"]) {
      expect(skill, token).toContain(token);
    }
  });

  it("leads with the rule, before any verb table", () => {
    // The single most important constraint in the plugin. Buried under a
    // dispatch table it is a rule nobody reads.
    const rule = skill.toLowerCase().indexOf("never read a document yourself");
    const verbs = skill.indexOf("## Verbs");
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(verbs);
  });

  it("is invoked with a slash, and no example says otherwise", () => {
    // Claude Code sources slash commands from a `commands/` directory, which
    // this plugin ships. The heading is what a reader copies.
    expect(skill.split("\n").find((l) => l.startsWith("# "))).toBe("# /scyne");
    expect(skill).toMatch(/`\/scyne <verb>`/);
  });

  it("has frontmatter naming the skill and when to use it", () => {
    expect(skill).toMatch(/^---\nname: scyne\ndescription: /);
  });

  it("names every tool the model needs, in the order they are called", () => {
    // upload_file leads: one call replaces create_upload_url + shasum +
    // upload.mjs + start_job, and a skill that documents the fallback first
    // is a skill that gets the fallback used first.
    const order = ["upload_file", "job_status",
                   "get_result", "search_chunks", "fetch_chunks"];
    let at = -1;
    for (const token of order) {
      const found = skill.indexOf(token, at + 1);
      expect(found, `${token} missing or out of order`).toBeGreaterThan(at);
      at = found;
    }
  });

  it("names the retry for a FAILED document, beside the advice to wait", () => {
    // "usually means wait, not re-run" is right for a document still
    // extracting and wrong for one that failed — a scanned PDF with no text
    // layer never becomes ready on its own. The two have to sit together, or a
    // model that reads only the first keeps counselling patience about a
    // document nothing is working on.
    const wait = skill.indexOf("documents_not_ready");
    expect(wait, "documents_not_ready missing").toBeGreaterThan(-1);
    const retry = skill.indexOf("retry_extraction", wait);
    expect(retry, "retry_extraction not named after the advice to wait").toBeGreaterThan(wait);
    expect(retry - wait).toBeLessThan(900);
  });

  it("tells the model never to read the file itself", () => {
    expect(skill.toLowerCase()).toMatch(/never (read|open).{0,40}(file|document)/);
  });

  it("still documents the presigned-URL fallback, after the one-call path", () => {
    const primary = skill.indexOf("upload_file");
    for (const token of ["create_upload_url", "upload.mjs", "start_job"]) {
      expect(skill.indexOf(token), `${token} missing`).toBeGreaterThan(primary);
    }
  });

  it("tells the model what to do when the stack is down", () => {
    expect(skill).toContain("stack.sh up");
    expect(skill).toContain("/health");
  });
});
