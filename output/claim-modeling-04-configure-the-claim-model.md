# Unit 4 — Configure the Claim Model

**Module:** Claims Modeling for Insurance · ~5 mins
**Source:** [Trailhead unit](https://trailhead.salesforce.com/content/learn/modules/claim-modeling-for-insurance/configure-the-claim-model)

## Learning objectives

1. State the purpose of a claim model.
2. Explain the key components of a claim model.
3. Add attributes to claim injury and claim property specs.

## Purpose of a claim model

A **claim model describes a claim that an insurance policyholder can file** against an insurance
policy. It works together with the policy records generated from product models.

Together, the claim model + policy record define the structure of the **input JSON** that feeds the
`InsClaimService:createUpdateClaim` service, which creates and modifies claims.

```
Product Model ─┐
               ├─► JSON input ─► InsClaimService:createUpdateClaim ─► Claim
Claim Model  ──┘
```

## Claim model architecture — three main components

### 1. Claim Product Spec
- The foundational element (analogous to the root product in the product model).
- Acts as the container that other claim specs are added to.
- Houses **rules** that automate claim processing — e.g. conditions for automatically opening claim
  coverages.
- Typically holds **no attributes** itself; its rules reference attributes on the other specs.

### 2. Claim Injury Spec
- Defines injuries sustained by individuals on the claim.
- Captures information specific to injured parties only (participants may be driver, witness,
  attorney, etc.).
- Should hold only injury-specific attributes.
- Surfaces on the **Claim Person** tab of the claim product.

### 3. Claim Property Spec
- Describes damage to property involved in the claim.
- More variable than claim-person specs; multiple property specs may be needed for different
  property types.
- Surfaces on the **Claim Property** tab of the claim product.

### Optional — Coverage Specs
Coverage specs can be added to the claim product for organisational clarity (describing which
coverages the claim product manages). Not technically essential from a software perspective.

## Property claim model example (homeowners)

| Element | Type | Purpose |
|---------|------|---------|
| Property Claim | Claim Product Spec | Root claim container |
| Injury | Claim Injury Spec | Injury information |
| Damaged Property | Claim Property Spec | Property damage details |
| Dwelling | Coverage Spec | Property coverage type |
| Personal Property | Coverage Spec | Contents coverage type |

## Attributes on claim specs

Guiding question: **"What is needed to adequately investigate and adjudicate the claim?"**

| Spec | Attribute strategy |
|------|--------------------|
| Claim Injury | Minimal — ~4 attributes in the standard model (lower info needs) |
| Claim Property | Comprehensive — ~20 attributes in the homeowners example, including loss-estimate details |
| Claim Product | **Rules, not attributes** — rules reference the injury & property attributes |

Example damaged-property attributes cover specific property-damage details, loss-estimate
calculations, and related investigative information.

## Key takeaways

1. Claim models define the structure for claim creation via JSON input + automated services.
2. The three-component architecture (Claim Product, Claim Injury, Claim Property) is a scalable
   framework.
3. Attributes concentrate in the injury and property specs; the product spec focuses on automation
   rules.
4. Attribute selection is driven by investigation and adjudication requirements.
5. Multiple property specs may be needed for complex claims with different asset types.
6. Understanding product models is prerequisite knowledge for designing effective claim models.

**Next:** *Claims Creation for Insurance* module.
