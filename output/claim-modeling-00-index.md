# Claims Modeling for Insurance — Study Notes

Structured study notes captured from the Salesforce Trailhead module
**[Claims Modeling for Insurance](https://trailhead.salesforce.com/content/learn/modules/claim-modeling-for-insurance)**.

| Badge | Level | Role | Time | Points |
|-------|-------|------|------|--------|
| Claims Modeling for Insurance | Intermediate | Administrator | ~30 mins | +400 |

> These are faithful, reorganised study notes — not verbatim copies of Salesforce's
> copyrighted training content. Captured 2026-06-10.

## Units

| # | Unit | Time | Notes file |
|---|------|------|-----------|
| 1 | Set Up the Product Model | ~5 mins | [claim-modeling-01-set-up-the-product-model.md](claim-modeling-01-set-up-the-product-model.md) |
| 2 | Get to Know Power Attributes | ~10 mins | [claim-modeling-02-get-to-know-power-attributes.md](claim-modeling-02-get-to-know-power-attributes.md) |
| 3 | Define the Scope of Power Attributes | ~10 mins | [claim-modeling-03-define-the-scope-of-power-attributes.md](claim-modeling-03-define-the-scope-of-power-attributes.md) |
| 4 | Configure the Claim Model | ~5 mins | [claim-modeling-04-configure-the-claim-model.md](claim-modeling-04-configure-the-claim-model.md) |

## Running case study

All four units follow **Cumulus Insurance** — a large, diversified insurer (auto, business,
homeowners) that recently adopted the **Digital Insurance Platform** to modernise legacy systems.
Solution architect **Justus Pardo** designs the upgraded claims solution, using a **homeowners**
product as the worked example throughout.

## The big picture

```
Product Model  ──►  Policy Record  ──►  Claim Model  ──►  Complete Claim
  (structure)        (coverage,         (claim-specific    (adjudication)
                      limits, parties)    specs/attrs)
```

- **Unit 1** builds the *product model* (root product + child specs + attributes).
- **Units 2–3** layer *power attributes* on top — the metadata that lets the platform
  enforce limits/deductibles and track consumption as claims are paid.
- **Unit 4** builds the *claim model* — the blueprint for the claims people actually file.
