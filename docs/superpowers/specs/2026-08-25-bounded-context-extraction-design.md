# Bounded-Context Extraction (Phase 3)

**Goal:** generate accurate delivery documents from a document set of any size,
without the run's context growing with it.

**Status:** design, approved in conversation 25 August 2026. Not yet planned.

---

## 1. The problem, measured

Every skill reads its inputs whole. `capability-process-map/SKILL.md` Step 1 says
so in as many words: *"Read **every** `.md` file in every scope and category
folder."*

That is fine at today's sizes and fails completely at the sizes now being asked
for:

| Staged markdown | ≈ input tokens for one run |
|---|---|
| SAPN_DEMO — 20 documents, 724 KB | ~190k |
| SAPN — 92 documents, 3.85 MB | ~986k |
| 50 documents, 3 GB | **~750M** |

The third row is not a slow run. It is a run that cannot start.

**Neither existing plane fixes this.** The file plane (Phase 1) keeps a large
file out of context while *answering questions about it* — `search_chunks` finds
the passage, `fetch_chunks` returns a few KB. The workspace plane (Phase 2)
makes `projects/` durable. The Phase 2 spec says it plainly: *"This does not
reduce context cost."*

**And search alone cannot fix it either.** A capability map is a synthesis over
the whole corpus, not a lookup. "What does this organisation do" is not on a
page; it is spread across every document. Keyword retrieval answers the wrong
shape of question.

---

## 2. The design: map, then reduce

Two passes.

```
MAP     one agent per document  →  one extract per document
        reads: that document only (page-windowed if large)
        writes: extract.json — a filled-in form, not prose

REDUCE  one agent, once         →  capability-map.json + process-model.json
        reads: the N extracts (small) + targeted fetch_chunks to verify
```

**Both passes run every time, at every project size** — see §8. There is no
single-read fallback.

Context per map pass is one document. Context for the reduce is N extracts.
**The run scales with document COUNT, not bytes** — 50 documents of 60 MB each
costs the same reduce as 50 documents of 60 KB each.

A single document too large for one pass is read in page windows. The file
plane already produces exactly the right input: chunks carrying `pageStart` and
`pageEnd` (`src/worker/chunk.ts:3-6`). Windows are merged into one extract per
document before the reduce sees them.

---

## 3. The extract is a FORM, not a summary

This is the decision the accuracy of the whole thing rests on.

A summary is lossy in an unpredictable direction — ask for "the important
points" and you get whatever the model found interesting, and what it dropped is
unknowable. An extraction against a fixed schema can only be *incomplete in
named places*, which the reduce can then see and report.

The schema is not invented here. `capability-process-map/SKILL.md` Step 1
already lists exactly what to pull out of each document, in prose; this makes
that list a structure:

```jsonc
{
  "docId": "Workshop_Transcript_Facilities_Access.md",
  "scope": "project",                    // or the feature name
  "category": "Transcripts",
  "windows": [{ "pageStart": 1, "pageEnd": 25 }],

  "businessFunctions": [                 // → capabilities
    { "name": "Refund Escalation", "does": "…", "actor": "Team Lead",
      "src": { "pageStart": 22, "pageEnd": 24 } }
  ],
  "processSteps":  [ { "step": "…", "sequence": 3, "actor": "…",
                       "decisionPoints": ["…"], "timeframe": "5 business days",
                       "src": { … } } ],
  "actors":        [ { "name": "Eligibility Officer", "kind": "front-office", "src": { … } } ],
  "serviceTiers":  [ { "name": "straight-through", "appliesTo": "…", "src": { … } } ],
  "components":    [ { "name": "Provider Portal", "enables": "…", "src": { … } } ],
  "maturitySignals": [ { "statement": "currently manual", "target": "automated", "src": { … } } ],
  "lifecyclePhases": [ { "name": "Assessment", "order": 2, "src": { … } } ],
  "painPoints":    [ { "quote": "…verbatim…", "src": { … } } ],

  "coverage": { "pagesRead": 25, "pagesTotal": 25, "truncated": false }
}
```

Two fields carry more weight than they look:

- **`src`** — every item's `{pageStart, pageEnd}`. See §4.
- **`coverage`** — whether the pass actually read the whole document. A map pass
  that silently gave up on page 12 of 300 is the failure this catches.

`painPoints` keeps a **verbatim quote** where the others keep a paraphrase.
Pain points are what a client disputes in a room, and the persona and journey
skills already require them to be evidenced.

---

## 4. Sources are tracked internally and never published

**Decided in conversation, and the two halves are deliberately different:**

- **The delivered documents carry no citations.** The capability map, the wiki
  page and every other artefact read as clean prose. No footnotes, no
  "(Workshop_Transcript.md, p.23)".
- **The extracts carry `src` on every item.** It never reaches a deliverable.

The internal half is not decoration. It is what lets the reduce pass call
`fetch_chunks` for the exact pages behind a claim and read the real words before
writing it down. Strip it and the reduce is working from a game of telephone
with no way to check itself — an invented capability becomes undetectable.

Cost of keeping it: a few dozen bytes per item, in a file no client sees.

---

## 5. Coverage is checked, not assumed

Three assertions, each a hard failure rather than a warning:

1. **N documents in → N extracts out.** A missing extract stops the run naming
   the document. A document silently skipped is the failure mode that produces a
   confident, wrong capability map.
2. **Every extract's `coverage.truncated` is false**, or the run reports which
   documents were partially read and how much was missed.
3. **Every `src` in the reduce's output resolves** to a real document and a real
   page range. An unresolvable citation means the reduce invented it.

Assertion 3 is the anti-hallucination check, and it works precisely *because*
the citations are internal — they exist to be verified, not displayed.

---

## 6. What changes, and what does not

**Changes:** each skill's "read every document" step becomes "read the extracts,
fetch source where you need to verify". A new `extract` stage runs before the
skills that consume documents.

**Does not change:** the output shape of every artefact. `capability-map.json`,
`process-model.json`, the 11-section Product Summary, the wiki markdown — all
identical. Downstream consumers, the companion app renderer and the validators
are untouched.

**Adoption order.** `capability-process-map` first, because it reads the most
and its Step 1 already enumerates the schema. Then `persona-journey-map`, which
reads the same two-level `documents/` tree. Then `requirement-generator`. The
remaining five read a product summary rather than raw discovery documents and
are far less exposed — they may never need it.

**The extract is shared.** One extract per document serves the capability map,
the personas and the BA. It is computed once per document and reused, which is
what makes the per-document cost tolerable.

**Extracts live in blob, keyed by the source document's content hash.** They are
part of the project's durable state, synced by the Phase 2 layer like any other
artefact. Keying to the hash — which `manifest.ts` already computes — means an
edited document invalidates its own extract automatically and nothing else's. A
project with 50 documents therefore syncs 50 extracts as well; `syncUp` moves
more, and that is the price of not recomputing them on every machine.

---

## 7. Cost, stated honestly

N documents = N map passes + 1 reduce, instead of 1 read.

Each map pass is small and cheap; the reduce is bounded. But it is more agent
runs, more wall clock, and more money than one read — and for a project that
comfortably fits today, it is strictly worse. Measured comparison at SAPN's real
size is the first thing the plan must produce.

Mitigations: map passes are independent and can run in parallel; extracts are
cached and only recomputed when a document's hash changes (the manifest from
Phase 2 already computes those hashes).

**Accuracy may improve rather than degrade.** In a single 986k-token read,
material in the middle is demonstrably attended to less well than material at
the edges. A pass that reads one document against a checklist attends to all of
it.

---

## 8. Failure behaviour

- A map pass that fails is retried once, then reported by document name. The run
  does not proceed with N-1 extracts.
- A document that cannot be converted to markdown is reported, not skipped
  silently.
- The reduce refuses to emit a capability whose `src` does not resolve.
- **There is no bypass.** Every project extracts, at every size. A
  small-project shortcut was considered and rejected: at any threshold worth
  setting it would fire on almost nothing (SAPN_DEMO is 724 KB, SAPN 3.85 MB),
  leaving a second code path that ships, rots, and is wrong the one day it
  finally runs. One path, exercised on every run, and no class of bug where a
  project comes out different for a reason nobody can see. Extracting three
  documents is three cheap passes; the saving was not worth the fork.

---

## 9. Testing

| Claim | Assertion |
|---|---|
| Context is bounded | A 50-document fixture whose total exceeds any context window completes, and the reduce's input is measured under a fixed ceiling |
| Nothing is dropped | 50 in, 50 extracts out; deleting one fails the run naming it |
| Extraction is complete | For a document with known content, every seeded business function appears in its extract |
| No invention | A seeded extract citing a non-existent page is rejected by the reduce |
| Output unchanged | The same project produces a `capability-map.json` that passes `render-capability-map.mjs --validate-only` |
| Reuse works | A second skill consuming the same extracts does not recompute them |

---

## 10. Decisions taken

Resolved in conversation, 25 August 2026:

1. **No bypass.** Every project extracts, at every size. See §8.
2. **Extracts live in blob**, keyed by the source document's content hash. See §6.
3. **Extraction starts when a document arrives, and a document cannot be used
   until it is ready.** See §11.

## 11. A document has states

Extraction is not a step a stage performs; it is a property a document has. That
makes it a small state machine:

```
arrived  →  converting  →  extracting  →  ready
                 ↓              ↓
              failed         failed
```

**`attach_document` starts extraction on arrival** and returns immediately with
the document's state. It does not wait — extracting a 300 MB PDF is not
something to hold an MCP call open for.

**A stage refuses to start against a document that is not `ready`**, naming the
documents it is waiting on and their states. This is the part that needs care:
every 409 gate in the chatbot today counts `.md` files *present on disk*
(`countProjectDocs` / `countFeatureDocs`). Presence is no longer sufficient — a
document that is present but not extracted contributes nothing to the run, so
starting anyway would produce a capability map that silently omits it. That is
precisely the failure §5 exists to prevent, arriving through a different door.

So the gates change from *"are there documents?"* to *"are the documents
ready?"*, and the refusal must say which ones are not and what state they are in
— "wait" is only actionable if a person can see what they are waiting for.

**A status surface is required, not optional.** `list_documents` reports each
document's state, and a document stuck in `failed` reports why. Without it,
"check the status" is advice nobody can act on.

**A failed extraction is retried once**, then left `failed` with its reason. It
is never treated as `ready`, and never silently skipped.

## 12. Open questions

1. **Where does the extraction job run?** The file plane already has a worker
   pool, a queue and poison-queue dead-lettering built for exactly this shape of
   work. Reusing it is the obvious answer and would make extraction the file
   plane's second job type — but it couples the two planes, which Phase 2
   deliberately kept apart. The alternative is an orchestrator workflow, which
   is heavier per document but stays inside the existing tracking, budgets and
   audit trail.
2. **Does a `failed` document block a stage, or can a person override?** A
   scanned PDF with no text layer will never extract, and refusing forever means
   one bad file blocks a project permanently.
