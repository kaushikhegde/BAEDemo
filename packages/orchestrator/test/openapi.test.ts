import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ROUTES } from "../src/http/router.js";

const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));

const declared = new Set<string>(
  Object.entries(spec.paths).flatMap(([p, ops]: [string, any]) =>
    Object.keys(ops).map(m => `${m.toUpperCase()} ${p}`)));

const implemented = new Set(ROUTES.map(r => `${r.method} ${r.path}`));

describe("openapi contract", () => {
  it("documents every implemented route", () => {
    const undocumented = [...implemented].filter(r => !declared.has(r));
    expect(undocumented, `undocumented routes: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("implements every documented route", () => {
    const unimplemented = [...declared].filter(r => !implemented.has(r));
    expect(unimplemented, `documented but missing: ${unimplemented.join(", ")}`).toEqual([]);
  });

  it("gives every operation a summary and at least one response", () => {
    for (const [p, ops] of Object.entries<any>(spec.paths)) {
      for (const [m, op] of Object.entries<any>(ops)) {
        expect(op.summary, `${m.toUpperCase()} ${p} has no summary`).toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length, `${m.toUpperCase()} ${p} has no responses`).toBeGreaterThan(0);
      }
    }
  });
});
