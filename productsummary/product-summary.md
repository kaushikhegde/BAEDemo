# Product Summary — Review & Verify Evidence
**Project:** RTWSA | **Feature:** Interim Benefits — Review Evidence
**Process L3:** 2.4 Review & Verify evidence | **Process L4:** 2.4.1 Review evidence
**Date:** 28 May 2026

---

## 1. Product Summary Overview

### Context

The Return to Work SA (RTWSA) scheme supports injured workers to recover from their injury and return to work and life as soon as possible. The scheme provides financial and medical support, including coverage of reasonable and necessary medical treatment expenses, rehabilitation, and associated costs. This feature covers the review and verification of received evidence, enabling Eligibility Officers to assess and manage evidence submissions linked to claims and cases in support of final determination decisions.

### Objectives

- Provide a context-aware Evidence Received tab that displays evidence items filtered by Claim or Case view to support efficient evidence triage.
- Enable Eligibility Officers to update verification status on individual evidence items with system-enforced business rules.
- Enable bulk status updates across multiple evidence items to improve processing efficiency.
- Support detailed document review, including multi-document navigation within a single evidence item.
- Capture structured rationale (Reason for Approval, Reason for Decline, Other Comments) against each evidence item for auditability.
- Provide a consolidated Supporting Information summary at Claim level that can be exported to Excel for use in determination letters.

### Assumptions

- Only the Eligibility Officer (EO) role has authority to update evidence verification status.
- AWE Calculation evidence type is exempt from the requirement for a document attachment before verification.
- Copy-paste from the document preview pane is primarily supported for PDF format documents.
- Once an evidence item status is set to Verified or Rejected, no further status changes are permitted — the item is considered final.
- The Mobile Claims Manager (MCM) can access the Evidence Received tab; their status-update authority is not confirmed and is recorded as a gap.

### Out of Scope

- Creation or uploading of new evidence requests.
- Income support payment processing.
- Serious injury classification or assessment workflows.
- Integration with third-party document management systems beyond the existing document previewer.

---

## 2. User Personas

| Persona | Permission Set Groups | Permission Set | Sharing Rules |
|---|---|---|---|
| Eligibility Officer (EO) | Not specified — see gaps | Not specified — see gaps | Not specified — see gaps |
| Mobile Claims Manager (MCM) | Not specified — see gaps | Not specified — see gaps | Not specified — see gaps |

---

## 3.1 Business Requirements

| Process L3 | Subprocess L4 | User Story | Acceptance Criteria |
|---|---|---|---|
| 2.4 Review & Verify evidence | 2.4.1 Review evidence | **2.4.1.1** As an Eligibility Officer, I want to view a context-aware list of received evidence items on the Evidence Received tab, So that I can efficiently manage and prioritise evidence review across claims and cases. | When on a Claim view, the tab displays all evidence for the claim including linked cases. When on a Case view, only evidence raised on that specific case is shown. Columns include Evidence Name/Description, Request Type, Claim/Case Number, Status, Received Date & Time, Number of Documents. Status defaults to Unverified. The list is searchable and the Status field is filterable. |
| 2.4 Review & Verify evidence | 2.4.1 Review evidence | **2.4.1.2** As an Eligibility Officer, I want to update the verification status of individual or multiple evidence items, So that I can accurately record the outcome of my evidence review and progress the claim workflow. | The EO can change status to Partially Verified, Verified, Rejected, or No Longer Required. System prevents Verified/Partially Verified when no document is attached (except AWE Calculation type). Verified and Rejected statuses are final and cannot be changed. Bulk status update is available via dropdown with per-item rule validation. |
| 2.4 Review & Verify evidence | 2.4.1 Review evidence | **2.4.1.3** As an Eligibility Officer, I want to view the detailed information and preview documents attached to a single evidence item, So that I can thoroughly review submitted documentation before recording a verification decision. | Detailed view shows Evidence Description, Received Date & Time, Status, and Evidence Item Type. A document previewer pane renders attached documents. Multiple documents can be navigated via a dropdown. Status update is available in the detailed view with business rules enforced on save. |
| 2.4 Review & Verify evidence | 2.4.1 Review evidence | **2.4.1.4** As an Eligibility Officer, I want to record a reason for approval, reason for decline, and other comments against an evidence item, So that my verification rationale is documented for auditability and use in the determination process. | Three text fields are provided: Reason for Approval, Reason for Decline, Other Comments. Each field has a 32,768 character limit with validation error on exceed. The EO can copy text from the document preview pane into the fields (primarily for PDFs). |
| 2.4 Review & Verify evidence | 2.4.1 Review evidence | **2.4.1.5** As an Eligibility Officer, I want to view a consolidated summary of all supporting information captured across evidence items for a claim and export it, So that I can efficiently compile the verified rationale needed for the final determination letter. | A Supporting Information tab at Claim level aggregates all rationale across evidence items. Table columns: Evidence Name, Approval Reason, Decline Reason, Other Notes. Manual clipboard copy is available. A Redirect To Report button generates an exportable Excel document. |

---

## 3.2 Business Flow

Business flow diagram unavailable. The end-to-end flow begins with the Eligibility Officer accessing the Evidence Received tab in the context of a Claim or Case, reviewing and verifying evidence items individually or in bulk, capturing structured supporting information, and finalising rationale via the Supporting Information tab for use in the determination letter.

---

## 3.3.1 Data Model

Placeholder – Maintained manually. Do not populate via automation.

---

## 3.3.2 Data Migration

| Item | Detail | Notes |
|---|---|---|
| N/A | No data migration requirements identified from inputs. | No historical evidence records are referenced for migration. |

---

## 3.4 Validation

| Feature | Rule | Outcome | Notes |
|---|---|---|---|
| Evidence Status Update | Status cannot be set to Verified or Partially Verified if no document is attached | System prevents save and displays an error | Exception: AWE Calculation evidence type may be marked Verified without a document |
| Evidence Status Finality | Status cannot be changed once set to Verified or Rejected | System does not permit further status updates; field is locked or save is rejected | Prevents tampering or unintended workflow changes |
| Supporting Information Character Limit | Each of the three supporting information fields has a maximum of 32,768 characters | System displays a validation error on submission if limit is exceeded | Applies to Reason for Approval, Reason for Decline, and Other Comments |

---

## 3.5 Integration

| Integration Point | Detail | Notes |
|---|---|---|
| N/A | No integration requirements identified from inputs. | |

---

## 3.6 Reporting

| Report | Description | Notes |
|---|---|---|
| Supporting Information Export | A Redirect To Report button generates a final table view of all supporting information for the claim, exportable to Excel. | Intended for inclusion in determination packs. Column layout not specified — see gaps.md. |

---

## 4. Key Design Decisions

| Date | Decision | Detail | Source |
|---|---|---|---|
| 28 May 2026 | Evidence list is context-aware based on Claim vs Case view | On a Claim view the list includes all evidence for the claim and linked cases; on a Case view the list is restricted to that case only. | transcripts/transcript.docx |
| 28 May 2026 | AWE Calculation evidence type is exempt from the document-required validation | All evidence types except AWE Calculation must have a document attached before status can be set to Verified or Partially Verified. AWE Calculation is exempt due to its nature. | transcripts/transcript.docx |
| 28 May 2026 | Verified and Rejected statuses are final and irreversible | Once set to Verified or Rejected, no further status changes are permitted to prevent tampering. | transcripts/transcript.docx |
| 28 May 2026 | Supporting information is summarised at Claim level | The Supporting Information tab aggregates rationale from all evidence items across the claim and its linked cases. | transcripts/transcript.docx |
| 28 May 2026 | Two methods provided for extracting supporting information | Method 1: manual clipboard copy from table columns. Method 2: Redirect To Report button generating an exportable Excel document. | transcripts/transcript.docx |
| 28 May 2026 | 32,768 character limit for all three supporting information fields | Agreed due to complexity of some claims requiring detailed rationale. | transcripts/transcript.docx |

---

## 5.1 User Journey

| Step | Actor | Description | System Behaviour |
|---|---|---|---|
| 1 | Eligibility Officer (EO) | Navigates to a Claim or Case record and opens the Evidence Received tab. | System displays a context-aware, filterable evidence list relevant to the Claim or Case context. |
| 2 | Eligibility Officer (EO) | Searches or filters the evidence list to locate items requiring review. | System filters the list in real time based on search input and status filter selection. |
| 3 | Eligibility Officer (EO) | Selects an evidence item to open the detailed view. | System displays evidence details and renders the document in the previewer pane. |
| 4 | Eligibility Officer (EO) | Reviews attached documents, navigating between multiple documents if present. | Previewer allows document switching via dropdown or navigation control. |
| 5 | Eligibility Officer (EO) | Enters Reason for Approval, Reason for Decline, and/or Other Comments. | System validates character limits (32,768 per field) and surfaces errors if exceeded. |
| 6 | Eligibility Officer (EO) | Updates the evidence item status (e.g., Verified, Rejected). | System enforces validation rules (document-required, AWE exception, finality) and saves the status. |
| 7 | Eligibility Officer (EO) | Optionally selects multiple items and applies a bulk status update. | System applies individual business rule validation to each selected item before saving. |
| 8 | Eligibility Officer (EO) | Navigates to the Supporting Information tab at Claim level. | System displays a consolidated table of all rationale captured across evidence items for the claim. |
| 9 | Eligibility Officer (EO) | Copies rationale text manually or clicks Redirect To Report and exports to Excel. | System generates and downloads an Excel document containing all supporting information for the claim. |

---

## 5.2 UI / Screen Behaviour

| Screen | Component | Description | Acceptance Criteria | Notes |
|---|---|---|---|---|
| Evidence Received List | Evidence table | Paginated table displaying received evidence items with columns: Evidence Name, Request Type, Claim Number, Case Number, Status, Received Date & Time. | Table renders all required columns; status badges are colour-coded (Unverified — grey, Verified — green, Rejected — red); pagination displays record count. | UI screen shows Claim Number and Case Number as separate columns; transcript references a combined Claim/Case Number — confirm with business. |
| Evidence Received List | Search bar | Full-text search across Evidence Description, Request Type, Claim/Case Number, Status, and Received Date & Time. | Search filters the list in real time as the user types. | |
| Evidence Received List | Status filter dropdown | Dropdown labelled All Statuses with options: Unverified, Partially Verified, Verified, Rejected, No Longer Required. | Selecting a status option filters the table to matching records only. | |
| Evidence Item Detail | Document previewer pane | Renders attached document(s) for the selected evidence item. | Displays the primary document on load; if multiple documents exist, a dropdown or navigation control is available to switch between them. | Primarily supports PDF format for copy-paste functionality. |
| Evidence Item Detail | Supporting Information fields | Three text inputs: Reason for Approval, Reason for Decline, Other Comments. | Each field accepts up to 32,768 characters; validation error is displayed on save if exceeded. | |
| Evidence Item Detail | Status update control | Allows the EO to update the evidence item status from the detail screen. | All business rules are enforced on save; Verified/Rejected items display the status as read-only. | |
| Claim — Supporting Information Tab | Supporting Information summary table | Table at Claim level aggregating all rationale from associated evidence items. | Columns: Evidence Name, Approval Reason, Decline Reason, Other Notes; full text is visible without truncation. | |
| Claim — Supporting Information Tab | Redirect To Report button | Generates a final view of all supporting information for the claim and enables Excel export. | Clicking the button opens the report view; an export to Excel function is available and produces a downloadable Excel file. | Column layout of the Excel export is not specified — raised in gaps.md. |

---

## 6. Test Cases

| Test Case | Feature | Steps | Expected Result |
|---|---|---|---|
| TC-001 | Context-Aware Evidence List — Claim View | 1. Navigate to a Claim record. 2. Open the Evidence Received tab. | The list displays all evidence requests for the claim, including those from linked subsequent cases. |
| TC-002 | Context-Aware Evidence List — Case View | 1. Navigate to a Case record. 2. Open the Evidence Received tab. | The list displays only evidence requests raised on that specific case. |
| TC-003 | Status Update Validation — No Document | 1. Open a non-AWE Calculation evidence item with no document attached. 2. Attempt to set Status to Verified. 3. Save. | System prevents the save and displays an error indicating a document must be attached. |
| TC-004 | Status Update Validation — AWE Calculation Exception | 1. Open an AWE Calculation evidence item with no document attached. 2. Set Status to Verified. 3. Save. | System permits the save and updates the status to Verified. |
| TC-005 | Status Finality — Verified | 1. Open an evidence item with Status = Verified. 2. Attempt to change the status to another value. | System does not permit further status changes; the status field is locked or the save is rejected. |
| TC-006 | Supporting Information Character Limit | 1. Open an evidence item detail screen. 2. Enter text exceeding 32,768 characters in the Reason for Approval field. 3. Submit. | System displays a validation error indicating the character limit has been exceeded. |
| TC-007 | Excel Export — Redirect To Report | 1. Navigate to the Supporting Information tab on a Claim record. 2. Click Redirect To Report. 3. Click the export to Excel function. | An Excel document is generated containing all supporting information columns for the claim. |

---

## 7. Non-Functional Requirements

Placeholder – Maintained manually. Do not populate via automation.

---

## 8. Security and Compliance

Placeholder – Maintained manually. Do not populate via automation.

---

## 9. Deployment and Rollout

Placeholder – Maintained manually. Do not populate via automation.

---

## 10. Dependencies and Risks

Placeholder – Maintained manually. Do not populate via automation.

---

## 11. Approvals and Sign-off

Placeholder – Maintained manually. Do not populate via automation.
