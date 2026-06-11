# Discover Benefits, Programs, Assignments, and Disbursements

**Module:** Benefit Management Data Model in Public Sector Solutions · Unit · ~5 mins
**Source:** [Trailhead unit](https://trailhead.salesforce.com/content/learn/modules/benefit-management-data-model-in-public-sector-solutions/discover-benefits-programs-assignments-and-disbursements)

> Study notes captured from the Trailhead unit (Cosville / caseworker Connor running example).
> Diagrams below are the unit's own images, linked from Salesforce's CDN.

## Learning objectives

After completing this unit, you'll be able to:

- Review the purpose of **benefit** and **program** objects.
- Explain how **benefit assignment** and **disbursement** objects work.

## Benefits and programs

These are the Public Sector objects that represent the forms of assistance an agency provides:

- **Benefit** — a specific form of financial or non-financial assistance a government/public
  organisation provides to a constituent.
- **Benefit Type** — a record that categorises a set of related benefits.
- **Program** — stores a collection of benefits. Enrolling a constituent into a program gives them
  all the associated benefits.

The same benefit/program objects used for social-service aid (counselling, transport, meal delivery)
are used in **Benefit Management** to control the *financial* aspects of assistance. On the benefit
record you define the associated program, enrolment count, benefit manager, minimum/maximum benefit
amounts, and other data.

You configure programs and benefits during initial setup (or when new assistance becomes available),
then tailor prescreening forms, applications, and review processes to each program/benefit.

![LIHEAP benefit record](https://res.cloudinary.com/hy4kyit2a/f_auto/fl_lossy/q_70/learn/modules/benefit-management-data-model-in-public-sector-solutions/discover-benefits-programs-assignments-and-disbursements/images/e523ed62566b0237128e1374e0dcb8c1_kix.7c2m8mq3x3iz.png)

*Example: a benefit record for the LIHEAP benefit.*

## Benefit assignment and disbursement

After a constituent applies for a benefit and the caseworker approves financial assistance, the
benefit is assigned and distributed.

- **Benefit Assignment** — connects a benefit to an approved application and holds the approved
  payment information. Set the total benefit amount the constituent is eligible for, and the amount
  and frequency of each transaction. View amount already allocated, amount remaining to disburse,
  and a preview of upcoming disbursements. Manage duration with start/end dates and schedule the
  next payout date.
- **Benefit Assignment Adjustment** — lets you change a benefit assignment; represents a monetary or
  non-monetary adjustment made to an enrollee, disbursable at various frequencies.
- **Benefit Disbursement** — holds information about an individual payment to the constituent.
- **Benefit Disbursement Adjustment** — created when you need to modify or correct the amount of a
  disbursement based on new information from the constituent.

**Automatic disbursements:** instead of setting up each payment manually, you can configure a flow
that auto-creates disbursements from the payment + schedule info on the benefit assignment. *Example:*
a monthly payment of $1,200 set to disburse over a year → the flow creates a $100 disbursement record
each month for the schedule's duration. Constituents view the schedule and amounts in their
self-service portal.

### Object relationships and examples

| Object | Is related to | Details / example |
|--------|---------------|-------------------|
| **Benefit** | Individual Application, Program, Benefit Type, Benefit Assignment, Unit of Measure | A *Monthly Energy Assistance* benefit gives monetary help with heating/cooling bills. |
| **Benefit Type** | Benefit | An *Energy* benefit type categorises all energy-related benefits in the org. |
| **Unit of Measure** | Benefit, Benefit Assignment, Benefit Disbursement | The LIHEAP benefit uses currency as its unit of measure. |
| **Program** | Benefit | The LIHEAP program includes Monthly Energy Assistance and other energy benefits. |
| **Program Enrollment** | Program, Benefit Assignment, Benefit Disbursement, Account, Contact | Connor (caseworker) enrols Jo in the energy assistance program. |
| **Benefit Assignment** | Account, Benefit, Benefit Assignment Adjustment, Benefit Disbursement, Individual Application, Claim | Connor assigns the Monthly Energy Assistance benefit to Jo. |
| **Benefit Assignment Adjustment** | Benefit Assignment, Benefit Disbursement Adjustment | Jo's income decreased, so Connor adjusts the assignment for a greater benefit amount. |
| **Benefit Disbursement** | Account, Benefit Assignment, Benefit Disbursement Adjustment | A disbursement record tracks each payment made to Jo. |
| **Benefit Disbursement Adjustment** | Benefit Disbursement, Benefit Assignment Adjustment | Connor reviews Jo's documents, finds she qualifies for more, and corrects the amount. |

![Diagram of benefit and program objects in the Benefit Management data model](https://res.cloudinary.com/hy4kyit2a/f_auto/fl_lossy/q_70/learn/modules/benefit-management-data-model-in-public-sector-solutions/discover-benefits-programs-assignments-and-disbursements/images/e76d14c66af1e1348386c890e3a4923f_kix.zahlotf2alh6.png)

*Data-model objects related to benefits and programs.*

![Benefit Management Data Model diagram](https://res.cloudinary.com/hy4kyit2a/f_auto/fl_lossy/q_70/learn/modules/benefit-management-data-model-in-public-sector-solutions/discover-benefits-programs-assignments-and-disbursements/images/0c3774ecfedfd3b9e73b35b3de74c2af_kix.kxc714vy9751.png)

*The full Benefit Management data model.*

## Wrap-up

Across the module, benefit, program, assignment, and disbursement objects work together to give
constituents in **Cosville** an intuitive, transparent benefit application experience. Caseworkers
like **Connor** can evaluate each constituent's circumstances and roll out resources efficiently.

## Resources

- Salesforce Help — *Assign and Disburse Benefits to Eligible Applicants*
- Salesforce Help — *Process Benefit Assignment Adjustment Applications by Using a Guided Flow*
