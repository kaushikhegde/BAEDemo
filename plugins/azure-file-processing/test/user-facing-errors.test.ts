import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { userError, serviceError, authError } from "../src/shared/errors.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
};

/**
 * This plugin is installed by END USERS.
 *
 * They have no checkout of this repository, no `.env`, no shell on the machine
 * serving the MCP planes, and no way to start or configure anything. Until this
 * guard existed, failures told them otherwise — `npm run dev` from the repo
 * root, `set SCYNE_ORCH_TOKEN`, `npm run sync:docs -- --apply` — and two call
 * sites spliced 300–400 characters of a server response straight into the
 * conversation.
 *
 * The rule is WHO CAN ACT: `userError` for a caller who can fix it, and their
 * message survives verbatim; `serviceError` / `authError` for one who cannot,
 * and they get a reference while the cause goes to the operator's log.
 *
 * Enforced STRUCTURALLY rather than by grepping prose. A regex over English is
 * a guess about what a future message might say; "every failure in a tool goes
 * through one of the two constructors" is checkable, and it catches the leak at
 * the moment someone adds a tool rather than after they ship one.
 */
describe("what an end user is allowed to be told", () => {
  it("no tool throws a bare Error — every failure is classified", async () => {
    const tools = (await walk(SRC)).filter(f =>
      f.includes(`workspace${sep}tools${sep}`) || f.includes(`orchestrator${sep}tools${sep}`));
    expect(tools.length).toBeGreaterThan(15);

    const offenders: string[] = [];
    for (const f of tools) {
      if (/throw new Error\(/.test(await readFile(f, "utf8"))) offenders.push(relative(SRC, f));
    }
    expect(
      offenders,
      `bare throws leave it to prose whether an end user can act: ${offenders.join(", ")}. ` +
      `Use userError(code, message) or serviceError(code, cause) from shared/errors.ts.`,
    ).toEqual([]);
  });

  it("nothing user-reachable names a repo command, an env var, or a host", async () => {
    // Scoped to what is THROWN or DESCRIBED, because a default like
    // `http://127.0.0.1:8081` in config.ts is configuration, not a message.
    const banned = [
      { re: /npm run |stack\.sh|scripts\/[\w-]+\.mjs/, why: "a command the caller cannot run" },
      { re: /SCYNE_[A-Z_]+|WORKSPACE_PATH/, why: "an environment variable they cannot set" },
      { re: /repo root|workspace root/, why: "a directory they do not have" },
    ];

    const offenders: string[] = [];
    for (const f of await walk(SRC)) {
      const text = await readFile(f, "utf8");
      // Every throw argument and every MCP tool `description:`, comments excluded.
      const reachable = [
        ...text.matchAll(/throw (?:new Error|userError|serviceError|authError)\(([\s\S]{0,600}?)\);/g),
        ...text.matchAll(/description:\s*([\s\S]{0,1200}?),\n\s*inputSchema/g),
      ].map(m => m[1].split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n"));

      for (const chunk of reachable) {
        for (const b of banned) {
          if (b.re.test(chunk)) offenders.push(`${relative(SRC, f)}: ${b.why} — ${chunk.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("the two constructors", () => {
  it("userError keeps the message, because the caller can act on it", () => {
    const e = userError("ambiguous_kind", "pass kind: sop | transcripts | notes | ui");
    expect(e.message).toBe("ambiguous_kind: pass kind: sop | transcripts | notes | ui");
  });

  it("serviceError tells them nothing except a reference", () => {
    const e = serviceError("service_unavailable", new Error("connect ECONNREFUSED 127.0.0.1:4000"));
    expect(e.message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|4000/);
    expect(e.message).toMatch(/^service_unavailable: /);
    expect(e.message).toMatch(/reference [0-9a-f]{8}/);
  });

  it("promises nothing was changed only when that is true", () => {
    expect(serviceError("x", "y").message).toMatch(/Nothing was changed/);
    // A half-landed upload must not be reported as a no-op: "nothing was
    // changed" is a promise, and a wrong one sends somebody looking in the
    // wrong place.
    expect(serviceError("x", "y", { nothingChanged: false }).message).not.toMatch(/Nothing was changed/);
  });

  it("gives each failure its own reference, so a log line can be found", () => {
    const a = serviceError("x", "y").message.match(/reference (\w+)/)![1];
    const b = serviceError("x", "y").message.match(/reference (\w+)/)![1];
    expect(a).not.toBe(b);
  });

  it("survives a cause too long for the logger, rather than throwing while reporting", () => {
    // The logger REFUSES a field over 512 chars. An error path that fails while
    // reporting an error leaves no record at all — worse than a long line.
    expect(() => serviceError("x", "z".repeat(5000))).not.toThrow();
  });

  it("authError is a service failure — the credential is the installation's, not the caller's", () => {
    const e = authError("refused");
    expect(e.message).toMatch(/^not_authenticated: /);
    expect(e.message).not.toMatch(/SCYNE_ORCH_TOKEN|token/i);
  });
});
