import { describe, it, expect } from "vitest";
import {
  hashPassword, verifyPassword, mintToken, hashToken, tokenPrefix, looksLikeToken,
  bearerFrom, atLeast, effectiveProjectRole, isGlobalRole, isProjectRole,
  sessionExpiry, TOKEN_PREFIX,
} from "../src/core/auth.js";

describe("passwords", () => {
  it("round-trips, and rejects the wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("never stores the password, and salts so two identical passwords differ", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toContain("same-password");
    expect(a).not.toBe(b);                       // different salts
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("records its own cost parameters, so they can be raised without invalidating old hashes", async () => {
    const stored = await hashPassword("x");
    const [scheme, n, r, p] = stored.split("$");
    expect(scheme).toBe("scrypt");
    expect(Number(n)).toBeGreaterThanOrEqual(2 ** 14);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
  });

  it("treats a null, empty, malformed or hostile hash as a failed verify rather than throwing", async () => {
    for (const bad of [null, "", "not-a-hash", "scrypt$$$$", "scrypt$1$1$1$zz$zz",
                       "bcrypt$1$1$1$aa$bb", "scrypt$999999999$8$1$aa$bb"]) {
      await expect(verifyPassword("x", bad as string | null)).resolves.toBe(false);
    }
  });

  it("refuses to hash an empty password rather than storing a usable one", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });
});

describe("api tokens", () => {
  it("mints a recognisable secret, and stores only its hash and prefix", () => {
    const t = mintToken();
    expect(t.secret.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(t.hash).toHaveLength(64);
    expect(t.hash).not.toContain(t.secret);
    expect(t.secret.startsWith(t.prefix)).toBe(true);
    expect(t.prefix.length).toBeLessThan(t.secret.length);   // a prefix is not the token
  });

  it("is unguessable — no two mints collide", () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintToken().secret));
    expect(seen.size).toBe(500);
  });

  it("hashes deterministically, so a presented token can be looked up", () => {
    const t = mintToken();
    expect(hashToken(t.secret)).toBe(t.hash);
    expect(tokenPrefix(t.secret)).toBe(t.prefix);
    expect(hashToken(t.secret + "x")).not.toBe(t.hash);
  });

  it("recognises its own token shape and rejects near-misses", () => {
    expect(looksLikeToken(mintToken().secret)).toBe(true);
    expect(looksLikeToken("scy_")).toBe(false);          // prefix alone
    expect(looksLikeToken("ghp_abcdefghijklmno")).toBe(false);
    expect(looksLikeToken(undefined)).toBe(false);
    expect(looksLikeToken(null)).toBe(false);
  });
});

describe("bearer extraction", () => {
  it("reads Authorization: Bearer, case-insensitively, and tolerates spacing", () => {
    expect(bearerFrom({ authorization: "Bearer abc" })).toBe("abc");
    expect(bearerFrom({ authorization: "bearer   abc  " })).toBe("abc");
    expect(bearerFrom({ Authorization: "Bearer abc" })).toBe("abc");
  });

  it("reads the bare X-Scyne-Token header too", () => {
    expect(bearerFrom({ "x-scyne-token": "abc" })).toBe("abc");
  });

  it("returns null when there is nothing to read", () => {
    expect(bearerFrom({})).toBe(null);
    expect(bearerFrom({ authorization: "Basic abc" })).toBe(null);
    expect(bearerFrom({ authorization: "" })).toBe(null);
  });
});

describe("roles", () => {
  it("ranks project roles so a check can ask for 'at least'", () => {
    expect(atLeast("owner", "viewer")).toBe(true);
    expect(atLeast("editor", "editor")).toBe(true);
    expect(atLeast("viewer", "editor")).toBe(false);
    expect(atLeast("editor", "owner")).toBe(false);
    expect(atLeast(null, "viewer")).toBe(false);      // no membership is no access
  });

  it("gives an admin owner rights everywhere — otherwise an ownerless project is unrecoverable", () => {
    expect(effectiveProjectRole("admin", null)).toBe("owner");
    expect(effectiveProjectRole("admin", "viewer")).toBe("owner");
  });

  it("caps a global viewer at viewer, however they are granted", () => {
    expect(effectiveProjectRole("viewer", "owner")).toBe("viewer");
    expect(effectiveProjectRole("viewer", "editor")).toBe("viewer");
    expect(effectiveProjectRole("viewer", null)).toBe(null);
  });

  it("gives a member exactly what their membership says, and nothing without one", () => {
    expect(effectiveProjectRole("member", "editor")).toBe("editor");
    expect(effectiveProjectRole("member", null)).toBe(null);
  });

  it("validates role names", () => {
    expect(isGlobalRole("admin")).toBe(true);
    expect(isGlobalRole("owner")).toBe(false);        // that is a project role
    expect(isProjectRole("owner")).toBe(true);
    expect(isProjectRole("admin")).toBe(false);
  });
});

describe("sessions", () => {
  it("expires in the future, and within the stated window", () => {
    const now = Date.now();
    const exp = sessionExpiry(now).getTime();
    expect(exp).toBeGreaterThan(now);
    expect(exp - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});
