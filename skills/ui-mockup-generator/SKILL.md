---
name: ui-mockup-generator
description: Generate interactive UI mockups (wireframes) for a feature from everything it has produced — discovery documents, capability map, process model, personas and journeys, product summaries, data model, solution architecture and test cases. Produces a machine-readable screen specification that is rendered into self-contained, themed HTML pages, one per screen, linked from the feature's companion app. Use this skill whenever a user (or the UX Designer agent) asks to: generate UI mockups, wireframes, screen designs, a clickable prototype, "what would the screens look like", or to visualise the target state as an interface. Trigger when the request mentions "mockup", "wireframe", "screen design", "prototype", "UI", "UX", "screens", "page layout", "form design" or "what does the user see".
---

## Project definition — read this first

Before reading any discovery document, read:

```
./projects/<project>/description.md
```

This is the **project definition**: who the client organisation is, what it is
regulated or obliged to do, who its customers actually are, and what it cannot
do. It is written once per project and applies to every feature under it.

Use it to resolve who "the user" of a screen actually is — frequently not the
end consumer — and to avoid designing a screen the organisation is not permitted
to offer. If it is absent, proceed on the discovery documents alone and say so.

---

## What this skill produces

**One file:**

```
projects/<project>/<feature>/solutions/UI/outputs/mockups.json
```

You do **not** write HTML. A deterministic renderer turns that JSON into
self-contained, themed pages:

```bash
node scripts/render-mockups.mjs <project> <feature>
```

That script owns the visual design, so every screen matches the feature's
companion app and every run looks the same. Hand-writing HTML would drift from
the theme and be overwritten on the next render.

---

## Inputs

Read everything the feature has produced. Each one answers a different question:

| Input | What you take from it |
|---|---|
| `solutions/UI/documents/**/*.md` | The discovery documents — real field names, real form sections, real terminology |
| `solutions/UI/project/documents/**/*.md` | The PROJECT's client-wide documents — policy, legislation, standards that constrain every screen |
| `solutions/UI/personas/personas.json` | Who each screen is for, and their competence and context (project-level) |
| `solutions/UI/personas/journey-map.json` | The steps a screen must serve, and the pain it must remove (project-level) |
| `solutions/UI/capabilities/*.json` | Which capability each screen realises (project-level) |
| `solutions/UI/productsummary/*.md` | The user stories and acceptance criteria the screen must satisfy |
| `solutions/UI/DataModel/*.md` | Field names, types, picklist values, required-ness |
| `solutions/UI/Architecture/*.md` | Which component type the screen is (portal page, internal record page, flow screen) |
| `solutions/UI/QA/*.md` | The states a screen must be able to show — error, empty, blocked, success |
| `projects/<project>/<feature>/requirements/UI/` | **Supplied mockups.** If the client gave real designs, treat them as the source of truth and reflect them rather than inventing a different layout |

Every input is optional except the product summary or the discovery documents —
you need at least one source of requirements. Say in the output which inputs
were present.

### You now run BEFORE the data model and the test pack

This stage moved ahead of `datamodel`, `architecture` and `qa` in the pipeline,
because a client wants to see screens before committing to a schema. So on a
first pass `solutions/UI/DataModel/`, `solutions/UI/Architecture/` and
`solutions/UI/QA/` are usually **empty**. That is expected, not an error.

What it changes about your job:

- **Field names.** Without the data model you have no API names, types or
  picklist values. Use the client's own words from the discovery documents and
  the stories, and do not invent a Salesforce API name — a wrong `Claim__c.Status__c`
  is worse than an honest `Status`.
- **States.** Without the test pack you have no catalogued failure paths. Derive
  the error, empty and blocked states from the acceptance criteria and the
  journey's pain points instead. Every screen still needs more than a happy path.
- **Record it.** Set `generatedFrom` on the JSON to the list of inputs that were
  actually present. The renderer shows a "designed without: …" note on each screen
  from it, so a reviewer knows why a field is generically named rather than
  assuming the designer was careless.

Once the data model and test pack exist, the pipeline flags these mockups as
stale and offers a refresh. That refresh is an ordinary revision — see
**Revision mode** at the end of this skill.

---

## Step 1 — Decide the screen set

Work from **journeys and stories**, not from your imagination.

- Take each persona's journey. Every step where the persona touches the system
  is a candidate screen.
- Collapse steps that happen on one screen into one screen. A form is one screen
  even if the journey lists five steps inside it.
- Split a screen when the actor changes. What an applicant sees and what an
  officer sees are different screens even for the same record.
- Cover every user story. A story with no screen is either a background rule or
  a gap — say which.

Aim for the smallest set that covers the journeys. Eight well-specified screens
beat thirty thin ones.

## Step 2 — Specify each screen

Write real content. A mockup whose fields say "Field 1, Field 2" is worthless —
use the field names from the data model and the discovery documents.

**States matter.** For any screen where the test cases describe a failure, an
empty result or a blocked path, add that state. A screen that only shows the
happy path hides the design problem.

## Step 3 — Trace everything

Each screen records what it realises: story numbers, capability ids, the
persona, and the journey step. This is what makes the mockup reviewable rather
than decorative.

## Step 4 — Write `mockups.json`, then render

```bash
node scripts/render-mockups.mjs <project> <feature>
```

It validates the JSON and exits non-zero naming the offending screen and field
if anything is wrong. Fix the JSON and re-run — never hand-write the HTML.

Then re-render the project's single companion page so the **UI** tab picks up
the new screens:

```bash
node scripts/render-companion-app.mjs <project>
```

---

## The `mockups.json` contract

```json
{
  "project": "SAPN",
  "feature": "interiam-benifits",
  "title": "Facilities Access — UI Mockups",
  "generatedOn": "2026-08-14",
  "sources": ["productsummary/PS-001.md", "personas/personas.json"],
  "generatedFrom": ["documents", "productsummary", "personas", "capabilities"],
  "screens": [
    {
      "id": "SCR-001",
      "name": "Lodge an Expression of Interest",
      "persona": "Applicant (APP)",
      "surface": "External portal",
      "route": "Facilities Access › New request › Expression of Interest",
      "purpose": "One sentence on what the user is trying to achieve here.",
      "realises": { "stories": ["1.2.1", "1.3.3"], "capabilities": ["1.1.1"], "journeyStep": "Identify the asset" },
      "states": [
        {
          "id": "default",
          "label": "Default",
          "blocks": [ ... ]
        },
        { "id": "error", "label": "Invalid asset ID", "blocks": [ ... ] }
      ],
      "notes": ["Anything a reviewer needs to know that the picture cannot show."]
    }
  ]
}
```

`states` is an array so one screen can show its error, empty and success
variants. The first state is the one shown on load. A screen with a single
state still uses the array.

### Block types

Use only these. The renderer draws nothing else.

| `type` | Fields | Use for |
|---|---|---|
| `header` | `title`, `subtitle`, `actions[]` | The page title bar |
| `banner` | `tone` (`info`/`success`/`warning`/`error`), `text` | Validation messages, blocked states |
| `stepper` | `steps[]`, `current` (0-based) | Multi-step lodgement |
| `tabs` | `tabs[]`, `current` | A record page with tabs |
| `form` | `title`, `fields[]` | Data entry |
| `table` | `title`, `columns[]`, `rows[][]`, `empty` | Lists and queues |
| `detail` | `title`, `pairs[]` (`{label,value}`) | Read-only record detail |
| `cards` | `title`, `items[]` (`{title,meta,body}`) | Card grids |
| `list` | `title`, `items[]` | Simple lists |
| `timeline` | `title`, `entries[]` (`{when,what,who}`) | Status history, audit trail |
| `buttons` | `items[]` (`{label,variant}` — `primary`/`secondary`/`danger`) | Action rows |
| `placeholder` | `kind` (`map`/`chart`/`image`/`document`), `caption` | A map picker, a chart, an uploaded document |
| `note` | `text` | An annotation to the reviewer, drawn as a margin note |

**`form.fields[]`** each take: `label`, `type` (`text`/`textarea`/`number`/
`select`/`date`/`checkbox`/`radio`/`file`/`readonly`), and optionally
`required` (bool), `value` (shown as filled-in), `placeholder`, `help`,
`options[]` (for select/radio), `error` (string — draws the field in an error
state), `width` (`full`/`half`).

Take field labels and picklist values from the data model where one exists. If
the data model calls it `Attachment_Height__c` with a help text, the mockup says
"Proposed attachment height (m)", not "Height".

---

## Output style rules

- Australian English.
- Real content everywhere. No lorem ipsum, no "Field 1".
- Every screen names its persona and at least one story it realises.
- Where an input was missing, say so in `notes` rather than inventing detail.
- Do not invent field names that contradict the data model. If the data model
  has no field for something a story requires, add a `note` saying so — that is
  a finding worth surfacing.
- When there is **no** data model yet, use the client's own words from the
  discovery documents rather than guessing a Salesforce API name. Record the
  absence in `generatedFrom` and move on — that is the expected first pass.

## After rendering

Print a short summary: how many screens, which personas they cover, which
stories are covered and which are **not**, which inputs were missing, and the
path to the rendered index. Uncovered stories are the useful part of that
summary.

---

## Revision mode

When the invocation supplies a **previous `mockups.json`** plus a **change
instruction**, you are revising, not regenerating.

- Preserve every screen, screen `id`, state and `realises` mapping the
  instruction does not touch. Screen IDs are cited by the companion app and by
  test cases — renumbering them breaks both.
- Apply the change and its genuine consequences. A new field belongs on the
  screen, in any state that shows it filled in, and in the validation-error state
  if it is required.
- The most common revision here is a **refresh once the data model and test pack
  exist**. For that one: keep the screen set and the layout, and replace the
  generic field labels with the data model's real names, types, required-ness and
  picklist values, then add the failure states the test pack catalogues. Update
  `generatedFrom`. Do not redesign screens that were already right.
- Add a `notes` entry on each changed screen recording what changed.
- Re-run `render-mockups.mjs`. A revision that breaks the JSON contract is worse
  than no revision.
