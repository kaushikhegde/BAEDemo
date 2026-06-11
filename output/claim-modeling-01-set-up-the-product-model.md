# Unit 1 — Set Up the Product Model

**Module:** Claims Modeling for Insurance · ~5 mins
**Source:** [Trailhead unit](https://trailhead.salesforce.com/content/learn/modules/claim-modeling-for-insurance/set-up-the-product-model)

## Learning objectives

1. Illustrate how a claim connects to the product model and the claim model.
2. Clarify the significance of root products and child specs in claims handling.
3. Demonstrate the connection between attributes and prospective claims.

## Why the product model matters for claims

A claim owes much of its structure and data to a **policy record**, which holds the vital details
of *what* is covered, *who* is covered, and *to what extent*. The product model is the foundation
that defines the possible structure of that policy.

```
Product Model → Policy Record → Claim Model → Complete Claim Structure
```

The product model defines the *possible* structure of the policy; the claim model adds the
claim-specific layers on top.

## The homeowners product model: root product + child specs

A **root product** sits at the top and connects to four **child specs**:

| Name | Spec type | Description |
|------|-----------|-------------|
| Homeowners | Root Product | Parent of all other specs; holds policy terms that apply across all coverages |
| Dwelling | Coverage | Coverage terms for damage to the home |
| Personal Property | Coverage | Coverage terms for loss/damage to personal property |
| Insured Property | Insured Item | Information about the insured home |
| Owner | Insured Party | Information about the property owner |

## Attributes

Attributes are the components that define each spec. They can be added to root products,
coverages, insured items, and insured parties.

| Spec category | What its attributes define |
|---------------|----------------------------|
| Root product | Terms that apply across the **entire** policy |
| Coverage | Terms specific to a **particular** coverage |
| Insured item | Facts about the covered item |
| Insured party | Facts about the covered individual |

### Attributes in the homeowners model

| Name | On spec (type) | Meaning |
|------|----------------|---------|
| Deductible | Homeowners (Root Product) | Amount the policyholder pays before the insurer covers a claim; applies to all coverages |
| Dwelling Limit | Dwelling (Coverage) | Maximum reimbursement for dwelling claims |
| Personal Property Limit | Personal Property (Coverage) | Maximum reimbursement for personal-property claims |
| Sub-limits (Furs, Jewelry, Guns) | Personal Property (Coverage) | Maximum reimbursement for specific property types |
| General property facts | Insured Property (Insured Item) | Facts about the property; may support rating but aren't essential to claims |
| Party information | Owner (Insured Party) | Facts about the insured party; not essential to claims |

### Critical distinction — where claim-time facts live

> Facts only known **at the time of claim** belong to the **claim property spec**, not the insured
> item. For example, specific damage details are captured on the claim property spec rather than
> as insured-item attributes.

## Case study — Cumulus Insurance

- **Organisation:** Cumulus Insurance — large, diversified insurer (auto, business, homeowners).
- **Status:** Recently adopted the Digital Insurance Platform to modernise legacy systems.
- **Goal:** Design an upgraded claims solution to replace legacy claims systems.
- **Persona:** Justus Pardo, solution architect specialising in the Digital Insurance Platform.

## Advanced consideration — multi-instance policies

Product models support complex scenarios with multiple insured parties and items. A standard auto
product model, for example, supports multiple drivers (insured parties) and automobiles (insured
items), with each driver associated with a different car.

## Key takeaways

1. Product modelling is the structural foundation for claims processing.
2. The hierarchy of root product + child specs determines how the policy is organised.
3. Attributes define specific policy terms and coverage limits.
4. Root-product attributes apply universally; coverage attributes apply to specific coverages.
5. Claim-specific information belongs in claim specs, **not** in product-model attributes.
6. The product model must be designed to support eventual claim evaluation and processing.

**Prerequisite:** Insurance Claims Foundations (Trailhead module).
