# Sarafy Phase 21 — Flexible Product Pricing Design Gate

## Status

**DESIGN BLOCKED — PRICING POLICY DECISION REQUIRED**

The repository audit is complete enough to identify a material pricing-policy conflict, but schema v20 must not start until the owner selects the integer conversion policy described under **Blocking policy gap**. No migration or Phase 21 runtime implementation is included in this design gate.

## Audited baseline

- Branch: `feature/phase-21-flexible-product-pricing`
- Audited commit: `8903de8 docs: record phase 20.5 release candidate gate`
- Schema constant: v19
- Package: `com.sarafy.catalog`
- Established automated baseline: 268/268 sequential tests
- Product USD fields are SQLite `REAL` dollar values, not cents.
- The Phase 20 GL functional currency and all approved inventory-valuation rules remain SYP and are outside the Product master-cost model.

## Current product model

`products` currently stores `price_usd REAL NOT NULL CHECK(price_usd >= 0)` and `cost_usd REAL NOT NULL DEFAULT 0 CHECK(cost_usd >= 0)`. `Product` and `ProductInput` expose these as JavaScript `number` values. There is no declared decimal precision, cent representation, currency discriminator, or native SYP field.

Product create/edit accepts any finite nonnegative JavaScript number parsed from localized decimal text. It does not limit USD input to two decimal places. Product insert and update write name, category, both USD values, image, barcode, and timestamps together inside an exclusive SQLite transaction. Barcode lookup returns the complete Product row and does not participate in pricing.

## Audited read/write paths

| Area | Current behavior | Phase 21 consequence after policy approval |
|---|---|---|
| Product create/edit | `ProductFormModal` exposes decimal USD sale and cost inputs. `addProduct`/`updateProduct` write `price_usd` and `cost_usd`. | Add independent Cost and Sale currency selectors, nullable integer SYP native values, retain inactive values, validate the active value, and update all pricing fields atomically. Switching currency must never populate or overwrite the other native value silently. |
| Product list/details | Cards and dense rows treat USD as authoritative and show a current converted SYP price. | Show the active native value as authoritative. Any conversion is informational. No row-level database lookup. |
| Search/filter/sort | Text/category/status are currency-neutral. Price filters and sale/cost sorting compare raw USD fields. | Existing comparable price paths must resolve active values to current SYP once per in-memory Product row; raw USD and SYP native values cannot be compared. The old USD bucket labels require explicit remapping or replacement because `under $1` has no direct meaning for native SYP. |
| Barcode | Exact barcode lookup returns Product; cashier then runs the normal add-product path. | Barcode identity remains unchanged; the normal active Sale/Cost resolvers supply the line snapshot. |
| Cart | First added product locks `cartExchangeRate`. Sale price is `calculateSypPrice(price_usd, rate, rounding settings)`. Cost is `cost_usd * rate`. | Each line must capture one coherent Product configuration: source currencies, active native values, applicable rate, applicable sale-rounding snapshot, and resolved SYP values. A mixed USD/SYP cart remains valid. |
| Sale completion | `createSale` trusts immutable cart line inputs, requires integer sale unit price and totals, rounds each operational line cost with `Math.round(unitCostSyp * quantity)`, then writes sale/items/payments/inventory/accounting in one exclusive transaction. It rechecks stock, not Product pricing. | Persist line-native metadata atomically with existing sale rows. The completed sale keeps the cart snapshot; a concurrent Product edit cannot mix fields because Product mutation is one atomic row update and the cart holds a single resolved object snapshot. Persisted validators must reject incomplete mixed metadata. |
| Sale header rate | `sales.exchange_rate` is the cart/draft transaction rate and also supports tender conversion. | Keep one transaction rate. USD Sale or Cost sources reference it; SYP sources store no conversion rate. SYP-only product lines still coexist with payment modes that need the header rate. |
| Drafts | `sale_drafts` stores exchange rate and discount; `sale_draft_items` stores resolved SYP unit sale/cost snapshots. Resume uses these snapshots and only revalidates product availability/stock. It does not reprice. | Preserve this behavior. Draft source metadata may be added for evidence, but resumed lines remain their saved SYP snapshots even after Product edits or rate changes. |
| Repeat Sale | Looks up the current Product and builds a new cart with current USD fields/current rate; unavailable Products are skipped. | It remains a new sale and resolves the Product's current active configuration. Historical invoice values are not copied as new master prices. |
| Invoice/PDF | Invoice detail and PDF use immutable `sale_items.unit_price_syp`, line totals, header totals, payments, and saved rate. | Customer-facing invoice remains SYP authoritative. Native Product metadata need not be shown. |
| Customer returns | Refund allocation uses immutable `line_total_syp`; operational cost reversal uses immutable `line_cost_syp` with deterministic cumulative integer allocation. | No current Product field or rate is read. Legacy and v20 returns keep identical financial semantics. |
| Analytics/profit | Operational analytics use immutable sale header net/cost and item `line_total_syp`/`line_cost_syp`; returns subtract immutable refund/cost reversal on return date. | New sales feed the same resolved SYP snapshots. GL P&L remains distinct from operational Product-cost analytics. |
| GL accounting | Sale revenue posts from invoice SYP snapshots. GL COGS uses Phase 20 moving-weighted-average inventory valuation and `accounting_cogs_syp`, not Product cost. | Product pricing edits create no journal and never change valuation, journals, historical COGS, or reconciliations. |
| Inventory | Quantity balances/movements and Phase 20 valuation are independent of Product master cost. Manual positive movements currently require an explicit accounting SYP value and show no automatic Product-cost suggestion. | A later implementation may prefill only a non-authoritative suggestion: native SYP cost directly, or USD cost converted by the approved integer policy/current committed rate. Confirmation and GL valuation rules stay unchanged. Decreases still use carrying value. |
| Purchases | Purchase receipts are immutable USD-cent documents. The UI currently pre-fills receipt unit cost from `product.cost_usd`; posting does not update Product master cost. | Purchases stay USD. An active SYP Product cost cannot fall back to stale inactive `cost_usd`. To avoid silent conversion, its receipt-cost field must require explicit USD entry (or show an uncommitted current-rate suggestion only after the owner approves conversion rules). Receipt/accounting semantics do not change. |
| Supplier returns | Use purchase item USD snapshots, inventory valuation, supplier layers, and immutable accounting fields. | No Product master cost or currency lookup. |
| Backup/restore | Full backup serializes `SELECT *` Products and sale items. Full restore and legacy conversion explicitly map current Product fields and sale-item columns. Older payloads default missing cost to zero. | v20 adds Product and sale-line metadata to portable payloads. Pre-v20 Products default to USD/USD with null SYP fields. Pre-v20 sale metadata stays null. Full restore preserves exact active/inactive native values and snapshots. |
| Safe Merge | Products are mergeable by UUID/barcode with existing updated-at/conflict policy. Product updates currently replace USD master fields. Operational history has separate protected policies. | New Product pricing fields participate as one coherent master-data record. Merge never rewrites historical sale/draft/accounting snapshots. |
| Excel | Excel both exports and imports Products. Import accepts current Product columns and defaults missing cost to zero; it is not export-only. Sales/accounting sheets are export-only. | Export adds Cost Currency/Cost USD/Cost SYP/Sale Currency/Sale USD/Sale SYP. Legacy Product rows default USD/USD. Existing Product import must validate enum, active value, and integer SYP; it must not create a new historical-finance import path. |
| Health audit | Product pricing has no dedicated health audit. Accounting and inventory audits validate their own immutable state. | Validate currency enums, active native values, integer/safe/nonnegative SYP values, and coherent post-v20 line evidence. Null metadata remains valid for pre-v20 sales. |
| Performance | Product lists hydrate Product plus inventory balance in one query and resolve prices in JS. | Keep one query and O(1) per-row resolution; no N+1. Existing indexes/search paths remain unchanged unless a benchmark proves otherwise. |

## Current resolution semantics

### Sale price

`calculateSypPrice` currently performs JavaScript floating-point multiplication:

```text
raw = price_usd * exchange_rate

rounding enabled:
  Math.round(raw / rounding_target) * rounding_target

rounding disabled:
  raw
```

The rounding target can be 5, 10, 500, or 1000 SYP. The UI and previews accept the returned number. `createSale`, however, rejects a non-safe-integer `unitPriceSyp`.

### Operational Product cost

The cart and Repeat Sale calculate `cost_usd * transaction_rate` with JavaScript floating-point arithmetic. `createSale` accepts a finite fractional `unitCostSyp`, then stores that unit value and calculates the authoritative integer line cost as:

```text
Math.round(unitCostSyp * quantity)
```

Returns and analytics use the immutable integer line cost. This operational cost is unrelated to the GL inventory carrying value and accounting COGS.

## Historical boundaries

- Existing sales, items, drafts, payments, returns, purchases, supplier returns, inventory valuation, and journals are immutable and are not migrated or recomputed.
- Pre-v20 sale items may have null new pricing metadata; their existing SYP snapshots remain authoritative.
- Legacy Products must migrate to Cost USD / Sale USD with unchanged USD values and null inactive SYP values.
- Current-rate changes affect only previews and newly resolved USD sources.
- SYP native master values must remain fixed across rate changes.

## Intended schema shape after approval

One transactional v19 to v20 migration should minimally add to `products`:

- `cost_currency` constrained to USD/SYP, default USD;
- nullable integer `cost_syp`;
- `sale_price_currency` constrained to USD/SYP, default USD;
- nullable integer `sale_price_syp`.

Existing `cost_usd` and `price_usd` remain compatible `REAL` dollar fields and retain inactive values.

Post-v20 sale items need immutable evidence for both sale and operational cost resolution. At minimum this includes source currency, native value, conversion rate when USD, resolved SYP unit/line values, and enough sale-rounding metadata to reproduce a USD sale price. Existing resolved SYP columns remain financially authoritative. Exact column types and constraints depend on the blocking integer policy.

No Product edit creates a journal. No Product column is used to derive GL COGS.

## Blocking policy gap

The requirements simultaneously mandate:

1. backward-compatible existing USD behavior;
2. no previously legal USD value should be blocked;
3. deterministic resolution according to existing rules;
4. SYP values must be safe integers; and
5. floating-point SYP arithmetic must never be used.

The current model cannot satisfy all five without a new owner-approved rule:

- USD Product values are unrestricted SQLite `REAL` dollars and the form accepts arbitrary decimal precision.
- The exchange rate is an integer.
- With rounding disabled, the existing resolver returns the raw floating result.
- Example: USD 1.23 at 15,001 SYP/USD resolves to 18,451.23 SYP.
- The cart can display that fractional result, but `createSale` rejects it because unit sale price must be a safe integer.
- Cost has a second ambiguity: the current unit operational cost may be fractional and only `line_cost_syp` is rounded after multiplication by quantity. Phase 21 asks for integer SYP evidence but does not say whether to round the unit or only the line, nor which rule to use.
- Restricting USD Product values to cents would newly reject previously legal values and would not resolve fractional SYP when the rate is not divisible by 100.
- Retaining raw floating values violates the explicit integer/no-floating requirements and prevents exact health-audit reproduction.

### Required owner decision

Choose an exact deterministic policy for USD Product Sale and USD Product Cost whenever the mathematical SYP result is fractional. The decision must state:

- rounding mode: half-up, floor, ceiling, or another explicit rule;
- rounding stage for operational cost: unit first or immutable line total after quantity;
- whether the existing optional sale-price rounding target is applied before or after the base integer conversion;
- maximum accepted USD decimal precision for newly edited Products while preserving legacy stored values; and
- how post-v20 health audit reproduces legacy/high-precision USD values.

### Recommended policy

Use decimal-to-rational parsing with `BigInt`, never binary floating arithmetic:

- preserve legacy USD `REAL` values but canonicalize their finite decimal string when resolving;
- for USD Sale Price, convert the exact decimal×rate fraction to integer SYP using half-up, then apply the existing optional target rounding using integer arithmetic;
- for USD operational Cost, compute the exact native decimal×rate×quantity fraction and half-up once at immutable line-total level; store the resolved line total as authoritative and retain the exact native/rate evidence;
- permit up to the existing practical precision for imported legacy data, but define a deliberate precision limit for new UI/Excel edits;
- store sale rounding-enabled/target metadata for exact replay.

This recommendation is not implemented because it changes the current rounding-disabled sale behavior and formalizes a cost rule that the owner has not approved.

## Other decisions that are not blockers

- Drafts retain their current resolved snapshots and do not reprice on resume.
- Product Safe Merge remains master-data merge only.
- Product Excel import already exists and must be extended, not invented.
- For a SYP-cost Product added to a USD purchase receipt, inactive USD cost cannot be used. The purchase cost remains an explicit USD receipt input; any conversion shown is only an uncommitted suggestion.
- Existing Product price filters with USD-named thresholds should be redesigned to compare resolved SYP values or removed in favor of currency-neutral thresholds; raw cross-currency comparison is prohibited.
- Sale-line source metadata needs rounding evidence for USD Sale Price because native value plus rate alone cannot reproduce target rounding.

## Implementation gate

Schema remains v19. No migration, runtime pricing resolver, UI change, backup format change, or sale metadata write may begin until the owner approves the fractional USD-to-SYP policy.

**DESIGN BLOCKED — PRICING POLICY DECISION REQUIRED**
