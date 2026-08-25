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
    const order = ["create_upload_url", "upload.mjs", "start_job", "job_status",
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

  it("tells the model what to do when the stack is down", () => {
    expect(skill).toContain("stack.sh up");
    expect(skill).toContain("/health");
  });
});
