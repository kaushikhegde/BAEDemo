# RTWSA Claim Transformation Program (CTP)
## Business Requirements Gathering Session – Whole Person Impairment (WPI)
### Simulated Meeting Transcript

---

**Date:** Wednesday, 10 June 2026
**Location:** ReturnToWorkSA – 400 King William Street, Adelaide SA 5000 (Hybrid)
**Session Focus:** Whole Person Impairment (WPI) Assessment – Current State, Pain Points & Future State Requirements
**Meeting Type:** Business Requirements Gathering (BRG) – Sprint 2, Session 4

---

### Attendees

| Name | Role | Organisation |
|---|---|---|
| **Sarah Mitchell** | Program Manager – CTP | ReturnToWorkSA (RTWSA) |
| **David Nguyen** | Business Analyst (Lead) | CTP Delivery Partner |
| **Karen O'Brien** | WPI Assessment Manager | ReturnToWorkSA |
| **Dr. James Patel** | Accredited WPI Assessor (SME) | External – Medical Practice |
| **Linda Frost** | Claims Agent Representative | EML (Claims Agent) |
| **Tom Hartley** | ICT Solutions Architect | ReturnToWorkSA |
| **Priya Sharma** | Business Analyst (Supporting) | CTP Delivery Partner |
| **Marcus Webb** | Self-Insured Employer Representative | SA Water |
| **Rachel Donovan** | Legal & Compliance Advisor | ReturnToWorkSA |

---

### Agenda

1. Welcome & housekeeping
2. Recap of previous session
3. WPI process overview – current state walkthrough
4. Pain points and issues – open discussion
5. Online Services referral model – requirements deep dive
6. Accreditation scheme integration requirements
7. Data and reporting requirements
8. Quality management and compliance considerations
9. Wrap-up, action items, next steps

---

## Transcript

---

**Sarah Mitchell (Program Manager):** Good morning, everyone. Let's get started – we've got a full agenda today. For those joining remotely, please keep your mics muted unless you're speaking. Today's session is being recorded for transcript purposes only and will not be shared externally. Before we dive in, David, can you do a quick recap of where we left off last week?

**David Nguyen (BA Lead):** Thanks, Sarah. In our last session we covered the claims intake and initial registration processes. We captured a number of pain points around manual referral creation and data duplication between legacy systems. Today we're moving into WPI – Whole Person Impairment assessments – which is a critical downstream component of the claims lifecycle, particularly for statutory lump sum entitlements and serious injury determinations. I'll be referring to two key RTWSA reference documents throughout today's session:

- The RTWSA WPI Online Services page: [https://www.rtwsa.com/service-providers/assessment-services/impairment-assessment/whole-person-impairment-assessment](https://www.rtwsa.com/service-providers/assessment-services/impairment-assessment/whole-person-impairment-assessment)
- The Impairment Assessor Accreditation Scheme (IAAS) document (July 2025): [https://www.rtwsa.com/media/documents/Impairment-Assessor-Accreditation-Scheme_web.pdf](https://www.rtwsa.com/media/documents/Impairment-Assessor-Accreditation-Scheme_web.pdf)

Priya has also pre-read these and will be capturing requirements in Confluence as we go. Karen, would you like to kick us off with the current state overview?

---

**Karen O'Brien (WPI Assessment Manager):** Absolutely. So the WPI assessment process is governed by Section 22 of the Return to Work Act 2014. At its core, a WPI assessment determines the degree of permanent impairment arising from a work injury. The result feeds directly into entitlement decisions – statutory lump sum payments and, at the higher end of impairment, serious injury support.

The assessment is conducted by an accredited medical practitioner – an Assessor – who holds accreditation issued by the Minister. The accreditation is governed entirely by the IAAS. Each Assessor must be registered with AHPRA, have at least five years of post-graduate experience in a relevant specialty, and be accredited in one or more specific body systems. All of that is outlined in the IAAS document.

**David Nguyen:** Karen, for the benefit of the group – can you quickly outline the body systems that assessors can be accredited in?

**Karen O'Brien:** Sure. The body systems fall into two categories. Mandatory AMA5 body systems – where AMA5 training is compulsory – include Upper Extremity, Lower Extremity, and Spine. The non-mandatory systems include things like Nervous System, Cardiovascular, Respiratory, Visual, Psychiatric, Skin, Digestive, ENT, Hearing, Urinary and Reproductive, Haematopoietic, and Endocrine. Psychiatric assessments use GEPIC rather than AMA5, and the Visual system uses AMA4.

There's also the Criteria Table in the IAAS that specifies which specialties can assess which body systems. For example, only certain specialists – Orthopaedic Surgeons, Pain Specialists, Rheumatologists, Plastic Surgeons, Occupational Physicians, and Rehabilitation Physicians – can assess Complex Regional Pain Syndrome (CRPS), and only after they've completed specific CRPS training.

**Dr. James Patel (WPI Assessor – SME):** I can add some colour to that. As a practising assessor accredited in Upper Extremity and Spine, the system has worked reasonably well, but the transition to Online Services has been the biggest change recently. Referrals now come through the Online Services portal rather than email. For me as a provider, the main benefit is that I can receive and submit documents securely, and I have better visibility of each referral and the worker's claim details – all in one place.

**David Nguyen:** That's really useful, James. Let's hold the Online Services discussion for agenda item five. Linda, from the claims agent perspective, how does a WPI referral typically get initiated?

---

**Linda Frost (Claims Agent – EML):** The referral process kicks off once a decision is made that the worker's injury is likely to result in permanent impairment. We initiate the referral through Online Services now – for both WPI and IME assessments. The worker needs to agree to commence the process first. After that, there's a consultation process around selecting an Assessor, drafting the request letter, and booking the appointment.

One of the key things the IAAS specifies is around timeframes. The Assessor is required to see the worker within six weeks of the appointment being requested. And once the assessment is complete, the Impairment Assessment Report must be submitted within ten business days. Those timeframes are a service requirement under the IAAS, and they flow directly into our SLA monitoring.

**David Nguyen:** So from a system perspective, we need to be tracking those timeframes. Priya, can you log that as a requirement? – the system needs to flag when an appointment has been requested and start a six-week countdown, and then when the assessment is complete, a ten-business-day countdown for report submission.

**Priya Sharma (BA – Supporting):** Noted. I'll map that to a notification and escalation rule in our requirements matrix. Should that trigger an alert to the claims agent as well as the assessor?

**Linda Frost:** Yes, and ideally to the RTWSA team as well so they can monitor. Currently we're managing that manually with spreadsheets, which is a significant pain point.

---

**Sarah Mitchell:** That's a great segue. Let's spend a few minutes on pain points before we go deeper into Online Services. What are the top issues you're experiencing today?

**Karen O'Brien:** I'll start. The biggest one is accreditation status visibility. We maintain the Whole Person Impairment Assessors List on the website, but when a claims agent is making a referral, they don't have a live, real-time view of whether an assessor is still accredited, which body systems they're accredited in, and whether they've met their ongoing training and declaration requirements. Accreditations run for five years, and Assessors are required to submit an annual declaration confirming things like AHPRA currency, insurance levels, and training compliance. If that's not tracked in a system, it falls through the cracks.

**Rachel Donovan (Legal & Compliance):** I can add to that. There are a number of mandatory notification obligations on Assessors. They must notify us within seven business days if their AHPRA registration has a condition, notation, or reprimand added. They must also notify within seven business days if they're charged with a criminal offence involving dishonesty, or if they're subject to a formal AHPRA investigation. Currently those notifications come in ad hoc by email, and there's no systematic tracking. In a transformed claims environment, we'd want those to trigger automated compliance alerts and potentially flag the assessor as unavailable for new referrals pending review.

**Tom Hartley (ICT Solutions Architect):** Rachel, is the expectation that the new system would integrate with AHPRA, or that assessors self-report and the system records and tracks the declarations?

**Rachel Donovan:** At this stage, it would be self-reporting with system-enforced declaration workflows. An AHPRA API integration would be aspirational and potentially a Phase 2 item. For now, we need the system to enforce declaration submission and flag overdue declarations.

**David Nguyen:** Good. So we have a clear requirement: the system needs to manage Assessor accreditation records including accreditation period, body system scope, annual declaration workflow, insurance thresholds, and mandatory notification tracking.

---

**Dr. James Patel:** Can I raise something from the assessor experience side? One of the challenges is conflict of interest declaration. The IAAS is quite specific about this – before taking on a referral, I need to consider personal, professional, and pecuniary conflicts. Currently I declare those by email. There's no structured form or system capture. A structured conflict of interest declaration workflow built into the referral acceptance step would be a significant improvement.

**David Nguyen:** That's a great requirement, James. When a referral is received, the assessor should be prompted to complete a structured conflict of interest declaration before accepting the referral. The requestor should then be able to review that declaration and make a decision about whether to proceed.

**Priya Sharma:** Should the system also prevent an assessor from accepting a referral if they've previously treated the worker?

**Karen O'Brien:** The IAAS actually addresses that – assessors must not provide or have provided any form of treatment, advice or assessment in relation to the worker, unless the Requestor agrees. So yes, the system should prompt for that check and flag it for the claims agent to explicitly acknowledge and approve.

---

**David Nguyen:** Let's move to agenda item five – the Online Services referral model. Tom, can you walk us through the current architecture?

**Tom Hartley:** Sure. RTWSA's Online Services portal is the current mechanism for referrals. Medico-legal providers – including WPI assessors – log in to the portal and see a WPI/IME referrals tile on their home page. They can manage all referrals and documentation in one place. The notification system is preference-based – assessors can direct referral notifications to an email address, and multiple practice users can direct notifications to a central email if needed.

The current Online Services platform has been progressively adopted, and the guidance on the RTWSA website walks providers through how to set it up. For the CTP, the question is whether we're building on top of that portal, replacing it, or integrating with it.

**Sarah Mitchell:** The current scope for CTP is integration and enhancement. We're not replacing the portal. What we need to understand today is what business capabilities and requirements the system needs to support, so that the architecture team can determine how to configure or extend the portal.

**Tom Hartley:** In that case, the key capability gaps I've noted so far are: structured conflict of interest capture, real-time accreditation status, automated SLA tracking, and report compliance monitoring.

---

**David Nguyen:** Let's talk about the assessment report itself. Karen, once a report is submitted, what happens on the RTWSA or claims agent side?

**Karen O'Brien:** The report goes through a Technical Compliance Review. ReturnToWorkSA – or a self-insured employer where relevant – reviews the Impairment Assessment Report to ensure correct calculations, identify typographical errors, and verify consistent application of the Act, the Guidelines, the relevant AMA Guides, and any applicable case law. If clarification is needed, the assessor is given ten business days to respond.

One important process point: before the clarification request goes to the assessor, the worker or their representative is provided a copy of the matters requiring clarification. This allows them to contribute and raise additional matters. That's a transparency requirement in the IAAS and it's quite specific.

**David Nguyen:** So from a workflow perspective, the system needs to support: report submission by assessor → compliance review by requestor → worker notification of clarification matters → assessor clarification request → assessor response → final determination. That's a multi-party workflow with defined timeframes at each step.

**Marcus Webb (SA Water – Self-Insured):** From the self-insured perspective, I just want to confirm – for workers under our self-insurance arrangement, we're the Requestor. So the technical compliance review sits with us, not RTWSA. The system needs to support that routing logic.

**Tom Hartley:** That's a key data design requirement – the compensating authority field on a claim determines the routing of the compliance review workflow.

**Priya Sharma:** I'll log that. Routing logic: if the compensating authority is RTWSA or a claims agent, the compliance review routes to RTWSA's Impairment Assessment team. If the compensating authority is a self-insured employer, the review routes to that employer.

---

**David Nguyen:** Let's shift to quality management requirements. Karen, can you summarise the IAAS quality support model?

**Karen O'Brien:** The IAAS has a layered support model. There's Pending Assessment Report Support, which is available to assessors before they submit a report – essentially, if they have a question on medical reasoning, they can go to a Peer Support Assessor. That's a specialist accredited in the same body system. Then there's the General Assessment Peer Support, which kicks in at certain thresholds – it can be requested voluntarily by the assessor, or it's triggered automatically based on the percentage of completed assessments per year, or following repeated non-compliance issues.

And then there's the formal Technical Compliance Review I just described. If an assessor's compliance rating average falls below 80% at first review annually, additional support is mandated.

**David Nguyen:** For the transformation, what are the system requirements that flow from that model?

**Karen O'Brien:** We need the system to calculate and display a compliance rating per assessor. It needs to track the number of reports reviewed and the percentage compliant at first review. It should flag when an assessor drops below the 80% threshold and trigger the peer support process. And it needs to record peer support interactions and outcomes.

**Tom Hartley:** That's effectively an assessor performance dashboard. We'd also want that feeding into the accreditation decision-making process – for example, if the Minister is considering suspension or cancellation of an accreditation, the performance data should be readily accessible.

---

**Rachel Donovan:** Can I raise the complaint management requirements? The IAAS has a formal complaint process. Workers, employers, and their representatives can lodge complaints against an assessor if they believe Service Standards haven't been met. Those complaints are managed in accordance with the Act and the RTWSA Complaints Policy. If a complaint warrants referral to AHPRA or another healthcare complaints body, the IAAS authorises that disclosure under Section 185(3)(j) of the Act.

From a system standpoint, we need complaint logging against an assessor record, status tracking through the complaints lifecycle, and the ability to flag outcomes that may trigger performance management or accreditation review.

**David Nguyen:** Noted. And from a reporting perspective – the IAAS states that RTWSA will publish reporting on its monitoring of the IAAS on the website at least annually. The system should be able to generate that data in a structured way.

---

**Sarah Mitchell:** We're coming up on time. Let me check – are there any requirements we haven't captured that people want to flag before we close?

**Dr. James Patel:** One thing that's important for me as an assessor – the requirement to appear before the South Australian Employment Tribunal (SAET) if requested. If I receive a SAET summons, the IAAS requires me to attend at the requested date and time. Currently there's no system flag for that. It would be helpful if SAET-related notifications were captured in the portal so there's a documented record.

**David Nguyen:** Great point. So the system should support SAET appearance requests being recorded against an assessment, with notifications to the relevant assessor.

**Linda Frost:** One more from me. We talked about notifications earlier. The guidance from RTWSA says that providers should set notification preferences so that referral alerts go to the right email address, and multiple practice users can use a central email. In a large practice, managing that is administratively complex. A future state requirement would be notification management at the practice level, not just the individual provider level.

**Tom Hartley:** That's more of an Online Services platform configuration requirement. I'll take that back to the platform team.

**Marcus Webb:** For self-insured employers, we're not currently using the Online Services portal for WPI referrals – the IAAS does note that the portal requirement is not applicable for workers with claims managed by self-insured employers. We want to understand what the CTP's position is on that. Will we remain out of scope for the portal, or is there a target state where self-insurers are onboarded?

**Sarah Mitchell:** That's a question for the program scope team. I'll put it on the parking lot for now and come back to Marcus directly after the program steering committee meeting next week.

---

## Summary of Key Requirements Captured

| # | Requirement | Category | Priority |
|---|---|---|---|
| REQ-WPI-001 | System tracks six-week appointment SLA from referral request date | SLA / Workflow | High |
| REQ-WPI-002 | System tracks ten-business-day report submission SLA from assessment completion | SLA / Workflow | High |
| REQ-WPI-003 | Automated alerts to claims agent, assessor, and RTWSA on SLA breach | Notifications | High |
| REQ-WPI-004 | Structured conflict of interest declaration workflow at referral acceptance step | Compliance | High |
| REQ-WPI-005 | System flags prior treatment relationship between assessor and worker | Compliance | High |
| REQ-WPI-006 | Assessor accreditation record management (period, body systems, status) | Accreditation | High |
| REQ-WPI-007 | Annual declaration workflow with automated overdue flagging | Accreditation | High |
| REQ-WPI-008 | Mandatory notification tracking (AHPRA, criminal offences) within 7 business days | Compliance | High |
| REQ-WPI-009 | Multi-party technical compliance review workflow with worker notification step | Workflow | High |
| REQ-WPI-010 | Routing logic: compliance review to RTWSA vs self-insured based on compensating authority | Data / Routing | High |
| REQ-WPI-011 | Assessor compliance rating dashboard (reports reviewed, % compliant at first review) | Reporting | Medium |
| REQ-WPI-012 | Automated peer support trigger when assessor compliance drops below 80% | Quality Mgmt | Medium |
| REQ-WPI-013 | Complaint logging against assessor record with lifecycle status tracking | Complaints | Medium |
| REQ-WPI-014 | RTWSA annual IAAS monitoring report data generation | Reporting | Medium |
| REQ-WPI-015 | SAET appearance request capture and notification to assessor | Legal / Workflow | Medium |
| REQ-WPI-016 | Practice-level notification preference management (not just individual) | Platform Config | Low |
| REQ-WPI-017 | [PARKING LOT] Self-insured employer portal onboarding scope decision | Scope | TBC |

---

## Action Items

| # | Action | Owner | Due |
|---|---|---|---|
| AI-01 | Publish draft requirements to Confluence for stakeholder review | Priya Sharma | 17 June 2026 |
| AI-02 | Confirm scope position on self-insured employer portal onboarding | Sarah Mitchell | Post-Steering Committee, 24 June 2026 |
| AI-03 | Architecture spike: accreditation record data model and AHPRA integration options | Tom Hartley | 24 June 2026 |
| AI-04 | Provide process map for Technical Compliance Review workflow for sign-off | Karen O'Brien | 17 June 2026 |
| AI-05 | Provide example conflict of interest declaration scenarios for form design | Dr. James Patel | 17 June 2026 |
| AI-06 | Share current complaint management SOP for requirements mapping | Rachel Donovan | 17 June 2026 |
| AI-07 | Confirm SLA parameters for self-insured employers vs RTWSA-managed claims | Marcus Webb / Karen O'Brien | 24 June 2026 |

---

## Next Session

**Topic:** WPI Assessment – Data Migration, Assessor Onboarding & Report Template Requirements
**Date:** Wednesday, 17 June 2026 – 10:00 AM–12:00 PM
**Location:** TBC (Hybrid)

---

## Reference Documents

| Document | URL |
|---|---|
| RTWSA – Online Services for WPI Assessment Referrals | [https://www.rtwsa.com/service-providers/assessment-services/impairment-assessment/whole-person-impairment-assessment](https://www.rtwsa.com/service-providers/assessment-services/impairment-assessment/whole-person-impairment-assessment) |
| RTWSA – Impairment Assessor Accreditation Scheme (IAAS) July 2025 | [https://www.rtwsa.com/media/documents/Impairment-Assessor-Accreditation-Scheme_web.pdf](https://www.rtwsa.com/media/documents/Impairment-Assessor-Accreditation-Scheme_web.pdf) |
| RTWSA – Whole Person Impairment Assessors List | [https://www.rtwsa.com/service-providers/assessment-services/impairment-assessment/wpi-assessors-list](https://www.rtwsa.com/service-providers/assessment-services/impairment-assessment/wpi-assessors-list) |
| Return to Work Act 2014 – Section 22 | SA Legislation |

---

*This is a simulated meeting transcript prepared for the RTWSA Claim Transformation Program (CTP) Business Requirements Gathering process. All attendee names are fictional. Requirements are based on publicly available RTWSA documentation.*

---
*Document prepared: 10 June 2026 | Version: 1.0 | Status: Draft*
