---
name: document-extract
description: Use when extracting one discovery document into a structured extract for the Scyne pipeline — reads a single document and fills in a fixed form so later stages never load the whole corpus.
---

# Document Extract

You are reading **one document** and filling in a form about it.

You are not summarising. A summary drops whatever the writer found
uninteresting and nobody can tell what went missing. A form can only be
incomplete in places that are named, which a later stage can see and report.

## The one rule that matters

**Read only the document you were given.** Do not open another document, do not
look at the project's other folders, do not read a previous extract. The entire
point of this pass is that its context holds one document — reaching for a
second defeats it and the work becomes impossible at scale.

If the document references another ("as described in the Handling Policy"),
record the reference as text. Do not go and read it.

## Australian English

Behaviour, authorise, organisation. The client's own spelling wins over yours.

## What to fill in

Eight lists. A document will legitimately have nothing for several of them —
an empty list is a real answer, and far better than a padded one.

**`businessFunctions`** — what the organisation *does*, as noun phrases:
"Order Fulfilment", "Field Maintenance", "Complaint Handling". Not job
titles, not systems. Each carries `name`, `does`, and `actor` where stated.

**`processSteps`** — what happens, in order. Each carries `step`, `sequence`,
`actor`, any `decisionPoints`, and a `timeframe` or SLA where one is stated.

**`actors`** — who performs the work. `name` plus `kind`: `client`,
`front-office`, `back-office`, `third-party` or `system`.

**`serviceTiers`** — where a step applies only to some cohorts:
straight-through versus complex versus catastrophic, standard versus priority.
Each carries `name` and `appliesTo`.

**`components`** — named systems, portals, modules or tools, with what each
`enables`.

**`maturitySignals`** — statements about today versus wanted: "currently
manual", "no single view", "to be automated". Each carries `statement` and,
where stated, `target`.

**`lifecyclePhases`** — any stated end-to-end structure, with `order`. **Prefer
the document's own phase names over any you would invent.**

**`painPoints`** — what is not working. **`quote` must be VERBATIM** — the
client's own words, copied exactly.

**What "verbatim" permits and forbids.** You may collapse a line break that the
source markdown introduced by wrapping — a quote that spans two lines becomes
one line. You may not change, add, remove or reorder a single word, and you may
not stitch together two sentences the speaker did not say consecutively. The
test is whether the client would recognise it as what they said. These are what get disputed in a room with
a client, and a paraphrase is not evidence. Everything else on this form may be
your own phrasing; this may not.

## Every item carries `src`

```json
{ "name": "Refund Escalation", "does": "…", "src": { "pageStart": 22, "pageEnd": 24 } }
```

`src` is the pages this item came from. It never appears in any delivered
document — it exists so the synthesis pass can pull those exact pages and check
the real words before writing anything down.

An item you cannot locate to a page range is an item you should not record.

## Coverage: tell the truth

```json
"coverage": { "pagesRead": 25, "pagesTotal": 300, "truncated": true }
```

If you did not read the whole document, say so. `truncated: true` with an
honest `pagesRead` is a **success** — the pipeline handles it. A `truncated:
false` that is not true is the one failure this whole design exists to prevent:
it produces a confident capability map with a silent hole in it.

## Output

Write the JSON to the path you were given. Nothing else — no prose, no
explanation around it.

## Revision mode

When given a previous extract plus an instruction, preserve everything the
instruction does not touch, apply the change and its genuine consequences, and
leave `src` values intact for items you did not alter.
