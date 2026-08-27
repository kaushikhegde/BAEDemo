import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ARTIFACTS } from "../src/shared/config.js";
import { getStorage, ensureStorage, getObjectBuffer, headObject } from "../src/shared/storage.js";
import { writeArtifacts } from "../src/worker/artifacts.js";
import { newJobId } from "../src/shared/ids.js";
import type { PageText } from "../src/worker/chunk.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
beforeAll(async () => { await ensureStorage(storage); });

const pages = async function* (): AsyncGenerator<PageText> {
  for (let p = 1; p <= 12; p++) {
    yield { page: p, text: `Page ${p} of 12\n1. Scope\nlorem ipsum dolor sit amet\n`.repeat(6) };
  }
};

const text = async (jobId: string, name: string) =>
  (await getObjectBuffer(storage, storage.bucket(ARTIFACTS), `${jobId}/${name}`)).toString("utf8");

describe("writeArtifacts", () => {
  let jobId: string;
  let result: any;

  beforeAll(async () => {
    jobId = newJobId();
    result = await writeArtifacts(storage, cfg, jobId, {
      pages: pages(),
      meta: { pages: 12, title: "Fixture", producer: null },
      chunkChars: 300, overlapChars: 50,
    });
  });

  it("reports computed facts and nothing prose-like", () => {
    expect(result.pages).toBe(12);
    expect(result.chunks).toBeGreaterThan(1);
    expect(result.words).toBeGreaterThan(0);
    expect(result.headings).toContain("1. Scope");
    expect(typeof result.durationMs).toBe("number");
    // The fixture's stopword ratio (repeated "of") clears the 2% threshold, and
    // its text has no columnar whitespace at all — negative control for the
    // dedicated language/tables fixtures below.
    expect(result.language).toBe("en");
    expect(result.tables).toBe(0);
  });

  it("writes all four artifacts", async () => {
    for (const name of ["chunks.jsonl", "index.json", "metadata.json", "result.json"]) {
      await expect(headObject(storage, storage.bucket(ARTIFACTS), `${jobId}/${name}`))
        .resolves.toBeDefined();
    }
  });

  it("writes one JSON object per line, in document order", async () => {
    const lines = (await text(jobId, "chunks.jsonl")).trimEnd().split("\n");
    expect(lines).toHaveLength(result.chunks);
    const ids = lines.map((l) => JSON.parse(l).chunkId);
    expect(ids).toEqual([...ids].sort());
  });

  it("indexes every chunk at a byte range that decodes back to that chunk", async () => {
    // This is the contract fetch_chunks depends on: a ranged read of exactly
    // these bytes must yield exactly this chunk.
    const raw = Buffer.from(await text(jobId, "chunks.jsonl"), "utf8");
    const index = JSON.parse(await text(jobId, "index.json"));
    expect(Object.keys(index)).toHaveLength(result.chunks);
    for (const [chunkId, entry] of Object.entries<any>(index)) {
      const slice = raw.subarray(entry.byteOffset, entry.byteOffset + entry.byteLength);
      const parsed = JSON.parse(slice.toString("utf8"));
      expect(parsed.chunkId).toBe(chunkId);
      expect(parsed.pageStart).toBe(entry.pageStart);
      expect(parsed.pageEnd).toBe(entry.pageEnd);
      expect(entry.pageStart).toBeLessThanOrEqual(entry.pageEnd);
    }
  });

  it("indexes correctly when the text contains multi-byte characters", async () => {
    // Byte offsets and character offsets diverge the moment a document is not
    // ASCII, and every citation would then be wrong.
    const id = newJobId();
    const r = await writeArtifacts(storage, cfg, id, {
      pages: (async function* () { yield { page: 1, text: "café — naïve résumé\n".repeat(200) }; })(),
      meta: { pages: 1, title: null, producer: null },
      chunkChars: 200, overlapChars: 0,
    });
    const raw = Buffer.from(await text(id, "chunks.jsonl"), "utf8");
    const index = JSON.parse(await text(id, "index.json"));
    const [firstId, first] = Object.entries<any>(index)[0];
    const parsed = JSON.parse(raw.subarray(first.byteOffset, first.byteOffset + first.byteLength).toString("utf8"));
    expect(parsed.chunkId).toBe(firstId);
    expect(r.chunks).toBeGreaterThan(1);
  });

  it("reports progress as pages are consumed", async () => {
    const seen: number[] = [];
    await writeArtifacts(storage, cfg, newJobId(), {
      pages: pages(), meta: { pages: 12, title: null, producer: null },
      chunkChars: 300, overlapChars: 50,
      onProgress: (done) => seen.push(done),
    });
    expect(seen[seen.length - 1]).toBe(12);
  });

  it("does not report English for text with no English stopwords", async () => {
    const id = newJobId();
    const r = await writeArtifacts(storage, cfg, id, {
      pages: (async function* () { yield { page: 1, text: "xyzzy qwerty foobar zorble blimp\n".repeat(20) }; })(),
      meta: { pages: 1, title: null, producer: null },
      chunkChars: 300, overlapChars: 0,
    });
    expect(r.words).toBeGreaterThan(0);
    expect(r.language).not.toBe("en");
  });

  it("counts columnar whitespace as the tables heuristic claims to", async () => {
    const id = newJobId();
    const r = await writeArtifacts(storage, cfg, id, {
      pages: (async function* () {
        yield { page: 1, text: "Name    Age    City    Score\nAlice   30     Perth   88\n".repeat(10) };
      })(),
      meta: { pages: 1, title: null, producer: null },
      chunkChars: 300, overlapChars: 0,
    });
    // A heuristic, not a promise of exact table detection — assert the
    // behaviour (columnar text moves the count) rather than a tuned number.
    expect(r.tables).toBeGreaterThan(0);
  });
});

describe("writeArtifacts error handling", () => {
  it("leaves no scratch file behind when extraction fails partway through", async () => {
    // A dedicated, empty directory: writeArtifacts's scratch filename carries a
    // random UUID we can't predict, so we can't check one exact path for
    // absence. But nothing else ever writes here, so the directory being empty
    // afterwards is exactly "no partial file left behind".
    const scratchDir = mkdtempSync(join(tmpdir(), "afp-art-throw-"));
    const scratchCfg = { ...cfg, tempDir: scratchDir };

    // The generator yields a real page first — comfortably larger than
    // chunkChars, so at least one real chunk is flushed to the scratch file —
    // before throwing on the next pull. Unlike a failure that never gets as
    // far as opening the stream, this leaves genuine bytes on disk for the
    // cleanup to actually have to remove.
    const boom = new Error("extractor exploded");
    const failingPages = async function* (): AsyncGenerator<PageText> {
      yield { page: 1, text: "some content before the failure\n".repeat(50) };
      throw boom;
    };

    await expect(writeArtifacts(storage, scratchCfg, newJobId(), {
      pages: failingPages(),
      meta: { pages: 2, title: null, producer: null },
      chunkChars: 50, overlapChars: 0,
    })).rejects.toThrow("extractor exploded");

    // createWriteStream's open() is asynchronous, so a correct writeArtifacts
    // must not return until it has confirmed the stream can no longer touch
    // the file (see the destroy()+'close' wait in the finally block) — but a
    // REGRESSION that drops that wait would still let the promise reject
    // immediately, before a still-pending open() has fired. Without settling
    // here first, this assertion would then race that deferred open() and
    // could pass even against a genuinely leaking implementation. The fixed
    // code needs no extra time (its own wait already completed before the
    // promise settled above), so this costs the passing case nothing.
    await new Promise((r) => setTimeout(r, 150));
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  it("rejects cleanly, without crashing or hanging, when the write stream itself errors", async () => {
    // A read-only directory makes createWriteStream's open fail with EACCES,
    // which is a genuine 'error' event on the write stream — the same event
    // class the fix targets — triggered deterministically and without
    // monkey-patching fs internals.
    //
    // The pages generator below yields many small pages with a real
    // event-loop tick (setImmediate) between each — long enough that the
    // async EACCES failure (measured to land within ~1ms) fires WHILE the
    // write loop is still churning through synchronous, backpressure-driven
    // write()/drain cycles, rather than only once the loop has already
    // finished and reached the tail wait. That mid-loop window is exactly
    // where a listener attached only around drain/finish waits can miss the
    // error: once() only starts listening for 'error' at the moment it is
    // called, so an error that already fired in the past — destroying the
    // stream and firing 'close' — leaves a later once(stream, "drain") or
    // once(stream, "finish") waiting forever for an event that will never
    // come again. A smaller, fast-finishing fixture does not reach this
    // window at all (confirmed by hand: it still passes even without the
    // fix, for the wrong reason), which is why this one is larger and slower
    // on purpose. It fires before any bytes are written, so there is nothing
    // left on disk for this test to check; it exists purely to prove the
    // error propagates as a clean rejection rather than an unhandled 'error'
    // that would crash this whole test worker, or a hang.
    const scratchDir = mkdtempSync(join(tmpdir(), "afp-art-eacces-"));
    await chmod(scratchDir, 0o500); // read + execute only — no write bit
    const scratchCfg = { ...cfg, tempDir: scratchDir };

    const slowPages = async function* (): AsyncGenerator<PageText> {
      for (let p = 1; p <= 300; p++) {
        await new Promise((r) => setImmediate(r));
        yield { page: p, text: `Page ${p} of 300\nlorem ipsum dolor sit amet consectetur\n`.repeat(6) };
      }
    };

    try {
      await expect(writeArtifacts(storage, scratchCfg, newJobId(), {
        pages: slowPages(),
        meta: { pages: 300, title: null, producer: null },
        chunkChars: 300, overlapChars: 50,
      })).rejects.toThrow(/EACCES|permission denied/i);
    } finally {
      await chmod(scratchDir, 0o700); // restore so the temp-dir cleanup below can remove it
    }
  });

  it("does not let a throwing onProgress callback abort extraction", async () => {
    const r = await writeArtifacts(storage, cfg, newJobId(), {
      pages: pages(),
      meta: { pages: 12, title: null, producer: null },
      chunkChars: 300, overlapChars: 50,
      onProgress: () => { throw new Error("boom from a bad progress callback"); },
    });
    expect(r.pages).toBe(12);
    expect(r.chunks).toBeGreaterThan(1);
  });
});
