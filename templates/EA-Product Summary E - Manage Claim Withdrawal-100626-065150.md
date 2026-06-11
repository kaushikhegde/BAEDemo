# Product Summary E - Manage Claim Withdrawal

> ℹ️ **Final Draft Document** V1.5 as at 16.09.2025 - View access only except relevant BA and PM

> **Note:** An on-screen OneDrive "Connect" popup obscured small portions of several tables in the source PDF (the User Personas table, parts of the Validation table, and the first row of Key Design Decisions). Those spots are marked *(obscured in source)* below.

## Contents

1. Product Summary Overview
2. User Personas
3. Requirements
   - 3.1 Business Requirements
   - 3.2 Data Requirements
     - 3.2.1 Data Model
     - 3.2.2 Data Migration
   - 3.3 Validation
   - 3.4 Integration
   - 3.5 Reporting
4. Key Design Decisions
5. Functionality
6. Test Cases
7. Solution Design
8. Change Impact and Training Needs
9. Links
10. Document Governance
11. Document History

---

## 1. Product Summary Overview

The product summary describes how user personas listed below withdraw and re-open an injury item on a case.

---

## 2. User Personas

| Persona | Permission Set Groups | Permission Set | Sharing Rules |
| --- | --- | --- | --- |
| Eligibility Officer (EO) | • Agent Permission Set Group (Based on the role of the user)<br>• Lodgement_EML_Permission_Set_Group (Based on the organisation of the user)<br>• Lodgement_GB_Permission_Set_Group (Based on the organisation of the user) *(row partly obscured in source)* | | |
| Eligibility Officer (EO) Team Lead | • Agent Permission Set Group (Based on the role of the user)<br>• Team Lead Permission Set Group (Based on the role of the user)<br>• Lodgement_GB_Permission_Set_Group (Based on the organisation of the user)<br>• Lodgement_EML_Permission_Set_Group (Based on the organisation of the user) | | |
| Employer Contact | | • Guest User Permission Set | |
| Injured Worker / Legal Representative / Nominated Representative | | • Guest User Permission Set | |

---

## 3. Requirements

### 3.1 Business Requirements

| Process (L3) | Subprocess (L4) | User Story | Acceptance Criteria |
| --- | --- | --- | --- |
| 3.5 Manage Claim Withdrawal | 3.5.1 Withdrawal | **3.5.1.1** As an EO, I want to be able to withdraw an Injury on a case upon the request of the IW | See **AC 3.5.1.1** below |
| 3.5 Manage Claim Withdrawal | 3.5.1 Withdrawal - Freeze KPIs | **3.5.1.2** As an EO, when an Injury is withdrawn, I want the system to place the case in a freeze state to retain the Days KPI | See **AC 3.5.1.2** below |
| 3.5 Manage Claim Withdrawal | 3.5.2 Re-open the Injury | **3.5.2.1** As an EO, I want to be able to re-open a withdrawn Injury upon the request of the IW | See **AC 3.5.2.1** below |
| 3.5 Manage Claim Withdrawal | 3.5.2 Re-open the Injury - Restart KPIs | **3.5.2.2** As an EO, I want the system to restart the Days KPI clock from the date the case was withdrawn when a case is re-opened | See **AC 3.5.2.2** below |
| 3.5 Manage Claim Withdrawal | 3.5.3 All | **3.5.3.1** As an EO, I want to view the decision record for a withdrawn or re-opened decision that I have made | See **AC 3.5.3.1** below |

#### AC 3.5.1.1 — Withdraw an Injury

1. When an IW requests to withdraw a case:
   a. Via email, the system must allow the EO to save the email from the IW in Content Manager.
   b. Via phone call, the system must allow the EO to 'log a call' and automatically create a 'CM Document' record.
2. The system must allow the EO to navigate to the 'Decision' tab on the case.
3. The system must allow the EO to select 'Withdraw Claim'.
4. The system must allow the EO to select at least one or multiple injuries to withdraw from the case.
   a. The system must only display injuries that have not been determined or previously withdrawn.
5. The system must allow the EO to create the decision.
   a. The system must default the 'Decision Status' to 'Withdrawn' and lock the field.
   b. The system must allow the EO to select the 'Decision Reason'.
   c. The system must allow the EO to enter in the 'Document Reference Number' for the record of the withdrawal request from the IW.
   d. The system must default the 'Record Status' to 'Active' and lock the field.
   e. The system must allow the EO to enter in the 'Decision Date'.
      i. The system must not allow the decision date to precede the date of injury.
   f. The system must allow the EO to enter in any additional information in 'Decision Comments'.
   g. The system must allow the EO to select 'save'.
6. Once save has been selected by the EO, the system must:
   a. Create a decision record.
   b. If all injuries on the case are withdrawn the system must:
      i. Automatically send an email to the IW and Employer using a predefined email template confirming that the case has been withdrawn.
      ii. Automatically send an SMS to the IW using a predefined template confirming that the case has been withdrawn.
      iii. Automatically send an email to all members of the case team (eg. MCM) using a predefined email template confirming that the case has been withdrawn.
      iv. Remove the MCM as the claim owner and replace with GB / EML work queue.
      v. Change the case owner from EO and replace with GB / EML work queue to release the EO capacity.
   c. Still provide appropriate users with access (ie. EO/ MCM can still add activities, add evidence etc.).
   d. Update status against the injury on the 'Injury Item' tab on the claim to 'withdrawn'.
   e. Update the status against the claim to 'withdrawn'.

#### AC 3.5.1.2 — Withdrawal: Freeze KPIs

1. When all the injuries on the case have been marked as withdrawn by the EO, the system must place the following case milestones in a freeze state as at the date of withdrawn case:
   a. 'Interim Benefits Days' if within the 0 - 10 day range
   b. 'Business Days Since Lodgement'

#### AC 3.5.2.1 — Re-open the Injury

1. When an IW requests to re-open a withdrawn case:
   a. Via email, the system must allow the EO to create a new 'CM Document' record and upload the email from the IW.
   b. Via phone call, the system must allow the EO to 'log a call' and automatically create a 'CM Document' record.
2. The system must allow the EO to navigate to the 'Decision' tab on the case.
3. The system must allow the EO to select 'Reopen Claim'.
4. The system must allow the EO to select at least one or multiple injuries to Reopen on the case.
   a. The system must only display injuries that have been previously withdrawn.
5. The system must allow the EO to create the decision.
   a. The system must default the 'Decision Status' to 'Pending' and lock the field.
   b. The system must default the 'Decision Reason' to 'New Claim' and lock the field.
   c. The system must allow the EO to enter in the 'Document Reference Number' for the record of the re-open withdrawn request from the IW.
   d. The system must default the 'Record Status' to 'Active' and lock the field.
   e. The system must allow the EO to enter in the 'Decision Date'.
      i. The system must not allow the decision date to precede the date of withdrawal of the injury.
   f. The system must allow the EO to enter in any additional information in 'Decision Comments'.
   g. The system must allow the EO to select 'save'.
6. Once save has been selected by the EO, the system must:
   a. Create a decision record.
   b. Automatically send an email to the IW and Employer using a predefined email template confirming that the case has been reopened.
   c. Automatically send an SMS to the IW using a predefined template confirming that the case has been reopened.
   d. Update status against the injury on the 'Injury Item' tab on the claim to 'Pending'.
   e. Update the status against the claim to 'pending'.
   f. If the claim was withdrawn previously, meaning all injuries were previously withdrawn, the system must place the claim back through the EO allocation tool.
   g. If an MCM is required, the system must allow the EO to reinitiate the assignment again.

#### AC 3.5.2.2 — Re-open the Injury: Restart KPIs

1. When the case has been re-opened by the EO, the system must create a new case milestone to track the following milestones:
   a. 'Interim Benefits Days' if within the 0 - 10 day range
   b. 'Business Days Since Lodgement'
2. Upon creation of the new case milestone, the system must continue the Days clock from the date that the case was withdrawn on the new case milestone.
3. Case is 'frozen' between when the case is withdrawn (1st milestone) and reopened again (2nd milestone) to inform KPIs.

#### AC 3.5.3.1 — View Decision Record

1. The system must allow an EO to select a decision record from the 'Decision' tab on the case.
2. The system must display the following on the 'Decision Record':
   a. **Decision Details**
      i. Decision Name
      ii. Decision type
      iii. Decision Status
      iv. Claim ID
      v. Case
      vi. Created by
      vii. Created On
   b. **Linked Injuries**
      i. Name
      ii. Injury Details
      iii. Description
      iv. Determined Injury Description
      v. Injury Type
      vi. Notified by
      vii. Injury Occurrence Date
   c. **Edit Decision Details**
      i. Decision Date
      ii. Decision Reason
      iii. Record Status
      iv. Document Reference Number
      v. Decision Comments

### 3.2 Data Requirements

#### 3.2.1 Data Model

The final data model diagram for this EPIC will be updated in this section once finalised. The complete data model is linked below:

- Data Model Change - Investigation & Determination Data Model - Enterprise Architecture - RTWSA Confluence

#### 3.2.2 Data Migration

Link to the Data Migration scope items - FY25 Information Gathering & Determination DM Sequence - Enterprise Architecture - RTWSA Confluence

### 3.3 Validation

| Page | Question/Label | Display Logic | Field Type | Mandatory | Picklist Values | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| Withdraw Claim | Select Injury | Predefined list of Injury Items. Must only display an injury item that has not been determined or withdrawn. *(partly obscured in source)* | Checklist | Yes | | Must select at least one Injury Item to continue |
| Withdraw Claim | Create Decision - Decision Status | Default to 'Withdrawn' | Picklist | Yes | Accepted; Incident; Pending; Rejected; Withdrawn; Active | Must default to 'Withdrawn' and be greyed out |
| Withdraw Claim | Create Decision - Decision Reason | | Picklist | Yes | Complete claim details never received; Continuation of previous claim; Duplicate claim; Employer withdraw claim; Entered in error; Worker withdraw claim | |
| Withdraw Claim | Create Decision - Document Reference Number | | Text | No | | |
| Withdraw Claim | Create Decision - Record Status | Default to 'Active' | Picklist | Yes | Active; Awaiting Approval; Cancelled; Superseded | Must default to 'Active' and be greyed out |
| Withdraw Claim | Create Decision - Decision Date | | Date | Yes | | Must not precede date of Injury; Must not be a date in the future |
| Withdraw Claim | Decision Comments | | Text | No | | |
| Reopen Claim | Select Injury | Predefined list of Injury Items. Must only display an injury item that has been withdrawn. | Checklist | Yes | | Must select at least one Injury Item to continue |
| Reopen Claim | Create Decision - Decision Status | Default to 'Pending' | Picklist | Yes | Accepted; Incident; Pending; Rejected; Withdrawn; Active | Must default to 'Pending' and be greyed out |
| Reopen Claim | Create Decision - Decision Reason | Default to 'New Claim' | Picklist | Yes | | Must default to 'New Claim' and be greyed out |
| Reopen Claim | Create Decision - Document Reference Number | | Text | No | | |
| Reopen Claim | Create Decision - Record Status | Default to 'Active' | Picklist | Yes | Active; Awaiting Approval; Cancelled; Superseded | Must default to 'Active' and be greyed out |
| Reopen Claim | Create Decision - Decision Date | | Date | Yes | | Must not precede the date of withdrawal |
| Reopen Claim | Decision Comments | | Text | No | | |

### 3.4 Integration

| User Story | Acceptance Criteria | Integration Details |
| --- | --- | --- |
| 3.5 - Manage claim withdrawal | 3.5.1.1 As an EO, I want to be able to withdraw an Injury on a case upon the request of the IW<br><br>3.5.2.1 As an EO, I want to be able to re-open a withdrawn Injury upon the request of the IW | **Update decision sent to Curam**<br>• Salesforce will use a platform event for a "decision" to be updated in Curam<br>• Integration details captured in more detail here - Determination Decisions - Salesforce to Curam Integration |

### 3.5 Reporting

*Not applicable* - no specific reporting requirements have been identified for Epic E.

---

## 4. Key Design Decisions

| Date | Decision | Decision Outcome | Decision Forum |
| --- | --- | --- | --- |
| *(obscured in source)* | *(obscured in source)* | • The Day KPI milestone will stop when all injuries against a case are withdrawn.<br>• If any of the injuries on the case are re-opened a new Day KPI will be started from the date that the original Day KPI stopped. | Hot House Discussion |
| 05/06/2025 | Automated email when withdrawing a case | An email will only be automatically sent to the IW / Employer / MCM when all injuries on the case have been withdrawn resulting in the withdrawal of the claim | Hot House Discussion |
| 29/04/2025 | Result of withdrawing a case | Once the case is withdrawn:<br>• MCM is removed as the claim owner - replaced with GB / EML work queue.<br>• The case owner will be changed from EO to the GB / EML work queue. This will release the EO capacity.<br>• EO and MCM still need to be part of the case team with read / write access. | Hot House Discussion |
| 29/04/2025 | Result of re-opening a case | Once the case is re-opened:<br>• The case goes back through the EO allocation tool - no rule to go back to the original EO (existing pattern).<br>• For MCM the EO will need to reinitiate the assignment again (existing pattern). | Hot House Discussion |

*Lucid document:* https://lucid.app/lucidchart/bc5da35f-...dit?page=0_0 *(URL partly obscured in source)*

---

## 5. Functionality

*No specific functionality content was present in this section of the source document.*

---

## 6. Test Cases

Test cases for I&D-Product Summary-E, link here: Zephyr Scale - Jira

---

## 7. Solution Design

Link to the Solution design is here.

---

## 8. Change Impact and Training Needs

Change Impacts and Training Needs - I&D Detailed Change Impact Assessment & Stakeholder Analysis (Version 1) - July 2025.xlsx

---

## 9. Links

| Title | Description |
| --- | --- |
| I&D - Summary Hot House - RTWSA Digital Transformation - RTWSA Confluence | Contains all design notes from initial Hot House I&D design conversations |
| CM Mapping_Investigation and Determination .xlsx | Contains all Content Manager mapping for I&D |
| I&D Integrations.xlsx | Contains all Integration details for I&D |
| I&D - Email and SMS Content.xlsx | Contains the Content Manager mapping and the email + sms templates for I&D |

---

## 10. Document Governance

*(Section header and table partly obscured in source by an on-screen popup.)* The visible note indicates the relevant approvers will sign off the Product Summary a week before UAT finishes. Governance table columns include: *Approver / Role*, *Date approved*, *Confirmation*.

---

## 11. Document History

| Version No. | Updated date | Updated by | Changes made | Reason (incl Jira ticket if applicable) |
| --- | --- | --- | --- | --- |
| 1.1 | 24/06/2025 | Veronica Gemma | **Terminology Updates**<br>1. Removed reference to evidence as evidence will not be referred to for claim withdrawal and re-open<br>2. Updated 'comments' to 'decision comments' as per build | |
| 1.2 | 26/06/2025 | Veronica Gemma | Removed Epic reference out of title<br>Added information panel at bottom to reference epics | Formatting |
| 1.3 | 09/07/2025 | Veronica Gemma | Updated:<br>• User Story 3.5.1.1 - Acceptance Criteria 1 — noted that a CM record will be created either manually to save Email or Automatically when logging a call<br>• User Story 3.5.1.1 - Acceptance Criteria 5.c. — noted that Document Reference number will be used to enter in the CM record mentioned in 3.5.1.1 Acceptance Criteria 1<br>• User Story 3.5.2.1 - Acceptance Criteria 1. — noted that a CM record will be created either manually to save Email or Automatically when logging a call<br>• User Story 3.5.2.1 - Acceptance Criteria 5.c. — noted that Document Reference number will be used to enter in the CM record mentioned in 3.5.2.1 Acceptance Criteria 1 | Jira - S2C - 5903<br>Jira - S2C - 5908 |
| 1.4 | 31/07/2025 | Veronica Gemma | Updated Validation to state Create Decision - Decision Date Must not be a date in the future | Jira - S2C - 6164 |
| 1.5 | 16/06/2025 | Veronica Gemma | Updated User Story 3.5.1.1 - Acceptance Criteria 1<br>• noted that the User will save the email in Content Manager | Jira - S2C - 6740 |

> 📑 Product Summary E - Obtain Evidence formerly referenced Epic 3.5
