import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const skill = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../skills/azure-file-processing/SKILL.md"), "utf8");

describe("SKILL.md", () => {
  it("has frontmatter naming the skill and when to use it", () => {
    expect(skill).toMatch(/^---\nname: azure-file-processing\ndescription: /);
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

  it("tells the model never to read the file itself", () => {
    expect(skill.toLowerCase()).toMatch(/never (read|open).{0,40}(file|document)/);
  });

  it("still documents the SAS fallback, after the one-call path", () => {
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
