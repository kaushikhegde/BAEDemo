---
name: requirements-test-case-generator
description: >
  Generate structured, traceable test cases from requirement artefacts —
  requirements docs, user stories, acceptance criteria, product summaries, data
  models, solution architecture documents, process flows, integration catalogues,
  UI designs or API specs. Produces test cases with preconditions, steps,
  expected results, test data, persona/permission coverage, a requirements
  traceability matrix and a coverage gap analysis, optionally as Gherkin or as a
  CSV ready for Jira, Xray, Zephyr, TestRail or Azure DevOps import. Use this
  skill whenever a user (or the QA Architect agent) asks for: test cases, test
  scenarios, a test plan, QA scripts, UAT scripts, acceptance tests, BDD
  scenarios, a traceability matrix, or "how do we test this" for a set of
  requirements. Trigger when the request mentions "test cases", "test plan",
  "test pack", "QA", "UAT", "acceptance testing", "regression", "Gherkin",
  "Cucumber", "Xray", "Zephyr", "test coverage" or "traceability" — including
  when the user hands over requirements plus linked design artefacts and asks
  what needs testing.
---

# Requirements-to-Test-Case Generator

Turn requirement artefacts into test cases someone else can execute without
asking a single clarifying question, with traceability back to every requirement
and an honest account of what isn't covered. The deliverable is:

1. **Executable test cases** — preconditions, concrete test data, numbered steps
   with per-step expected results
2. A **requirements traceability matrix** in both directions
3. A **coverage analysis** naming what is not covered and why
4. Optional **Gherkin** or **CSV** export for a test management tool

The failure mode this skill exists to prevent is the plausible-looking test pack
that only tests the happy path. Requirements describe what the system should do;
most defects live in what happens when it doesn't — bad input, absent
permissions, empty result sets, duplicate messages, concurrent edits, boundary
values. Systematic test design techniques exist precisely because intuition
under-samples those regions. Use them explicitly rather than free-associating
scenarios.

All source files are `.md` format.

---

## Where the inputs and output live (Scyne workspace layout)

This skill runs inside its own working folder
`./projects/<project>/<feature>/solutions/QA/` — the QA Architect agent passes you
the `<project>` and `<feature>` in its issue description, and stages the inputs
into this folder before invoking the skill.

- **Requirements (input, required):** `solutions/QA/productsummary/` — the BA's
  approved product summary, plus any user stories, acceptance criteria, SOPs or
  process documents staged alongside it. Read everything in the folder.
- **Data model (input, optional):** `solutions/QA/DataModel/` — the Data
  Modeler's output. Field types, lengths, required flags, picklist values and
  relationships are what make boundary and validation cases concrete rather than
  generic.
- **Solution architecture (input, optional):** `solutions/QA/Architecture/` — the
  Solution Architect's or Architecture Lead's output. Components, interface
  catalogue and error handling are what make integration and failure cases real.
- **Output (you write here):** `solutions/QA/outputs/test-cases.md` — a single
  fixed filename so the chatbot's approval preview can read it. Create the
  `outputs/` folder if it does not exist yet.
- **Optional companion outputs:** `solutions/QA/outputs/test-cases.csv` (tool
  import) and `solutions/QA/outputs/test-cases.feature` (Gherkin) — write these
  *in addition to* the `.md`, never instead of it.

The data model and architecture folders are **opportunistic**: a richer pack when
they exist, a still-valid pack when they don't. If either is empty, say so under
Assumptions and note which categories of case could not be written in the
detail they deserve.

(All paths below are relative to the working folder
`./projects/<project>/<feature>/solutions/QA/`.)

---

## Step 1 — List and Read All Source Files

Before reading anything, list the contents of every input folder:

```bash
ls productsummary/
ls DataModel/
ls Architecture/
```

Note every filename — you will cite them as source artefacts in the document
header and throughout the traceability matrix. If `productsummary/` is empty,
stop and report that — there is nothing to test against.

Read **every** `.md` file in every input folder before writing any case.

---

## Step 2 — Ingest and Decompose

Note what each artefact contributes:

| Artefact | What it gives the test pack |
|---|---|
| Requirements / user stories | Testable conditions, acceptance criteria, priorities |
| Product summary | Business context, personas, what "correct" means to the user |
| Data model | Field types, lengths, required flags, picklist values, relationships → validation and boundary tests |
| Solution architecture | Components, integration interfaces, error handling → integration and failure tests |
| Process flows | Path coverage, decision points, state transitions |
| UI designs | Field-level behaviour, conditional visibility, accessibility |
| API specs | Contract tests, status codes, payload validation |
| NFRs | Performance, volume, availability, accessibility tests |

Then decompose each requirement into **testable conditions** — the atomic
statements that can each be independently proven true or false. A requirement
like "agents can escalate a case to a supervisor with a reason" decomposes into:
escalation available to the agent persona; unavailable to personas without the
permission; reason mandatory; reason length limits; case status and owner change
on escalation; supervisor notified; escalation recorded in history; behaviour when
the case is already escalated; behaviour when no supervisor is available.

Give every requirement a stable ID (`R-01`, `R-02`, …) if the source does not
already number them.

If a requirement is untestable as written — vague, unmeasurable, or contradictory
— flag it in **Requirement Quality Issues** rather than silently inventing an
interpretation. This is one of the most valuable outputs of the exercise, because
it surfaces problems while they're still cheap to fix.

---

## Step 3 — Apply Test Design Techniques

Read **Appendix A — Test Design Techniques** and apply the appropriate technique
per condition rather than writing cases ad hoc:

- **Equivalence partitioning** — one case per class of equivalent input
- **Boundary value analysis** — min, min−1, min+1, max, max−1, max+1, empty, null
- **Decision tables** — for combinations of conditions producing different
  outcomes
- **State transition** — for anything with a lifecycle: valid transitions, and
  explicitly the invalid ones
- **Pairwise / combinatorial** — where the full cross-product of options is
  impractical
- **CRUD matrix** — per object per persona, for permission coverage
- **Error guessing and risk-based emphasis** — where the design is novel,
  integrated, or was hard to specify

Record which technique produced each case. It makes the pack reviewable and it
tells anyone maintaining it how to extend coverage correctly.

---

## Step 4 — Cover the Dimensions

Work through **Appendix B — Coverage Checklist** per requirement. At minimum:
happy path, alternative paths, negative and validation cases, boundaries,
permissions per persona, state transitions, integration success and failure, data
volume/bulk, regression risk to existing behaviour, and any applicable NFR,
accessibility and localisation cases.

Where the artefacts describe a Salesforce build, also work through **Appendix C —
Salesforce / Service Cloud Testing Reference**. Those are the angles generic test
design misses because they depend on platform behaviour.

A useful ratio to sanity-check against: if the pack is more than roughly
two-thirds positive cases, coverage of the failure space is probably thin.

---

## Step 5 — Write the Cases

Every case carries: ID, title, requirement reference, type, level, priority,
persona, preconditions, test data, numbered steps with per-step expected results,
overall expected result, postconditions, and an automation-candidate flag.

Write steps as instructions to a person who has never seen the system and doesn't
have the requirements to hand. "Verify the case is created correctly" is not a
step — it's a wish. "Confirm the Case record displays Status = New, Origin =
Email, and Owner = Tier 1 Support queue" is a step.

### Test case anatomy

| Field | Guidance |
|---|---|
| **ID** | `TC-<area>-<nnn>`, stable across versions |
| **Title** | Condition and expected outcome in one line: "Escalation blocked when reason is blank" |
| **Requirement ref** | One or more requirement IDs |
| **Type** | Functional / Negative / Validation / Permission / Integration / Data / Regression / Performance / Accessibility / Security / Migration |
| **Level** | Unit / Component / System / Integration / E2E / UAT |
| **Priority** | P1 critical path or high risk · P2 important · P3 edge and cosmetic |
| **Persona** | The user profile/permission set executing it — this is a test variable, not context |
| **Preconditions** | The exact state required before step 1 |
| **Test data** | Specific values, not "a valid record" |
| **Steps** | Numbered, one action each, with the expected result for that step |
| **Expected result** | The overall assertion |
| **Postconditions** | State to verify or clean up afterwards |
| **Automation candidate** | Yes/No with a one-word reason — helps the team plan the automation backlog |

---

## Step 6 — Build the Traceability Matrix and Gap Analysis

Every requirement maps to at least one case; every case maps to at least one
requirement. Report **both** directions.

Then state honestly what is **not** covered and why — deferred, out of scope,
untestable in the available environment, or requiring data the project doesn't
have yet. A test pack that quietly omits things is worse than one that names its
gaps.

An orphan test either covers an implicit requirement worth documenting, or
shouldn't exist. Resolve it rather than leaving it in.

---

## Step 7 — Choose the Output Formats

Markdown is always written. In addition:

- Write **`outputs/test-cases.csv`** whenever the pack exceeds roughly 20 cases,
  or the requirements or the user mention Jira, Xray, Zephyr, TestRail or Azure
  DevOps. Column specs are in **Appendix D — Output Formats**. Use the
  tool-agnostic column set unless the target tool is known.
- Write **`outputs/test-cases.feature`** (Gherkin) when the requirements or the
  user mention BDD, Cucumber, or automation-first delivery.

---

## Step 8 — Write the Output Document

Compose the full document using exactly this structure and section order (you
save it to the output path in Step 10, after the quality check).

---

````markdown
# Test Cases — [Programme / Release Name]

**Version:** 0.1 (Draft) · **Date:** [date] · **Scope:** [requirements / release covered] · **Source artefacts:** [list every input filename]

---

## 1. Test Approach & Scope

**In scope:** [functional areas, requirement IDs, test levels covered]

**Out of scope:** [what this pack deliberately does not cover, and where it is covered instead]

**Test levels included:** [System / Integration / E2E / UAT / Regression]

**Techniques applied:** [equivalence partitioning, boundary value analysis, decision tables, state transition, pairwise, CRUD matrix]

**Summary**

| Metric | Count |
|---|---|
| Requirements covered | |
| Total test cases | |
| P1 / P2 / P3 | |
| Positive / Negative | |
| Automation candidates | |

## 2. Assumptions and Requirement Quality Issues

**Assumptions**

| # | Assumption | Affects | Impact if wrong |
|---|---|---|---|

**Requirement quality issues** — requirements that are ambiguous, unmeasurable, contradictory or missing an outcome for a valid input combination. These need resolution before the affected cases can be finalised.

| # | Requirement | Issue | Interpretation used | Owner |
|---|---|---|---|---|

## 3. Personas and Environments

| Persona | Access Profile / Permission Sets | Test User | Used In |
|---|---|---|---|

| Environment | Purpose | Data State | Notes |
|---|---|---|---|

## 4. Test Data Requirements

| Ref | Record | Key Attributes | Used By | Setup Method |
|---|---|---|---|---|
| TD-01 | Account "Northwind Traders" | Type = Customer, Tier = Gold | TC-CASE-001…014 | Data load / manual |

Note any data that must be created fresh per run, and anything requiring production-like volume.

## 5. Test Cases

[Grouped by requirement or functional area. Summary table first, then the per-case blocks.]

### Summary

| ID | Title | Req | Type | Priority | Persona | Automation |
|---|---|---|---|---|---|---|

### [Functional Area]

#### TC-XXX-001 — [Condition and expected outcome]

| | |
|---|---|
| **Requirement** | |
| **Type** | |
| **Level** | |
| **Priority** | |
| **Persona** | |
| **Technique** | |
| **Automation** | |

**Preconditions**
-

**Test data**
-

**Steps**

| # | Action | Expected |
|---|---|---|
| 1 | | |

**Expected result** —

**Postconditions** —

## 6. Requirements Traceability Matrix

**Requirement → tests**

| Req ID | Requirement | Test Cases | Positive | Negative | Coverage |
|---|---|---|---|---|---|

**Test → requirement**

| Test ID | Requirement(s) |
|---|---|

## 7. Coverage Analysis & Gaps

**Coverage by dimension**

| Dimension | Covered | Notes |
|---|---|---|
| Happy path | | |
| Validation & boundaries | | |
| Permissions per persona | | |
| State transitions | | |
| Integration success & failure | | |
| Bulk / volume | | |
| Accessibility | | |
| Security | | |

**Known gaps**

| # | Gap | Reason | Risk | Recommendation |
|---|---|---|---|---|

## 8. Regression Impact

| Existing Feature | Why Affected | Regression Cases |
|---|---|---|

## 9. Risks and Recommendations

| # | Risk | Impact | Recommendation |
|---|---|---|---|
````

---

## Step 9 — Quality Check

Before saving, verify:

- [ ] Every acceptance criterion has at least one positive and one negative case.
- [ ] Every case is independent — no case depends on another having run first,
      unless it's an explicitly labelled E2E sequence.
- [ ] Every case has exactly one clear reason to fail. Cases asserting five
      unrelated things can't be triaged.
- [ ] Test data is concrete. Named values, specific dates, actual field contents.
- [ ] No step says "verify it works", "check the result is correct", or "ensure
      data is accurate".
- [ ] Permission and persona coverage exists for anything access-controlled — not
      just the admin path.
- [ ] Every integration interface has a success case, a failure case, and a
      retry/duplicate case.
- [ ] The traceability matrix is complete in both directions and gaps are named.
- [ ] Priorities are justified by risk, not distributed evenly.
- [ ] The positive/negative balance check has been run — no more than roughly
      two-thirds positive.
- [ ] Every requirement quality issue names the interpretation used, so a reader
      knows what the cases assume.

---

## Step 10 — Save

Save the completed document to (relative to the working folder):

```
./projects/<project>/<feature>/solutions/QA/outputs/test-cases.md
```

Write any CSV or Gherkin companions alongside it, per Step 7.

After saving, give a brief summary covering:

- Total cases, and the P1/P2/P3 and positive/negative split
- Requirements covered, and any requirement with **zero** coverage
- The requirement quality issues that need a decision before the pack can be
  finalised
- Named gaps and their risk

---
---

# Appendix A — Test Design Techniques

Pick the technique that matches the shape of the condition. Recording which one
produced each case makes the pack extensible by someone other than its author.
Read during Step 3.

## Equivalence partitioning

Divide the input domain into classes where every member should be treated
identically, then test one representative from each — plus one from each invalid
class.

**Example — "Priority may be Low, Medium, High or Critical":**

- Valid classes: each of the four values (four cases, because each drives
  different downstream behaviour — SLA, routing, alerting)
- Invalid classes: null/blank, a value not in the set (via API or data load,
  since the UI restricts it)

The key judgement is whether members of a class really are equivalent. If High
and Critical trigger different escalation behaviour, they are separate classes,
not one.

## Boundary value analysis

Most defects cluster at edges. For any bounded input test: minimum, minimum − 1,
minimum + 1, maximum, maximum − 1, maximum + 1, plus empty and null.

**Example — "Case Subject is mandatory, max 255 characters":**

| Case | Input | Expected |
|---|---|---|
| Empty | `""` | Rejected, mandatory-field error |
| Whitespace only | `"   "` | Rejected (confirm the requirement's intent — this is a genuine ambiguity worth flagging) |
| Minimum | 1 character | Accepted |
| Typical | 50 characters | Accepted |
| Max − 1 | 254 characters | Accepted |
| Max | 255 characters | Accepted, no truncation |
| Max + 1 | 256 characters | Rejected or truncated — the requirement must say which |
| Special characters | `<script>`, emoji, RTL text, `'` | Stored and rendered safely |

Apply the same treatment to dates (past, today, future, leap day, DST boundary,
financial year end), numbers (zero, negative, decimals beyond scale), and
collections (zero, one, many, maximum).

## Decision tables

Use when several conditions combine to produce different outcomes. Build the
table, then write one case per rule.

**Example — case auto-escalation:**

| Rule | Priority = Critical | SLA breached | Customer tier = Gold | Expected |
|---|---|---|---|---|
| 1 | Y | Y | Y | Escalate immediately, notify supervisor + account manager |
| 2 | Y | Y | N | Escalate immediately, notify supervisor |
| 3 | Y | N | Y | Flag for review, no escalation |
| 4 | N | Y | Y | Escalate, notify supervisor |
| 5 | N | Y | N | Escalate |
| 6 | N | N | any | No action |

Decision tables also expose gaps in the requirements — if a combination has no
defined outcome, that's a question for the BA, not a guess for the tester.

## State transition testing

For anything with a lifecycle. Build the state table, then test valid transitions
**and** attempt the invalid ones — invalid transitions are where enforcement
usually turns out to be missing.

**Example — Case status:**

| From \ To | New | In Progress | Waiting on Customer | Escalated | Closed | Reopened |
|---|---|---|---|---|---|---|
| New | — | ✓ | ✓ | ✓ | ✗ | ✗ |
| In Progress | ✗ | — | ✓ | ✓ | ✓ | ✗ |
| Waiting on Customer | ✗ | ✓ | — | ✓ | ✓ | ✗ |
| Escalated | ✗ | ✓ | ✓ | — | ✓ | ✗ |
| Closed | ✗ | ✗ | ✗ | ✗ | — | ✓ |
| Reopened | ✗ | ✓ | ✓ | ✓ | ✓ | — |

Each ✓ is a positive case; each ✗ is a negative case asserting the transition is
blocked with an appropriate message. Also test: entry actions, exit actions, and
whether the transition is blocked or merely discouraged in the UI while remaining
possible via API.

## Pairwise / combinatorial

When the full cross-product is impractical — 4 channels × 5 case types × 3
priorities × 4 personas = 240 combinations — cover all *pairs* of values instead,
which typically catches the great majority of combinatorial defects in a fraction
of the cases. State in the document that pairwise was used and which pairs are
covered, so nobody assumes exhaustive coverage.

Keep full-cross-product coverage for the genuinely critical combinations, chosen
by risk.

## CRUD and permission matrix

For every object × persona, test Create, Read, Update, Delete, plus field-level
visibility and edit rights on sensitive fields.

| Object | Agent | Senior Agent | Supervisor | Community User | Integration User |
|---|---|---|---|---|---|
| Case | CRU | CRU | CRUD | CR (own) | CRU |
| Case (other agents') | R | RU | CRUD | ✗ | CRU |
| Knowledge | R | RU | CRUD | R (published, public categories) | ✗ |
| `Warranty_Claim__c` | R | CRU | CRUD | ✗ | CRU |

Every ✗ is a negative test — attempted access should be denied, and denied in the
API as well as the UI. Access controls that exist only in the interface are a
recurring finding.

## Path and flow coverage

For process flows and screen flows: cover every branch at minimum, every decision
outcome, plus the cancel/back/abandon paths and behaviour on session timeout
mid-flow. For loops: zero iterations, one, many, and the maximum.

## Error guessing and risk-based emphasis

Weight extra cases toward: newly built components, anything integrated, anything
that was hard to specify, areas with defect history, and anything touching money,
permissions or personal data.

Reliably productive guesses: duplicate submission (double-click, retried
message), concurrent edit of the same record by two users, session expiry
mid-transaction, back-button after submit, very large attachments, special
characters and multi-byte text, time zone and DST boundaries, records with no
related children, and the maximum-size record.

## Technique selection

| Condition shape | Technique |
|---|---|
| Field with a value range or length | Boundary value analysis |
| Field with a fixed value set | Equivalence partitioning |
| Several conditions combining into outcomes | Decision table |
| Lifecycle or status field | State transition |
| Many independent configuration options | Pairwise |
| Access control | CRUD / permission matrix |
| Process or screen flow | Path coverage |
| Integration interface | Success, failure, timeout, duplicate, malformed payload |
| Novel or high-risk area | Error guessing on top of the systematic techniques |

---

# Appendix B — Coverage Checklist

Work through these per requirement. Not every dimension applies to every
requirement — but each one should be considered and consciously dismissed rather
than forgotten. Read during Step 4.

## Functional

- [ ] **Happy path** — the primary success scenario, exactly as the requirement
      describes it
- [ ] **Alternative paths** — other legitimate routes to the same outcome
- [ ] **Optional inputs** — behaviour when optional fields are omitted
- [ ] **Defaults** — that defaults apply when nothing is supplied, and that they
      can be overridden
- [ ] **Idempotence** — performing the action twice; does it duplicate, update,
      or reject
- [ ] **Cancel and abandon** — mid-process exit leaves no partial data

## Input validation

- [ ] Mandatory fields enforced (UI **and** API — they often differ)
- [ ] Field length, format, type and range boundaries
- [ ] Picklist values, including values valid in the data model but not on the
      layout
- [ ] Special characters, multi-byte text, emoji, RTL scripts, leading/trailing
      whitespace
- [ ] Injection-shaped input (`<script>`, SQL/SOQL fragments) stored and rendered
      safely
- [ ] Cross-field validation and interdependent rules
- [ ] Error messages — present, specific, and pointing at the right field

## Data

- [ ] Empty state — no records, no children, no related data
- [ ] Single record
- [ ] Many records — pagination, sorting, list view limits
- [ ] Maximum-size record — every field populated to its limit
- [ ] Records with missing optional relationships
- [ ] Duplicate detection and merge behaviour
- [ ] Deleted and recycled records
- [ ] Historic or migrated data that doesn't match current validation rules

## Permissions and personas

- [ ] Each persona's positive path
- [ ] Each persona's denied path — attempted access is refused
- [ ] Denial enforced at API level, not just in the UI
- [ ] Field-level security on sensitive fields
- [ ] Record-level sharing: own records, team records, others' records
- [ ] Unauthenticated/guest access where a public surface exists
- [ ] Elevated actions (delete, mass update, export) restricted appropriately

## State and lifecycle

- [ ] Every valid transition
- [ ] Every invalid transition explicitly blocked
- [ ] Entry and exit actions fire
- [ ] Behaviour on records already in a terminal state
- [ ] Concurrent modification by two users

## Integration

- [ ] Success round-trip with expected payload
- [ ] Target system unavailable — timeout behaviour and user-facing message
- [ ] Target returns an error (4xx, 5xx) — handling, logging, alerting
- [ ] Malformed or unexpected payload
- [ ] Duplicate message delivery — idempotency key prevents double processing
- [ ] Out-of-order delivery, where the pattern allows it
- [ ] Retry and dead-letter behaviour
- [ ] Authentication failure and credential expiry
- [ ] Large payload / bulk volume
- [ ] Business process continues degraded, as designed

## Automation and business logic

- [ ] Trigger conditions met — automation fires
- [ ] Trigger conditions *not* met — automation does not fire (frequently missed)
- [ ] Bulk operation — automation behaves correctly on a full batch, not just
      single records
- [ ] Recursive update doesn't loop
- [ ] Error path within the automation surfaces the error somewhere a human sees
      it
- [ ] Interaction with other automation on the same record

## Non-functional

- [ ] Response time under expected and peak load
- [ ] Concurrent user load
- [ ] Data volume at the projected 3-year level
- [ ] Batch/scheduled job completion within its window
- [ ] Accessibility — keyboard navigation, screen reader labels, contrast, focus
      order
- [ ] Browser and device matrix
- [ ] Localisation — language, date format, currency, time zone
- [ ] Session timeout and re-authentication

## Security

- [ ] Authentication and SSO paths, including failure
- [ ] Authorisation bypass attempts — direct URL/record ID access
- [ ] Sensitive data not exposed in URLs, logs, exports or error messages
- [ ] Audit trail records who did what
- [ ] Data export controls

## Regression

- [ ] Existing functionality sharing the same object, page or automation still
      behaves
- [ ] Reports and dashboards depending on changed fields still return correct
      results
- [ ] Existing integrations unaffected by schema changes
- [ ] Previously fixed defects in the same area

## Migration and cutover (where in scope)

- [ ] Record counts reconcile between source and target
- [ ] Field-level data fidelity on a sampled set
- [ ] Relationships preserved
- [ ] Records that fail validation on load — handled and reported
- [ ] Rollback path

## Balance check

Count the pack when finished. If more than roughly two-thirds of cases are
positive-path, the failure space is under-tested — go back to boundaries,
permissions and integration failures before delivering.

---

# Appendix C — Salesforce / Service Cloud Testing Reference

Read this whenever the artefacts describe a Salesforce build. These are the test
angles that generic test design misses because they depend on platform behaviour.
Read during Step 4.

## Configuration-level tests

**Profiles and permission sets** — object CRUD, field-level security, tab
visibility, record type access, app access, and system permissions per persona.
Test both grant and denial, and confirm denial holds via API, not only in the UI.
Permission set groups need testing as groups, including the effect of muting.

**Record types and page layouts** — the correct layout appears for each record
type × profile combination; picklist values are correctly filtered per record
type; the record type selection screen appears (or is bypassed) as designed.

**Dynamic Forms and Dynamic Actions** — conditional field and button visibility
for each condition, including the state where no condition matches.

**Validation rules** — one case per rule: the condition that trips it, the
condition that doesn't, the error message text, and the field the error attaches
to. Test each rule via UI, API and data load, since data loads are where
validation surprises surface.

**Duplicate and matching rules** — duplicate detected and blocked or warned;
near-match not falsely flagged; behaviour on bulk load.

**Assignment, escalation and auto-response rules** — the matching entry fires,
later entries don't, and the default applies when nothing matches. Confirm
behaviour on update as well as insert.

## Automation tests

**Flows** — for every record-triggered Flow: entry criteria met (fires), entry
criteria not met (does not fire), each decision branch, the fault path, and
behaviour on a bulk update of 200 records. For Screen Flows: every screen, every
branch, validation on screen inputs, the back and cancel paths, and session
timeout mid-flow.

**Apex** — beyond unit tests, system-level cases for: bulk behaviour at 200
records, recursion control, transaction rollback on partial failure, and
behaviour when a dependent callout fails. Confirm `with sharing` behaviour by
executing as a restricted persona rather than an admin.

**Interaction between automations** — where Flow and Apex both act on an object,
test that the combined result is correct and that field updates from one are
visible to the other in the expected order.

**Approval processes** — submission, approval, rejection, recall, delegated
approver, and the record locking behaviour while pending.

## Service Cloud capability tests

**Email-to-Case** — new email creates a case; a reply on an existing thread
appends rather than creating a duplicate; attachments carry across; malformed
sender; auto-reply loops don't recur; email from an unknown address; oversized
attachment.

**Web-to-Case** — successful submission, required-field enforcement, spam/rate
limiting, and behaviour when the daily limit is reached.

**Omni-Channel routing** — work routes to an available agent with capacity;
queues when no agent is available; skills-based routing selects the correct skill
set; capacity limits respected; agent declines/times out; agent goes offline
mid-assignment; supervisor reassignment.

**Entitlements and milestones** — milestone starts on the right trigger; business
hours and holidays applied correctly; warning, violation and success actions
fire; milestone completes on the right action; case with no entitlement;
entitlement expired.

**Knowledge** — article visibility per data category and per persona (internal,
partner, public); draft not visible; published visible; article attached to case
records deflection; translation displays for the right locale; search returns the
expected article for the expected term.

**Case hierarchy and merging** — parent/child behaviour, closing a parent with
open children, and merge behaviour on duplicate cases.

**Macros and Quick Text** — execute the expected actions; unavailable where the
persona lacks permission.

**Experience Cloud** — authenticated user sees only their own records; guest user
access limited to what's intended (test attempted access to a record ID
directly); sharing sets behave; self-registration; password reset; branding and
responsive layout.

**Service Cloud Voice / CTI** — call arrives and screen-pops the right record;
call logged; transcription attached; transfer and conference.

## Data and sharing tests

**Org-Wide Defaults and sharing** — a user can see exactly what the design says
and nothing more. Test with actual restricted users, never with a System
Administrator, because admin access masks every sharing defect.

**Role hierarchy** — a manager sees subordinates' records; a peer does not.

**Sharing rules, teams, manual sharing** — each mechanism grants the intended
access, and removal revokes it.

**Restriction and scoping rules** — where used, confirm both the narrowing and
that legitimate access survives.

## Bulk and governor limit tests

- Data load of 200 records through every record-triggered automation on the
  object
- Data load at realistic migration volume through the same path
- Mass update from a list view
- A record with the maximum number of children (roll-up recalculation, lookup
  skew)
- Batch job over the projected data volume, completing within its window
- Confirm no `System.LimitException` in the logs for any of the above

## Integration tests

Beyond the generic integration checklist, Salesforce-specific angles:

- Named Credential authentication failure and token expiry
- Callout timeout — the user-facing message and whether the transaction rolls
  back
- Platform Event published and consumed; event not delivered; replay after a gap
- Change Data Capture event fires on the expected field changes only
- External Object (Salesforce Connect) query when the source system is slow or
  down
- Bulk API load with a partial failure — error file content and reprocessing
- Idempotency: the same inbound message delivered twice produces one record,
  matched on the External ID
- Integration user permissions are sufficient but not excessive

## Environment and release tests

- The build deploys cleanly to a fresh sandbox from source control
- Post-deployment configuration steps are documented and executed
- Test data can be created in a fresh environment without manual database surgery
- Regression pack runs against a Salesforce preview sandbox ahead of each
  seasonal release

## Test data notes

State test data as specific records: `Account "Northwind Traders" (Type =
Customer, Tier = Gold)`, `Contact "Priya Sharma" (Email =
priya.sharma@example.test)`, `Case #00001234 (Status = In Progress, Priority =
High, Entitlement = Gold Support)`. Use `example.test` or a domain the client
controls for email addresses so tests don't send mail to real people, and note
whether the sandbox has email deliverability restricted — that setting silently
changes the outcome of several of the tests above.

---

# Appendix D — Output Formats

Markdown is always written. Read during Step 7 when adding a companion format.

## Markdown (default)

Readable, reviewable, diff-friendly. Use the per-case block format for detailed
cases and a summary table up front for navigation.

```markdown
### TC-CASE-014 — Escalation blocked when reason is blank

| | |
|---|---|
| **Requirement** | R-08, R-09 |
| **Type** | Negative / Validation |
| **Level** | System |
| **Priority** | P1 |
| **Persona** | Tier 1 Agent (`Service_Agent` permission set) |
| **Technique** | Boundary value analysis |
| **Automation** | Yes — deterministic UI validation |

**Preconditions**
- Logged in as `agent1@example.test` with the Tier 1 Agent permission set
- Case #00001234 exists with Status = In Progress, Owner = agent1

**Test data**
- Escalation Reason: `""` (left blank)

**Steps**

| # | Action | Expected |
|---|---|---|
| 1 | Open Case #00001234 | Case record page loads, Status shows In Progress |
| 2 | Click the **Escalate** action | Escalation screen opens with Reason field marked required |
| 3 | Leave Reason blank and click **Submit** | Submission blocked; inline error "Escalation Reason is required" appears against the Reason field |
| 4 | Close the screen and refresh the Case | Status remains In Progress; Owner unchanged; no escalation entry in the case history |

**Expected result** — The escalation is rejected, the case is unmodified, and the error identifies the specific field.

**Postconditions** — Case #00001234 unchanged. No notification sent to the supervisor.
```

## Gherkin (BDD)

Use one `Feature` per requirement or user story, `Scenario Outline` with
`Examples` for data-driven variants. Keep steps declarative — describe behaviour,
not UI mechanics, so the scenarios survive interface changes.

```gherkin
Feature: Case escalation
  As a support agent
  I want to escalate a case to a supervisor with a reason
  So that urgent issues receive senior attention

  Background:
    Given I am logged in as a Tier 1 Agent
    And a case "00001234" exists with status "In Progress" assigned to me

  Scenario: Successful escalation with a reason
    When I escalate case "00001234" with reason "Customer threatening to cancel"
    Then the case status should be "Escalated"
    And the case owner should be the Tier 2 Supervisor queue
    And the supervisor should receive an escalation notification
    And the escalation reason should be recorded in the case history

  Scenario: Escalation blocked without a reason
    When I attempt to escalate case "00001234" without a reason
    Then the escalation should be rejected with the message "Escalation Reason is required"
    And the case status should remain "In Progress"

  Scenario Outline: Escalation permission by persona
    Given I am logged in as a "<persona>"
    When I view case "00001234"
    Then the escalate action should be "<availability>"

    Examples:
      | persona          | availability |
      | Tier 1 Agent     | available    |
      | Tier 2 Agent     | available    |
      | Supervisor       | available    |
      | Read-Only Auditor| unavailable  |
      | Community User   | unavailable  |
```

Avoid `And I click the button labelled "Escalate"` — UI-coupled steps are the
main reason BDD suites rot.

## CSV for test management tools

Column sets differ per tool — use the tool-agnostic set unless the target tool is
known from the requirements.

**Jira / Xray (Test issue import)**

```
Issue Type, Summary, Description, Test Type, Priority, Labels, Component,
Test Repository Path, Precondition, Action, Data, Expected Result
```

Multi-step tests repeat the row with the same Summary, one row per step, filling
Action / Data / Expected Result per row.

**Zephyr Scale / Squad**

```
Name, Objective, Precondition, Priority, Status, Folder, Owner, Labels,
Test Script (Step), Test Data, Expected Result, Coverage (Issues)
```

**TestRail**

```
Title, Section, Template, Type, Priority, Preconditions, Steps, Expected Result,
References, Automation Type
```

TestRail's "Steps (Separated)" format uses `Steps Step`, `Steps Expected Result`,
`Steps Additional Info`.

**Azure DevOps (Test Case work item)**

```
Work Item Type, Title, Area Path, Iteration Path, Priority, State, Assigned To,
Steps (HTML), Automation Status, Tags
```

Steps are supplied as an HTML `<steps>` block; generate it rather than expecting
a manual paste.

**Generic / tool-agnostic** — safest when the tool is unknown:

```
Test ID, Title, Requirement ID, Type, Level, Priority, Persona, Preconditions,
Test Data, Step Number, Step Action, Step Expected Result, Overall Expected Result,
Postconditions, Automation Candidate, Notes
```

One row per step, with Test ID repeating. Every tool can be mapped from this
shape.

## Traceability matrix

Always output both directions.

**Requirement → tests (find the gaps)**

| Req ID | Requirement | Test Cases | Positive | Negative | Coverage |
|---|---|---|---|---|---|
| R-08 | Agent can escalate with reason | TC-CASE-012, 013, 014, 015 | 2 | 2 | Full |
| R-11 | Escalation SLA notification | — | 0 | 0 | **Gap — no test environment for email** |

**Test → requirement (find the orphans)**

| Test ID | Requirement(s) |
|---|---|

An orphan test either covers an implicit requirement worth documenting, or
shouldn't exist. Resolve it rather than leaving it in.
