// Identity: password hashing, API tokens, sessions.
//
// scrypt rather than argon2id, deliberately. argon2 is the better function on
// paper, but every implementation for Node is a native module, which means a
// node-gyp toolchain on every machine the plugin is installed on — a build
// failure on a client laptop is a support call, and this package currently has
// three runtime dependencies. scrypt is in node:crypto, is a memory-hard KDF
// specified in RFC 7914, and needs nothing installed.
//
// Two different hashes are used here and the difference matters:
//
//   passwords  scrypt, salted, deliberately slow. A stolen table must stay
//              expensive to attack.
//   tokens     SHA-256, unsalted, fast. A token is 256 bits of randomness we
//              generated, not a human-chosen secret, so there is nothing to
//              brute-force and a slow hash would only make every authenticated
//              request slower.

import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer, salt: string | Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt needs roughly `128 * N * r` bytes, and Node caps that at 32 MB unless
 * told otherwise — which the parameters below land exactly on, so the default
 * refuses them outright with "memory limit exceeded". The ceiling is therefore
 * derived from the parameters rather than fixed, so that a hash written with
 * OLD parameters still verifies after the cost is raised: the alternative is a
 * constant that silently locks every existing user out the day it changes.
 */
const maxmemFor = (N: number, r: number): number => 2 * 128 * N * r;

/**
 * Cost parameters. N=2^15 puts a single hash at roughly 100ms on current
 * hardware — slow enough to matter to an attacker with a stolen table, fast
 * enough that a login does not feel broken. Encoded INTO the stored string so
 * that raising them later does not invalidate existing hashes: an old hash
 * still verifies with the parameters it was written with.
 */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEYLEN = 64;
const SALT_BYTES = 16;

/** `scrypt$N$r$p$salt$hash`, all base64url. Self-describing, so it can be re-tuned. */
export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error("password must not be empty");
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEYLEN, { ...SCRYPT, maxmem: maxmemFor(SCRYPT.N, SCRYPT.r) });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored || !password) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(keyB64, "base64url");
  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: maxmemFor(Number(n), Number(r)),
    });
  } catch {
    return false;   // a corrupt or hostile parameter set is a failed verify, not a crash
  }
  // Length must match before timingSafeEqual, which throws on a mismatch —
  // and a throw here would be an oracle for the hash length.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * A minted token. `secret` is returned exactly once and never stored; what
 * goes in the database is `hash`, plus `prefix` so a person can recognise
 * which row a token belongs to without the row being enough to use it.
 */
export interface MintedToken {
  secret: string;
  hash: string;
  prefix: string;
}

/** Distinguishes a Scyne token on sight, in a log or a pasted config file. */
export const TOKEN_PREFIX = "scy_";
const TOKEN_BYTES = 32;             // 256 bits
const PREFIX_LENGTH = TOKEN_PREFIX.length + 8;

export function mintToken(): MintedToken {
  const secret = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
  return { secret, hash: hashToken(secret), prefix: secret.slice(0, PREFIX_LENGTH) };
}

/** SHA-256, hex. See the header for why this is not scrypt. */
export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** The prefix a stored row records for `secret`, used to look a token up cheaply. */
export function tokenPrefix(secret: string): string {
  return secret.slice(0, PREFIX_LENGTH);
}

export function looksLikeToken(value: string | undefined | null): boolean {
  return typeof value === "string" && value.startsWith(TOKEN_PREFIX) && value.length > PREFIX_LENGTH;
}

/**
 * Pull a bearer credential out of the request headers a router hands us.
 * Accepts `Authorization: Bearer <t>` and the bare `X-Scyne-Token: <t>`, the
 * second because a shell doing `curl -H` gets it wrong less often.
 */
export function bearerFrom(headers: Record<string, unknown>): string | null {
  const auth = headers["authorization"] ?? headers["Authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const direct = headers["x-scyne-token"] ?? headers["X-Scyne-Token"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return null;
}

// ------------------------------------------------------------------- roles

/** Global roles: what KIND of thing a user may do, anywhere. */
export const GLOBAL_ROLES = ["admin", "member", "viewer"] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

/** Per-project roles: which projects they may do it to. */
export const PROJECT_ROLES = ["owner", "editor", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/**
 * Ranked so a check can ask "at least this much" rather than enumerating.
 * `owner` is not merely a higher editor: it is the only role that may change
 * who else has access.
 */
const PROJECT_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };

export function atLeast(held: ProjectRole | null, required: ProjectRole): boolean {
  if (!held) return false;
  return PROJECT_RANK[held] >= PROJECT_RANK[required];
}

export function isGlobalRole(v: string): v is GlobalRole {
  return (GLOBAL_ROLES as readonly string[]).includes(v);
}
export function isProjectRole(v: string): v is ProjectRole {
  return (PROJECT_ROLES as readonly string[]).includes(v);
}

/**
 * The effective role a user holds on a project.
 *
 * An `admin` holds `owner` everywhere — otherwise an administrator could not
 * repair a project whose only owner has left, which is exactly when
 * administration is needed. A global `viewer` is capped at `viewer` however
 * they are granted, because that role exists to be a read-only account and a
 * membership must not be able to promote past it.
 */
export function effectiveProjectRole(
  globalRole: string, membership: ProjectRole | null,
): ProjectRole | null {
  if (globalRole === "admin") return "owner";
  if (globalRole === "viewer") return membership ? "viewer" : null;
  return membership;
}

/** Session lifetime. Long enough not to interrupt a working day, short enough to expire. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function sessionExpiry(now: number = Date.now()): Date {
  return new Date(now + SESSION_TTL_MS);
}
