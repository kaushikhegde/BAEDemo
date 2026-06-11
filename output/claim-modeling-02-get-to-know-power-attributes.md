# Unit 2 — Get to Know Power Attributes

**Module:** Claims Modeling for Insurance · ~10 mins
**Source:** [Trailhead unit](https://trailhead.salesforce.com/content/learn/modules/claim-modeling-for-insurance/get-to-know-power-attributes)

## Learning objectives

1. Describe how power attributes enforce policy terms and conditions within the claims process.
2. Explain how to create both standard and power attributes.
3. Outline the configuration requirements for power attributes.
4. Trace a power attribute's lifecycle from creation through claims processing.

## What are power attributes?

Power attributes are specialised attributes that carry **additional metadata** beyond a standard
attribute. They track policy terms from the product model → policy record → claim, and let the
claims management system **enforce** policy terms such as:

- **Limits** — maximum coverage amounts
- **Deductibles** — amounts the policyholder pays before coverage applies
- **Copays** — fixed out-of-pocket amounts
- **Coinsurance** — percentage-based cost sharing

A standard attribute holds only a basic field definition; a power attribute adds the metadata that
governs how it behaves in claims.

## Creating power attributes

- Defined in the **Attributes Designer** (the same tool used for standard attributes).
- You can create a power attribute from scratch, or convert an existing standard attribute by
  adding power-attribute definitions.

| Standard attribute fields | Power attribute adds |
|---------------------------|----------------------|
| Name | **Attribute Class** (the primary extra field) |
| Code | Additional metadata fields that determine enforcement behaviour |
| Display Sequence | |

## Worked configuration — Building / Dwelling Limit

Justus creates a **Building Limit** attribute on Cumulus's homeowners product as a power attribute:

| Element | Setting | Purpose |
|---------|---------|---------|
| Attribute Class | Limit — Currency | Defines it as a monetary limit |
| Attribute Scope | Claim Coverage | Applies it at the claim-coverage level |
| Applicable Actions | Specified (enabled) | Which claim actions trigger tracking |
| Applicable Item & Value Type | Specified | What items and value formats apply |
| Benefit Type | Not specified | Not needed for this example |
| Duration Type | Not selected | Claim/coverage-scope attributes auto-span a single claim duration |

**Placement:** add the attribute to the dwelling coverage spec, and include it on the root product
along with its parent coverage.

**Visual cue:** a ⚡ lightning icon appears next to a power attribute's name; hovering shows its
class, scope, and applicable item.

**Naming:** the attribute name is what adjusters see in the **Policy Term Standings** chart. It
defaults to the code name but can be customised — Justus renamed "Building Limit" → "Dwelling Limit"
to match coverage terminology.

### Where you model it changes its scope

| Placement | Effect |
|-----------|--------|
| Claim/Policy scope on **root product** | One policy term enforces across **all** coverages, wherever the claim financials sit |
| Claim/Policy scope on a **coverage spec** | One policy term enforces only within that specific coverage spec |
| Coverage-level scopes | Always model **claim coverage** and **policy coverage** scopes on the coverage specs themselves |

## Lifecycle of a power attribute

### Phase 1 — Policy creation

Policyholder **Sophia Fournier** buys a homeowners policy and selects a building limit of
**$1,500,000**. During `createUpdatePolicy`, the platform automatically creates an **Insurance
Policy Term** record for each power attribute.

| Insurance Policy Term holds | Details |
|-----------------------------|---------|
| Related records | Insurance Policy, Insurance Policy Coverage, Insured Policy Asset |
| Initial amount | $1,500,000.00 |
| Power attribute details | Class (Limit), scope (Claim Coverage), enabled actions |

This record gives the platform the framework to track consumption against the initial amount.

### Phase 2 — First claim & payment

Sophia files a storm-damage claim:

- Loss item: roof damage · claimed **$25,000**
- Claim-level deductible: **$1,000** → approved & paid **$24,000**

On payment, the system creates an **Insurance Policy Terms Tracking Entry**:

| Element | Value |
|---------|-------|
| Initial amount | $1,500,000.00 |
| Posted amount | $24,000 |
| Remaining amount | $1,476,000.00 |

**Policy Terms Standing chart:** Used $24,000 · Remaining $1,476,000 · Pending = remaining loss
reserves (unpaid claim coverage payment details).

### Phase 3 — Second payment (same incident)

The same storm caused foundation damage (**$18,000**), added to the same claim:

| Element | Value |
|---------|-------|
| Initial amount | $1,476,000.00 (remaining from previous entry) |
| Posted amount | $18,000 |
| Remaining amount | $1,458,000.00 |

**Chart now:** Used $42,000 (cumulative) · Pending $0 · Remaining $1,458,000.

Each new payment creates a tracking entry that references the **previous remaining amount**,
keeping a running balance.

## Key takeaways

1. **Not every attribute is a power attribute** — reserve them for product/coverage terms relevant
   to claims processing.
2. Power attributes maintain the structural link between policy terms and claim-payment maths.
3. The extra metadata fields determine how the system tracks and enforces requirements.
4. **Insurance Policy Term** and **Tracking Entry** records are created automatically.
5. Payments use a **progressive calculation** — each entry chains off the prior remaining amount.
6. Dual-record structure: policy-term record stores config; tracking-entry records hold the
   transaction history and running balances.
7. **Location determines scope** — root product vs coverage spec decides whether a term enforces
   across all coverages or just one.

**Reference:** Salesforce Help — *Create Power Attributes*.
