import { describe, it, expect } from "vitest";
import { chunkPages, chunkIdFor, type PageText } from "../src/worker/chunk.js";

const collect = async (pages: PageText[], chunkChars = 100, overlapChars = 20) => {
  const out = [];
  for await (const c of chunkPages(pages, { chunkChars, overlapChars })) out.push(c);
  return out;
};

describe("chunkIdFor", () => {
  it("zero-pads so ids sort into reading order", () => {
    expect(chunkIdFor(0)).toBe("c-000000");
    expect(chunkIdFor(412)).toBe("c-000412");
    expect(["c-000010", "c-000002"].sort()).toEqual(["c-000002", "c-000010"]);
  });
});

describe("chunkPages", () => {
  it("returns one chunk when the text is shorter than the window", async () => {
    const out = await collect([{ page: 1, text: "short text" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      chunkId: "c-000000", pageStart: 1, pageEnd: 1, charStart: 0, charEnd: 10,
    });
  });

  it("is deterministic — identical input yields identical output", async () => {
    const pages = [{ page: 1, text: "alpha beta gamma. ".repeat(40) }];
    expect(await collect(pages)).toEqual(await collect(pages));
  });

  it("overlaps consecutive chunks by the requested amount", async () => {
    const out = await collect([{ page: 1, text: "x".repeat(500) }], 100, 20);
    expect(out.length).toBeGreaterThan(1);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].charStart).toBe(out[i - 1].charEnd - 20);
    }
  });

  it("prefers a paragraph boundary over a hard cut", async () => {
    const text = "a".repeat(80) + "\n\n" + "b".repeat(80);
    const [first] = await collect([{ page: 1, text }], 100, 0);
    expect(first.text).toBe("a".repeat(80) + "\n\n");
  });

  it("maps every chunk to the pages its first and last characters came from", async () => {
    // 60 chars per page, 100-char window, no overlap: a chunk's 100 chars
    // routinely span more than one page boundary, and a citation naming only
    // the FIRST page (the old `page` field) silently mis-cites everything the
    // chunk covers past that boundary. pageStart/pageEnd bound the true range.
    //   page1 [0,60)  page2 [60,120)  page3 [120,180)  page4 [180,240)  page5 [240,300)
    //   chunk0 [0,100)   -> starts in page1, last char (99) in page2
    //   chunk1 [100,200) -> starts in page2, last char (199) in page4
    //   chunk2 [200,300) -> starts in page4, last char (299) in page5
    const pages = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: "z".repeat(60) }));
    const out = await collect(pages, 100, 0);
    expect(out[0]).toMatchObject({ pageStart: 1, pageEnd: 2 });
    expect(out[1]).toMatchObject({ pageStart: 2, pageEnd: 4 });
    expect(out[2]).toMatchObject({ pageStart: 4, pageEnd: 5 });
  });

  it("reports pageStart === pageEnd for a chunk that stays within one page", async () => {
    const pages = [
      { page: 1, text: "a".repeat(60) },
      { page: 2, text: "b".repeat(60) },
    ];
    // chunkChars=30 keeps every chunk well inside a single 60-char page.
    const out = await collect(pages, 30, 0);
    for (const c of out) expect(c.pageStart).toBe(c.pageEnd);
  });

  it("emits a final short chunk rather than dropping the tail", async () => {
    const out = await collect([{ page: 1, text: "y".repeat(230) }], 100, 0);
    expect(out).toHaveLength(3);
    expect(out[2].text).toHaveLength(30);
  });

  it("drops a trailing chunk that is only whitespace", async () => {
    const out = await collect([{ page: 1, text: "y".repeat(200) + "   \n  " }], 100, 0);
    expect(out).toHaveLength(2);
  });

  it("refuses an overlap that would never make progress", async () => {
    await expect(collect([{ page: 1, text: "abc" }], 100, 100)).rejects.toThrow(/overlap/);
  });

  it("rejects overlapChars larger than half the window", async () => {
    await expect(collect([{ page: 1, text: "x".repeat(200) }], 100, 51)).rejects.toThrow(
      /overlapChars must be in \[0, 50\]/
    );
  });

  it("terminates promptly at the maximum legal overlap", async () => {
    // Test that a chunk window can accommodate a near-boundary case at the
    // maximum legal overlap (50 for a 100-char window). The validation guard
    // rejects anything above splitPoint's floor, so this is the edge case.
    const text = "x".repeat(50) + "\n\n" + "y".repeat(200);
    const out = await collect([{ page: 1, text }], 100, 50);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(20); // Bound ensures no infinite loop
  });

  it("rejects chunkChars <= 0", async () => {
    await expect(collect([{ page: 1, text: "abc" }], 0, 0)).rejects.toThrow(/positive/);
    await expect(collect([{ page: 1, text: "abc" }], -1, 0)).rejects.toThrow(/positive/);
  });

  it("emits a final chunk with trailing whitespace plus content", async () => {
    // Test the edge case: tail with non-whitespace after space
    const out = await collect([{ page: 1, text: "y".repeat(100) + "  x" }], 100, 0);
    expect(out).toHaveLength(2);
    expect(out[1].text).toBe("  x");
  });
});
