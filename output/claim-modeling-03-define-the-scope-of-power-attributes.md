# Unit 3 — Define the Scope of Power Attributes

**Module:** Claims Modeling for Insurance · ~10 mins
**Source:** [Trailhead unit](https://trailhead.salesforce.com/content/learn/modules/claim-modeling-for-insurance/define-the-scope-of-power-attributes)

## Learning objectives

1. Enumerate the classes applicable to power attributes.
2. Assess which Attribute Scope aligns with given claims requirements.
3. Develop benefit types to support sub-limit structures.

## Recap — power attributes on the homeowners product

| Attribute | Attached to |
|-----------|-------------|
| Deductible | Root product |
| Dwelling Limit | Dwelling coverage |
| Personal Property Limit, Furs Limit, Jewelry Limit, Guns Limit | Personal Property coverage |

## Power attribute classes (five)

| Class | Meaning |
|-------|---------|
| Out-of-pocket maximum | Total policyholder-responsibility threshold |
| Coinsurance | Shared cost percentage between insurer and policyholder |
| Limit | Maximum benefit payable |
| Deductible | Amount the policyholder pays before coverage begins |
| Copay | Fixed policyholder payment per service |

## Attribute Scope — when a term resets

Scope determines whether a power attribute **resets per claim** or **accumulates across the policy
term**.

### Deductible scoping

| Scope | Typical lines | Behaviour |
|-------|---------------|-----------|
| **Claim** | P&C with low claim frequency | Deductible resets after each claim closes; must be met again next claim |
| **Policy** | High-frequency (Health, Pet, Dental) | Deductible accumulates; once met, no further deductible that term |

**Claim scope (homeowners, $5,000 deductible):**

| When | Claim | Deductible paid | Payment | After close |
|------|-------|-----------------|---------|-------------|
| Jun | $225,000 | $5,000 | $220,000 | Deductible resets to $5,000 |
| Oct | $180,000 | $5,000 | $175,000 | Deductible resets again |

**Policy scope (medical, $5,000 deductible):**

| When | Claim | Deductible paid | Payment | After close |
|------|-------|-----------------|---------|-------------|
| Jun | $225,000 | $5,000 | $220,000 | Deductible balance now $0 |
| Oct | $180,000 | $0 | $180,000 | Stays satisfied |

### Limit scoping

| Scope | Behaviour |
|-------|-----------|
| **Claim Coverage** | Each claim starts with the full limit; limit fully resets on claim close |
| **Policy Coverage** | Limit does **not** reset between claims; prior usage reduces what's left |

**Claim Coverage scope (homeowners dwelling, $250,000 limit, $5,000 claim-scope deductible):**

| When | Claim | Deductible | Payment | Remaining limit | After close |
|------|-------|-----------|---------|-----------------|-------------|
| Jun | $225,000 | $5,000 | $220,000 | $30,000 | Deductible **and** limit reset |
| Oct | $180,000 | $5,000 | $175,000 | $75,000 | Full reset |

**Policy Coverage scope (medical surgery, $250,000 limit, $5,000 policy-scope deductible):**

| Claim | Deductible | Payment | Remaining limit | After close |
|-------|-----------|---------|-----------------|-------------|
| $225,000 | $5,000 | $220,000 | $30,000 | Neither resets |
| $180,000 | $0 | $30,000 (capped at remaining) | $0 | Policyholder covers excess $150,000 out-of-pocket |

## Benefit types — supporting sub-limits

**Benefit Type** designates which **sub-limit** a loss payment applies to within a broader coverage,
enabling granular tracking while still enforcing the overall coverage limit.

| Loss payment detail | Applies to |
|---------------------|-----------|
| **With** a benefit type | The specific sub-limit attribute **and** the overall coverage limit |
| **Without** a benefit type | Only the overall coverage limit |

### Personal Property structure

- Overall Personal Property limit: **$100,000**
- Sub-limits (each with a benefit type, all Claim Coverage scope):
  - Jewelry **$25,000**, Furs **$25,000**, Guns **$25,000**

### Burglary claim ($115,000 claimed)

Claimed: $35,000 jewelry · $10,000 furs · $12,500 guns · $58,000 miscellaneous.

| # | Item | Claimed | Sub-limit | Paid | Remaining coverage limit | Remaining sub-limit |
|---|------|---------|-----------|------|--------------------------|---------------------|
| 1 | Jewelry | $35,000 | $25,000 | $25,000 | $75,000 | $0 |
| 2 | Furs | $10,000 | $25,000 | $10,000 | $65,000 | $15,000 |
| 3 | Guns | $12,500 | $25,000 | $12,500 | $53,000 (≈) | $12,500 |
| 4 | Miscellaneous | $58,000 | — | $53,000 | $0 | N/A |

Jewelry is capped at its $25k sub-limit; the final miscellaneous payment is capped by the remaining
overall coverage limit.

## Key takeaways

1. **Scope determines reset behaviour** — Claim scope resets per claim; Policy scope accumulates.
2. **Context drives selection** — P&C lines lean Claim scope; Health/Pet/Dental lean Policy scope.
3. **Limits interact with deductibles** — both can hit one payment; the deductible reduces the net.
4. **Benefit Types enable segmentation** — sub-limits track item classes while the overall limit
   caps aggregate payout.
5. The claims system enforces scope and benefit-type rules automatically during loss-payment
   processing.
