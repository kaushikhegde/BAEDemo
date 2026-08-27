import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteBucketCommand } from "@aws-sdk/client-s3";
import { loadConfig, WORKSPACE } from "../src/shared/config.js";
import {
  getStorage, ensureStorage, ensureWorkspaceBucket, deleteObjects, listObjects, putObject,
} from "../src/shared/storage.js";
import { syncUp, syncDown, syncStatus } from "../src/workspace/sync.js";

const cfg = loadConfig();
const s = getStorage(cfg);
let root: string;
const PROJ = "SYNCTEST";

const write = (rel: string, body: string) => {
  const p = join(root, "projects", PROJ, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};

const bucket = () => s.bucket(WORKSPACE);

const wipeRemote = async () => {
  const keys: string[] = [];
  for await (const o of listObjects(s, bucket(), `${PROJ}/`)) keys.push(o.key);
  if (keys.length) await deleteObjects(s, bucket(), keys);
};

beforeAll(async () => {
  try {
    await ensureStorage(s);
    await ensureWorkspaceBucket(s);
  } catch (e) {
    throw new Error("LocalStack is not reachable. Run ./scripts/stack.sh up first.\n" + String(e));
  }
});

beforeEach(async () => {
  await wipeRemote();
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "ws-sync-"));
});

afterAll(async () => {
  await wipeRemote();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("syncUp / syncDown", () => {
  it("round-trips a tree byte-for-byte", async () => {
    write("documents/policy.md", "# policy\n");
    write("MVP/requirements/SOP/a.md", "alpha");
    const up = await syncUp(s, root, PROJ);
    expect(up.pushed).toBe(2);

    rmSync(join(root, "projects", PROJ), { recursive: true, force: true });
    const down = await syncDown(s, root, PROJ);
    expect(down.pulled).toBe(2);

    expect(readFileSync(join(root, "projects", PROJ, "documents/policy.md"), "utf8")).toBe("# policy\n");
    expect(readFileSync(join(root, "projects", PROJ, "MVP/requirements/SOP/a.md"), "utf8")).toBe("alpha");
  });

  it("skips unchanged files on a second push", async () => {
    write("documents/policy.md", "same");
    expect((await syncUp(s, root, PROJ)).pushed).toBe(1);
    const again = await syncUp(s, root, PROJ);
    expect(again.pushed).toBe(0);
    expect(again.skipped).toBe(1);
  });

  it("pushes a changed file on the second pass", async () => {
    write("documents/policy.md", "v1");
    await syncUp(s, root, PROJ);
    write("documents/policy.md", "v2");
    expect((await syncUp(s, root, PROJ)).pushed).toBe(1);
  });

  it("NEVER deletes: an object absent locally survives syncUp", async () => {
    write("documents/a.md", "a");
    write("documents/b.md", "b");
    await syncUp(s, root, PROJ);
    rmSync(join(root, "projects", PROJ, "documents/b.md"));
    await syncUp(s, root, PROJ);
    const st = await syncStatus(s, root, PROJ);
    expect(st.onlyRemote).toContain(`${PROJ}/documents/b.md`);
  });

  it("NEVER deletes: a local file absent in S3 survives syncDown", async () => {
    write("documents/a.md", "a");
    await syncUp(s, root, PROJ);
    write("documents/local-only.md", "keep me");
    await syncDown(s, root, PROJ);
    expect(existsSync(join(root, "projects", PROJ, "documents/local-only.md"))).toBe(true);
  });

  it("S3 wins on syncDown", async () => {
    write("documents/x.md", "from S3");
    await syncUp(s, root, PROJ);
    write("documents/x.md", "local edit");
    await syncDown(s, root, PROJ);
    expect(readFileSync(join(root, "projects", PROJ, "documents/x.md"), "utf8")).toBe("from S3");
  });

  it("narrows to a prefix", async () => {
    write("documents/p.md", "p");
    write("MVP/requirements/SOP/s.md", "s");
    const up = await syncUp(s, root, PROJ, { prefix: "MVP/requirements" });
    expect(up.pushed).toBe(1);
    const st = await syncStatus(s, root, PROJ);
    expect(st.onlyLocal).toContain(`${PROJ}/documents/p.md`);
  });

  it("dryRun moves nothing", async () => {
    write("documents/p.md", "p");
    const up = await syncUp(s, root, PROJ, { dryRun: true });
    expect(up.pushed).toBe(1); // reports what it WOULD do
    expect((await syncStatus(s, root, PROJ)).onlyLocal).toContain(`${PROJ}/documents/p.md`);
  });

  it("dryRun on syncDown leaves the local tree untouched", async () => {
    write("documents/a.md", "a");
    await syncUp(s, root, PROJ);
    rmSync(join(root, "projects", PROJ), { recursive: true, force: true });
    const down = await syncDown(s, root, PROJ, { dryRun: true });
    expect(down.pulled).toBe(1); // reports what it WOULD do
    expect(existsSync(join(root, "projects", PROJ, "documents/a.md"))).toBe(false);
  });

  it("leaves no temp files behind after a normal syncDown", async () => {
    write("documents/a.md", "a");
    await syncUp(s, root, PROJ);
    rmSync(join(root, "projects", PROJ), { recursive: true, force: true });
    await syncDown(s, root, PROJ);
    const names = readdirSync(join(root, "projects", PROJ, "documents"));
    expect(names).toEqual(["a.md"]);
  });
});

describe("syncStatus", () => {
  it("reports a file changed on both sides as differing", async () => {
    write("documents/x.md", "one");
    await syncUp(s, root, PROJ);
    write("documents/x.md", "two");
    const st = await syncStatus(s, root, PROJ);
    expect(st.differing).toEqual([`${PROJ}/documents/x.md`]);
  });

  it("mutates nothing", async () => {
    write("documents/x.md", "one");
    await syncStatus(s, root, PROJ);
    const st = await syncStatus(s, root, PROJ);
    expect(st.onlyLocal).toEqual([`${PROJ}/documents/x.md`]);
  });

  it("does not throw on a workspace whose bucket has never been created", async () => {
    // syncUp and syncDown both call ensureWorkspaceBucket; syncStatus did not,
    // and ListObjectsV2 against a bucket that does not exist throws
    // NoSuchBucket rather than returning an empty list. "What's out of sync?"
    // is the first command anyone runs against a brand new workspace, so a
    // first-run-ever must not blow up here.
    await wipeRemote(); // a bucket must be empty before S3 will delete it
    await s.s3.send(new DeleteBucketCommand({ Bucket: bucket() }));
    try {
      const st = await syncStatus(s, root, PROJ);
      expect(st).toEqual({ onlyLocal: [], onlyRemote: [], differing: [], same: 0 });
    } finally {
      // Restore for every test that runs after this one in the file.
      await ensureWorkspaceBucket(s);
    }
  });
});

describe("scope validation: project/prefix are untrusted strings too", () => {
  // localManifest's project/prefix are not segment-validated, deliberately.
  // Left unchecked, a project like "../../etc" resolves via path.join to a
  // directory OUTSIDE root/projects/ entirely, and localManifest would walk
  // real files there before objectKeyFor's own guard ever got a chance to
  // throw. The sync layer validates project/prefix once, up front, in every
  // exported entry point.
  it("refuses a project name that would climb out of the workspace", async () => {
    await expect(syncStatus(s, root, "../evil")).rejects.toThrow(/climb/);
    await expect(syncUp(s, root, "../evil")).rejects.toThrow(/climb/);
    await expect(syncDown(s, root, "../evil")).rejects.toThrow(/climb/);
  });

  it("refuses a project name containing a path separator", async () => {
    await expect(syncStatus(s, root, "SAPN/other")).rejects.toThrow(/separator/);
  });

  it("refuses a prefix with a climbing segment", async () => {
    write("documents/a.md", "a");
    await expect(syncUp(s, root, PROJ, { prefix: "documents/../../../etc" })).rejects.toThrow(/climb/);
  });

  it("refuses a prefix with an empty segment (embedded //)", async () => {
    write("documents/a.md", "a");
    await expect(syncStatus(s, root, PROJ, "documents//sub")).rejects.toThrow(/is empty/);
  });

  it("tolerates a prefix with a leading/trailing slash", async () => {
    write("documents/a.md", "a");
    await expect(syncUp(s, root, PROJ, { prefix: "/documents/" })).resolves.toMatchObject({ pushed: 1 });
  });
});

describe("syncDown and a hostile object key", () => {
  // localPathFor validates a key's segments and THROWS, deliberately: S3 is
  // the source of truth, so a key enumerated off ListObjectsV2 is untrusted
  // input, exactly like a string that arrived over a network socket.
  //
  // It is a SHARPER rule here than it was on blob storage. An S3 key is one
  // opaque UTF-8 string with no structure the service enforces at all — the
  // slashes are a display convention — so `PROJ/../../evil.txt` is not merely
  // conceivable, it is a perfectly ordinary key that any writer to the bucket
  // can create, and it comes back off a LIST looking exactly like a path.
  // Azure's SDK resolved ".." away in its own URL builder before a request was
  // ever sent, which meant that shape could not be manufactured end-to-end
  // there and this test had to settle for an empty segment. Here both are
  // testable, so both are tested.
  const hostile = [
    ["a climbing segment", `${PROJ}/../../evil.txt`],
    ["an empty segment", `${PROJ}//evil.txt`],
  ] as const;

  for (const [what, hostileKey] of hostile) {
    it(`skips ${what}, logs it, and still pulls every legitimate file`, async () => {
      write("documents/safe.md", "safe");
      await syncUp(s, root, PROJ);

      await putObject(s, bucket(), hostileKey, "evil");

      // The hostile entry does show up in a plain status report — syncStatus
      // never touches disk, so it has nothing to refuse.
      const st = await syncStatus(s, root, PROJ);
      expect(st.onlyRemote).toContain(hostileKey);

      rmSync(join(root, "projects", PROJ, "documents/safe.md"));
      const down = await syncDown(s, root, PROJ);

      // The legitimate file still came down...
      expect(down.pulled).toBe(1);
      expect(readFileSync(join(root, "projects", PROJ, "documents/safe.md"), "utf8")).toBe("safe");
      // ...syncDown did not throw and abort the whole sync over the bad key...
      // ...and nothing was ever written for the hostile entry, anywhere.
      expect(existsSync(join(root, "projects", PROJ, "evil.txt"))).toBe(false);
      expect(existsSync(join(root, "projects", "evil.txt"))).toBe(false);
      expect(existsSync(join(root, "evil.txt"))).toBe(false);

      await deleteObjects(s, bucket(), [hostileKey]);
    });
  }
});

describe("crash recovery: a syncDown killed between download and rename", () => {
  // syncDown downloads to "<dest>.sync-<uuid>.tmp" and renames it into place —
  // that is what makes a single file's write atomic (see sync.ts). A SIGKILL
  // in the gap between the download finishing and the rename running (this
  // orchestrator's "Pause now" / "Cancel" do exactly that) leaves the temp
  // file behind, permanently, unless something accounts for it. Simulated
  // here by writing the orphan by hand rather than actually killing a process
  // mid-flight — the on-disk state is identical either way.

  it("excludes a stale .tmp orphan from every manifest view, so syncUp never pushes it", async () => {
    write("documents/a.md", "a");
    const orphan = join(
      root, "projects", PROJ, "documents",
      "a.md.sync-11111111-1111-4111-8111-111111111111.tmp",
    );
    writeFileSync(orphan, "half-downloaded garbage from a killed run");

    // The orphan must not even show up as "only local" — it should be
    // invisible to the manifest walk entirely, not merely excluded from what
    // gets pushed.
    const before = await syncStatus(s, root, PROJ);
    expect(before.onlyLocal).toEqual([`${PROJ}/documents/a.md`]);

    const up = await syncUp(s, root, PROJ);
    expect(up.pushed).toBe(1); // a.md only

    const after = await syncStatus(s, root, PROJ);
    expect(after.onlyRemote).toEqual([]);
    expect(after.same).toBe(1);
    expect(existsSync(orphan)).toBe(true); // the exclusion doesn't delete it either
  });

  const setMtime = (path: string, ageMs: number) => {
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
  };
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  it("removes a stale (>6h old) .tmp sibling before writing its destination on the next syncDown", async () => {
    write("documents/a.md", "a");
    await syncUp(s, root, PROJ);
    rmSync(join(root, "projects", PROJ, "documents/a.md"));
    mkdirSync(join(root, "projects", PROJ, "documents"), { recursive: true });
    const staleTmp = join(
      root, "projects", PROJ, "documents",
      "a.md.sync-22222222-2222-4222-8222-222222222222.tmp",
    );
    writeFileSync(staleTmp, "leftover from an earlier killed syncDown");
    setMtime(staleTmp, SIX_HOURS_MS + 60_000); // just over the threshold

    await syncDown(s, root, PROJ);

    expect(existsSync(staleTmp)).toBe(false);
    expect(readFileSync(join(root, "projects", PROJ, "documents/a.md"), "utf8")).toBe("a");
  });

  it("sweeps a stale (>6h) temp file but leaves a recent one — possibly a concurrent syncDown mid-download — alone", async () => {
    write("documents/a.md", "a");
    await syncUp(s, root, PROJ);
    rmSync(join(root, "projects", PROJ, "documents/a.md"));
    mkdirSync(join(root, "projects", PROJ, "documents"), { recursive: true });

    const oldTmp = join(
      root, "projects", PROJ, "documents",
      "a.md.sync-44444444-4444-4444-8444-444444444444.tmp",
    );
    const recentTmp = join(
      root, "projects", PROJ, "documents",
      "a.md.sync-55555555-5555-5555-8555-555555555555.tmp",
    );
    writeFileSync(oldTmp, "orphaned by a crash long ago");
    writeFileSync(recentTmp, "written moments ago");
    setMtime(oldTmp, SIX_HOURS_MS + 60_000); // just over the threshold
    // recentTmp keeps the mtime writeFileSync just gave it — seconds old,
    // exactly what a concurrently-running syncDown's in-flight download looks
    // like from the outside.

    await syncDown(s, root, PROJ);

    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(recentTmp)).toBe(true);
    expect(readFileSync(join(root, "projects", PROJ, "documents/a.md"), "utf8")).toBe("a");
  });

  it("does not sweep a stale sibling belonging to a DIFFERENT destination in the same directory", async () => {
    // Isolated deliberately: a.md is the ONLY destination this run pulls —
    // b.md is left correctly in sync locally, so it never enters syncDown's
    // toPull set and its own sweep (triggered only when b.md itself is
    // written) is never invoked. b.md's leftover tmp is also well past the
    // age threshold, so only the per-destination SCOPE — not the age
    // tolerance — explains why it survives.
    write("documents/a.md", "a");
    write("documents/b.md", "b");
    await syncUp(s, root, PROJ);
    rmSync(join(root, "projects", PROJ, "documents/a.md"));

    const bTmp = join(
      root, "projects", PROJ, "documents",
      "b.md.sync-33333333-3333-4333-8333-333333333333.tmp",
    );
    writeFileSync(bTmp, "unrelated leftover, sitting beside b.md in the same directory");
    setMtime(bTmp, SIX_HOURS_MS + 60_000);

    await syncDown(s, root, PROJ);

    expect(readFileSync(join(root, "projects", PROJ, "documents/a.md"), "utf8")).toBe("a");
    expect(readFileSync(join(root, "projects", PROJ, "documents/b.md"), "utf8")).toBe("b"); // untouched
    expect(existsSync(bTmp)).toBe(true); // a.md's sweep never reached b.md's sibling
  });

  it("still syncs a genuine file whose name merely contains .tmp, unmolested", async () => {
    // The exclusion pattern must be narrow: it matches the specific
    // "<name>.sync-<uuid>.tmp" shape syncDown itself creates, not any file
    // whose name happens to contain ".tmp".
    write("documents/notes.tmp", "genuine notes, not a sync artefact");
    const up = await syncUp(s, root, PROJ);
    expect(up.pushed).toBe(1);

    rmSync(join(root, "projects", PROJ, "documents/notes.tmp"));
    const down = await syncDown(s, root, PROJ);
    expect(down.pulled).toBe(1);
    expect(readFileSync(join(root, "projects", PROJ, "documents/notes.tmp"), "utf8"))
      .toBe("genuine notes, not a sync artefact");
  });
});
