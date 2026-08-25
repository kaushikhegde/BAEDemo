# Bounded-context extraction, measured

**Project:** SAPN_DEMO — 10 discovery documents, 183 KB of markdown
**Date:** 25 August 2026
**Spec:** `docs/superpowers/specs/2026-08-25-bounded-context-extraction-design.md`

The spec required this measurement before the approach is believed. It does not
support the claim it was written to test.

---

## 1. The headline: the reduce got BIGGER, not smaller

| | Old path | New path |
|---|---|---|
| what the reduce reads | the 10 documents | the 10 extracts |
| bytes | 183,271 | **284,931** |
| ≈ tokens | ~46k | **~71k** |
| | | **155% of source** |

**The central claim of §2 — that the reduce reads far less than the corpus — is
false at this size.** Structured extraction *expands* curated markdown: every
item carries a `src: {pageStart, pageEnd}` object and a repeated set of field
names, and the extraction is thorough. 183 KB of prose becomes 285 KB of JSON.

The plan's own acceptance test asserted `extractBytes < docBytes / 4`. That test
is wrong and would fail. It encoded an assumption nobody had measured.

### Where the approach still wins, and it is not nothing

**The map phase genuinely bounds per-pass context.** No single agent ever sees
more than one document, whatever the corpus size. That is what makes 50 files /
3 GB *possible* rather than *cheaper* — the old path cannot start at all there,
and this one can.

The compression ratio depends on **information density, not file size**. A dense,
already-curated 18 KB transcript extracts to roughly its own size. A 300 MB PDF
of repetitive scanned forms extracts to a few tens of KB. SAPN_DEMO is close to
the worst case for this design: small, dense, hand-curated markdown.

### The ceiling moved; it did not disappear

The reduce still grows linearly with document count:

| Documents | ≈ extract bytes | ≈ reduce tokens |
|---|---|---|
| 10 (measured) | 285 KB | ~71k |
| 50 | ~1.4 MB | ~356k |
| 200 | ~5.7 MB | ~1.4M — **over budget again** |

So this design buys roughly an order of magnitude, not unboundedness. A corpus
of many small documents will hit the same wall, further out.

---

## 2. What the new capability map lost

Node counts, comparing `capability-map.json` old versus new:

| Level | Old | New |
|---|---|---|
| L2 | 30 | 31 |
| L3 | **68** | **57** |

**The new map lost 11 of 68 L3 capabilities — 16%.**

A name-level diff shows only 20% exact matches, but that figure is misleading:
most differences are rephrasing (`"applicant communication"` →
`"applicant communication & notification"`). The L3 count is the real signal.

**Concepts absent from the new map entirely:**

- business continuity & operational resilience
- customer feedback & satisfaction measurement
- inclusive design
- applicant follow-up & dormancy management
- conditions management

### Why — structural, not a bug

These are **cross-cutting** capabilities. No single document says "we do
business continuity"; the old path inferred them from holding all ten documents
at once. A map pass sees one document and answers *"what does THIS say the
organisation does"*, so a capability that lives in the gaps between documents
has nowhere to be recorded and nothing to notice it is missing.

§7 of the spec speculated that accuracy might *improve*, on the reasoning that a
single 986k-token read attends poorly to its middle. For this output shape, that
speculation is not supported: the losses are real and they are systematic.

### The fix, not built

Give the reduce an explicit cross-cutting pass. It holds all N extracts, so it
can be asked *"what does this organisation do that no single document names?"*
That needs no schema change and puts the inference where the whole picture is.
The alternative — an `impliedCapabilities` field in the extract — is worse: it
asks one document to speculate about the corpus.

---

## 3. Not measured, and why

**Token counts and cost per path.** The old-path run and the new-path run were
both driven through interactive Claude Code sessions rather than the
orchestrator, so no `runs` row was recorded and no `result` event was captured.
Figures are unavailable rather than estimated — an invented number here would be
worse than a gap, because this document exists to decide whether the approach is
worth its cost.

What is known qualitatively: the new path runs **11 agent invocations** (10 map
passes plus one reduce) where the old ran **1**. Map passes are small and
independent; the reduce is comparable to the old run. The new path is
substantially more expensive at this corpus size, and the byte figures above
say it buys nothing here.

**Wall clock** was not cleanly separable — the runs overlapped with other work
on the same machine.

---

## 4. Other findings

**Orphaned extracts accumulate.** 22 extract files exist on disk for 10 live
documents. Extracts are keyed by the source document's content hash, so editing
a document leaves its old extract behind for ever. Nothing collects them. They
are inert — `projectState` only looks up the hash it wants — but they occupy
blob storage and will grow without bound across a project's life.

**The extract stage raises a human approval gate.** Nobody can meaningfully
approve 10 extracts, let alone 50. It comes from shared compile logic in
`orchestrator.workflows.ts`, so it was flagged rather than special-cased.

**`extract-state.mjs` must only ever walk the four discovery folders.** It
originally walked all of `requirements/`, which includes `requirements/project/`
— staged down from the parent on every run, and holding `capability-process.md`,
the capability map's own previous output. The extracts were about to feed the
capability map its own prior conclusions as client evidence. Fixed by importing
`DISCOVERY_SUBFOLDERS` from `pipeline.mjs` rather than restating the walk.

---

## 5. Verdict

**Do not adopt this for the other seven skills yet.**

It achieves the scaling goal — per-pass context is bounded, so a corpus that
cannot be read at all becomes readable. That is real and it is what was asked
for.

It does not achieve the reduction goal at realistic sizes, and it costs 16% of
the L3 detail. Two things should be true before this spreads:

1. **The cross-cutting pass exists** and the L3 loss is measured again. 16% is
   too much to accept silently in a document a client is shown.
2. **The measurement is repeated on SAPN proper** — 92 documents, 3.85 MB. That
   is where the old path is genuinely near its limit and where the trade should
   start paying. SAPN_DEMO is close to the worst case for this design and was
   the wrong project to judge it on; it was chosen because it is small enough to
   run twice.

The honest summary: this makes the impossible possible, and makes the possible
worse. Whether that is a good trade depends entirely on which corpus you have.
