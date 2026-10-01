# Sarafy Phase 21 — Flexible Product Pricing Design Gate

## Status

**DESIGN APPROVED — READY FOR SCHEMA v20**

The repository audit and pricing-policy review are complete. The owner-approved exact decimal, rounding, precision, snapshot, and legacy policies below close the prior fractional USD-to-SYP gap. No migration or Phase 21 runtime implementation is included in this design approval commit.

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

Post-v20 `sale_items` and `sale_draft_items` add nullable source metadata for legacy compatibility: Sale source currency, either canonical native USD decimal text or native integer SYP, USD pricing rate when applicable, rounding-enabled/target evidence, Cost source currency, either canonical native USD decimal text or native integer SYP, and USD cost rate when applicable. Existing `unit_price_syp` and `line_cost_syp` remain the resolved financial authorities. `unit_cost_syp REAL` remains compatibility/display evidence only for post-v20 USD-cost rows.

No Product edit creates a journal. No Product column is used to derive GL COGS.

## Approved exact arithmetic policy

All committed Phase 21 SYP sale-price and operational-cost values are nonnegative safe integers. Binary floating-point multiplication and `Math.round` over USD-derived products are prohibited. A centralized pure pricing module parses a canonical decimal string into an integer numerator and power-of-ten denominator, performs multiplication and rounding with `BigInt`, and rejects a final result outside the safe integer range.

The approved rounding mode is **HALF-UP**. Exact half-quantum ties round upward.

### USD Sale Price

The resolver rounds the exact rational USD value multiplied by the integer transaction rate directly to the final quantum:

- rounding disabled: quantum is 1 SYP;
- rounding enabled: quantum is the stored rounding target (currently 5, 10, 500, or 1000 SYP).

There is no intermediate round-to-1 step. For example, exact 4.60 SYP with target 10 resolves directly to 0, not 10. Exact 18,450.5 with quantum 1 resolves to 18,451; 15 with quantum 10 resolves to 20.

Native SYP Sale Price is already authoritative integer SYP. Neither the current exchange rate nor the optional USD rounding setting modifies it.

### USD operational Product Cost

USD operational cost rounds exactly once at immutable line-total level:

```text
exact line cost = canonical native USD cost × transaction rate × quantity
line_cost_syp = HALF_UP(exact line cost to 1 SYP)
```

The system must not round the converted unit cost and then multiply. For USD 1.23, rate 15,001, and quantity 3, the authoritative line cost is HALF-UP(55,353.69) = 55,354 SYP.

For a native SYP Cost, `line_cost_syp = cost_syp × quantity` with safe `BigInt` arithmetic and no conversion or rounding.

The legacy `unit_cost_syp REAL` column remains compatibility/display evidence for a post-v20 USD-cost line. It is never authoritative for returns, analytics, Health Audit, or recomputation. The immutable integer `line_cost_syp`, exact native decimal snapshot, rate, and quantity are authoritative.

### USD master precision

New or explicitly modified Product USD Sale/Cost values accept zero through four decimal places. More than four is rejected with no silent rounding. The rule also applies to Product rows newly imported or updated through Excel.

Pre-v20 SQLite `REAL` values with greater precision remain valid, migrate unchanged as USD/USD, and can be used for new transactions after stable canonicalization. An unrelated Product edit may preserve such an unchanged legacy value. If that USD field is explicitly changed, the replacement must satisfy the four-decimal rule. Backup/Restore fidelity does not apply the new-edit limit to stored historical Product values.

### Canonical decimal snapshots

One centralized implementation canonicalizes a finite legacy JS number into a stable decimal string before exact arithmetic. New UI/Excel text is parsed as exact decimal input before conversion. The immutable canonical string is captured on every post-v20 Draft/Sale line so later audit never reconstructs native value from the mutable Product row.

For post-v20 USD Sale Price, snapshot source currency, canonical native decimal, transaction rate, rounding-enabled flag, rounding target, and resolved integer unit price. For SYP Sale Price, snapshot source currency, native integer SYP, null pricing rate/rounding conversion metadata, and identical resolved unit price.

For post-v20 USD Cost, snapshot source currency, canonical native decimal, transaction rate, quantity, and authoritative integer line cost. For SYP Cost, snapshot source currency, native integer SYP, null cost conversion rate, quantity, and exact multiplied line cost.

### Health Audit replay

- USD Sale source: parse immutable canonical decimal, multiply by stored rate, round directly HALF-UP to stored final quantum, and require exact equality with `unit_price_syp`.
- SYP Sale source: require safe nonnegative native SYP, null pricing conversion metadata, and exact equality with `unit_price_syp`.
- USD Cost source: multiply immutable canonical decimal by stored rate and original quantity, round once HALF-UP to 1 SYP, and require exact equality with `line_cost_syp`.
- SYP Cost source: require exact safe multiplication of native SYP by quantity to equal `line_cost_syp`.
- Pre-v20 sale/draft rows with null source metadata remain valid and authoritative through their existing SYP snapshots; they are not replayed through Phase 21 formulas.

Changing Product values, the current rate, or rounding settings after sale/draft creation cannot affect this replay.

## Other decisions that are not blockers

- Drafts retain their current resolved snapshots and do not reprice on resume.
- Product Safe Merge remains master-data merge only.
- Product Excel import already exists and must be extended, not invented.
- For a SYP-cost Product added to a USD purchase receipt, inactive USD cost cannot be used. The purchase cost remains an explicit USD receipt input; any conversion shown is only an uncommitted suggestion.
- Existing zero-price filtering remains exact on the active native value. The old under-1/1-to-10/over-10 USD buckets retain their familiar thresholds as current-rate USD-equivalent bands: compare each active Sale Price after current SYP resolution with the exact current SYP equivalents of USD 1 and USD 10. Sale and Cost sorting likewise compare current resolved SYP values. Raw cross-currency native values are never compared.
- Sale-line source metadata needs rounding evidence for USD Sale Price because native value plus rate alone cannot reproduce target rounding.

## Consistency reread result

The approved policy makes every audited path deterministic:

- Product create/edit distinguishes unchanged high-precision legacy values from new four-decimal input.
- Product display and comparable filters resolve from the active native field without row queries.
- Cart, barcode, Repeat Sale, and mixed carts use the centralized resolver.
- Drafts preserve exact source evidence and never reprice on resume.
- Sale completion persists one coherent immutable Product pricing snapshot and exact integer SYP totals.
- Returns and operational analytics continue using immutable integer SYP line snapshots.
- Inventory suggestions may use the centralized current-rate resolver but remain uncommitted suggestions.
- Purchases remain USD and never use an inactive Product USD cost as authoritative.
- Backup/Restore preserves exact v20 fields while pre-v20 Products default to USD/USD.
- Safe Merge updates the coherent Product master only and never historical snapshots.
- Excel Product import validates new values to four places; historical finance remains export-only.
- Health Audit replays post-v20 evidence and exempts pre-v20 rows from nonexistent source metadata.
- GL inventory valuation, accounting COGS, journals, supplier layers, and realized FX are unchanged.

No other pricing-policy gap remains after the complete reread.

## Implementation gate

Schema remains v19 in this document-only approval commit. Implementation may now begin with one transactional v19 to v20 migration and the approved centralized arithmetic/snapshot model.

**DESIGN APPROVED — READY FOR SCHEMA v20**
