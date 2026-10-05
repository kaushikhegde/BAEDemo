# BAE Systems Australia — Source-to-Procure, round 1

**Date:** 2026-10-05
**Status:** design, awaiting review
**Touches:** `projects/BAE/` (new), `generated-apps/`, root leftover folders,
`skills/{document-extract,capability-process-map,persona-journey-map}/SKILL.md`

## Why

The workspace is being repurposed from SA Power Networks to **BAE Systems
Australia**. The client's brief, verbatim:

> Source to procure. Fabricate existing documents. Current System On premise
> Oracle. What could be process document.

There are no real client documents. We write realistic, clearly-labelled
synthetic ones describing BAE's current Source-to-Procure (S2P) world on
on-premise Oracle, then run the project-level stages over them.

Public context used to make the documents plausible: BAE Systems Australia
employs roughly 7,000 people across about 40 sites, manages 1,600+ suppliers
across direct and indirect spend, and delivers the Hunter class frigates, the
Jindalee Operational Radar Network upgrade and Nulka.

## Decisions already made

| Question | Decision |
|---|---|
| Target platform | **None.** Describe and improve today's on-prem Oracle. No new system is designed. BAE's real 2024 selection of Ivalua is deliberately left out of the project definition. |
| Phasing | **Round 1:** cleanup, synthetic documents, project floor (capability map, process model, personas, companion app). **Round 2:** rewrite the three Salesforce-bound skills for Oracle and run the feature floor. |
| Document creation | **Hand-written, once.** No reusable fabricator skill, now or later. |
| Publishing | **Off** for round 1. Nothing is written to Confluence, Jira or Azure DevOps. |

## Part 1 — Cleanup

Nothing is deleted until the user has seen the dry-run plan.

1. **Old projects `SAPN` and `SAPN_DEMO`.** There is no per-project delete;
   the supported route is `npm run orch -- reset --all`. Stop `npm run dev`,
   run the bare verb (dry run), show the plan, then `--all --yes`.
   *Side effect:* `--all` also removes users, chats and the installation
   claim, so the admin account is re-created afterwards. Blob bytes for the
   old documents are checked separately and removed if `reset` leaves them.
2. **Old companion apps:** `generated-apps/{SA-DEMO-1,SAPN,SAPN_DEMO}/` and
   their entries in `generated-apps/registry.json`.
3. **Root leftovers:** `dummy/`, `output/`, `outputs/`, `productsummary/`,
   `sop/`, `transcripts/`, `inputs/`, `inputs-source/`, `input-files/`,
   `datamodel/`, `templates/`. No live code reads them (only
   `agent-instructions/legacy/*.json` mentions some). Tracked ones go via
   `git rm` so the removal is one revertable commit.
4. **Kept:** `examples/` (house-style fallback, read by `stage.mjs`),
   `datamodel-reference/` (round 2 decides), `agent-instructions/legacy/`.

## Part 2 — The project

- Key `BAE`, display name "BAE Systems Australia". No feature in round 1.
- Created through `POST /api/projects` so the database row exists first.
- `projects/BAE/description.md` — the project definition every skill reads:
  - who BAE Systems Australia is (defence prime, scale, programs, sustainment);
  - scope: Source-to-Procure — supplier management, sourcing and tender,
    contracts, requisition to PO, receipt, invoice and payment;
  - current system: Oracle E-Business Suite R12.2, on-premise;
  - constraints that shape procurement: DISP membership for suppliers, export
    control (ITAR/EAR and Australian Defence export controls), Australian
    Industry Capability obligations, ASDEFCON flow-down clauses, the Modern
    Slavery Act 2018;
  - an explicit line: **no target platform has been selected**; improvements
    are framed within the current Oracle estate.

## Part 3 — The synthetic documents

Ten markdown files, uploaded through the normal project upload route
(`POST /api/upload/project`) so they reach the database, blob storage and
extraction exactly as a real client's would.

Every file opens with:

> **SYNTHETIC — illustrative document created for discovery. Not a BAE
> Systems record.**

| # | Document | Contents |
|---|---|---|
| 1 | Procurement Policy | Principles, quote and tender thresholds by value, conflict of interest, probity, Defence flow-downs, AIC, modern slavery |
| 2 | Delegation of Authority | Financial approval limits by role, from team lead to Managing Director |
| 3 | SOP-01 Supplier Onboarding & Vetting | New-supplier request, ABN / DISP / export-control / financial / modern-slavery checks, bank-detail call-back, set-up in Oracle Suppliers and iSupplier Portal |
| 4 | SOP-02 Requisition to Purchase Order | iProcurement requisition, AME approval routing, buyer conversion to PO in Oracle Purchasing, blanket agreements and catalogues |
| 5 | SOP-03 Strategic Sourcing & Tender | RFQ / RFT, evaluation panel, probity, award, contract hand-off |
| 6 | SOP-04 Goods Receipt & Three-Way Match | Receiving, invoice entry in Payables, PO–receipt–invoice tolerances, holds, payment run |
| 7 | Workshop transcript — Procurement Lead | Tenders on email and spreadsheets, no supplier performance data, manual AIC reporting |
| 8 | Workshop transcript — Accounts Payable Officer | Invoices on hold, re-keying PDF invoices, duplicate supplier records |
| 9 | Workshop transcript — Engineer, Hunter program | Slow approvals, no PO status visibility, card spend to avoid delay, export-control confusion |
| 10 | Oracle EBS R12.2 Current-State Landscape | Modules in use, customisations, nightly batch interfaces, known-issues register |

**Consistency.** One private fact sheet (kept in the scratchpad, never
uploaded) fixes role names with abbreviations, approval limits, volumes and
Oracle module names. All ten documents agree with it.

**Planted gaps.** The SOPs state the intended process; the transcripts reveal
the workarounds people actually use. Each planted gap is listed in the fact
sheet so the review in Part 4 can check the pipeline found it.

All content is Australian English.

## Part 4 — Skill tweaks and verification

**Principle:** skills stay generic. Client and domain knowledge lives in
`description.md` and the documents, never in a `SKILL.md`.

| File | Change |
|---|---|
| `skills/document-extract/SKILL.md` | Replace the one claims-specific example with a neutral one |
| `skills/capability-process-map/SKILL.md` | Replace claims-flavoured examples with neutral ones |
| `skills/persona-journey-map/SKILL.md` | Same; add that a persona may be internal staff or a supplier, not only an external customer |

Not changed in round 1, with reason:

- `scripts/render-capability-map.mjs` mentions SAPN only in two comments.
- `scripts/render-companion-app.mjs` labels "Salesforce schema" only on the
  feature-level data-model tab, which round 1 never renders.

**Verification**

1. `npm run link-skills`.
2. Upload the ten documents. `GET /api/extract-status/BAE` reports all ten
   ready; `validate-extracts.mjs` passes.
3. Run `baseline`. `render-capability-map.mjs --validate-only` and
   `validate-experience.mjs` both exit 0.
4. Review by eye, then approve the gates:
   - the capability map covers supplier management, sourcing, contracts,
     purchasing, receiving and payment;
   - persona names match the fact sheet verbatim;
   - every planted gap surfaces as a pain point or gap.
5. Render the companion app and open it.

## Out of scope (round 2)

- Rewriting `salesforce-data-modeler`, `salesforce-service-cloud-architecture`
  and `solution-design-document` for Oracle EBS.
- Adjusting `requirements-test-case-generator` terminology.
- Replacing or dropping `datamodel-reference/`.
- Choosing S2P features and running the feature floor.
- Publishing.
