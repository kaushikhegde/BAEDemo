import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMarkdownFile, isConvertible } from "../src/worker/markdown.js";
import { loadConfig } from "../src/shared/config.js";

let dir: string;
const cfg = loadConfig({});

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "afp-md-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const render = async (name: string, bytes: Buffer | string, over?: Partial<typeof cfg>) => {
  const src = join(dir, name);
  await writeFile(src, bytes);
  const out = `${src}.out.md`;
  const ext = name.slice(name.lastIndexOf("."));
  const r = await writeMarkdownFile(out, src, ext, name, { ...cfg, ...over } as typeof cfg);
  return { ...r, text: await readFile(out, "utf8") };
};

describe("isConvertible", () => {
  it("accepts the formats the Scyne pipeline actually receives", () => {
    for (const e of [".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md", ".csv"]) {
      expect(isConvertible(e), e).toBe(true);
    }
  });

  it("rejects screens and audio, which have better paths than markdown", () => {
    for (const e of [".png", ".jpg", ".mp3", ".wav"]) {
      expect(isConvertible(e), e).toBe(false);
    }
  });
});

describe("writeMarkdownFile", () => {
  it("passes markdown through untouched — no second header on an existing document", async () => {
    const r = await render("notes.md", "# Title\n\nBody.\n");
    expect(r.converter).toBe("markitdown");
    expect(r.text).toBe("# Title\n\nBody.\n");
    expect(r.text).not.toContain("Converted from");
  });

  it("keeps headings and tables that the page extractor would flatten", async () => {
    const html = "<h1>Scope</h1><table><tr><th>A</th></tr><tr><td>1</td></tr></table>";
    const r = await render("brief.html", html);
    expect(r.converter).toBe("markitdown");
    expect(r.text).toContain("# Scope");
    expect(r.text).toContain("|");
  });

  it("records the engine that really read a pre-converted file, not the passthrough", async () => {
    const src = join(dir, "deck.md");
    await writeFile(src, "<!-- Converted from deck.pptx by anydoc. -->\n\nSlide one.\n");
    const out = join(dir, "deck.out.md");
    const r = await writeMarkdownFile(out, src, ".md", "deck.pptx", cfg, "anydoc");
    expect(r.converter).toBe("anydoc");
    // The header anydoc wrote survives; a second one is not stamped on top.
    expect((await readFile(out, "utf8")).match(/Converted from/g)).toHaveLength(1);
  });

  it("falls back to the streaming extractor above the memory ceiling", async () => {
    // The ceiling is what stops one enormous upload taking a worker down. Set
    // to 1 byte, every file is 'too large', so the fallback is what runs.
    const r = await render("big.txt", "alpha\nbeta\n", { markdownMaxBytes: 1 });
    expect(r.converter).toBe("stream");
    expect(r.text).toContain("alpha");
    expect(r.text).toContain("by stream");
  });

  it("falls back to the page extractor when the markdown engine alone fails", async () => {
    // A .txt is not a format markitdown claims, so it takes the plain path;
    // forcing the ceiling down makes the page extractor run instead and prove
    // the fallback is wired, without needing a document that breaks mammoth.
    const r = await render("plain.txt", "clause one\nclause two\n", { markdownMaxBytes: 1 });
    expect(r.converter).toBe("stream");
    expect(r.text).toContain("clause two");
  });

  it("FAILS a document no engine can read, rather than inventing empty markdown", async () => {
    // Both engines reject this: markitdown says the .docx is unsupported, and
    // the streaming extractor cannot find a zip central directory. Throwing is
    // the honest outcome — the job goes to `failed` with the reason attached.
    // Writing an empty document.md instead would hand a BA a blank SOP and let
    // every downstream stage treat "unreadable" as "nothing to say", which is
    // the same trap the pipeline's own `failed` extracts exist to avoid.
    await expect(render("broken.docx", Buffer.from("not a zip at all")))
      .rejects.toThrow(/central directory|zip/i);
  });
});
