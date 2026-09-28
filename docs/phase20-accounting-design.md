# Sarafy Phase 20 — Accounting Design Gate

## Status

DESIGN APPROVED — READY FOR SCHEMA v19

All valuation, allocation, and zero-cutover policies are now explicit. No schema v19 migration or posting engine exists yet; the current source remains at schema v18 until this design approval is committed independently.

## Scope and Evidence

- Branch: `feature/phase-20-general-ledger-accounting-core`
- Audited start commit: `1952aaa feat: add customer accounts and receivables`
- Current schema constant: v18 (`src/database/database.ts:14`)
- Primary evidence: schema migrations and transaction functions in `src/database/database.ts`, payment arithmetic in `src/utils/multiCurrency.ts`, `src/utils/customerAccounts.ts`, and `src/utils/supplierAccounts.ts`, return allocation in `src/utils/returns.ts`, and sale-item construction in `src/screens/SalesScreen.tsx`.
- Established pre-Phase-20 automated baseline: 238/238 sequential tests passing.

## Verified Fact 1 — Immutable SYP Values

The current system preserves these historical SYP facts:

| Business fact | Stored value | Evidence and qualification |
|---|---|---|
| Sale net total | `sales.net_total_syp` | Stored on the immutable sale header. New sales calculate `subtotal - discount` and require safe-integer totals (`database.ts:1715-1729`, `1764-1769`). The original column has SQLite `REAL` affinity for legacy compatibility (`database.ts:676-686`). |
| Sale revenue | Header `subtotal_syp`, `discount_syp`, and `net_total_syp`; item `line_total_syp` | Item values are gross historical revenue. Net revenue after invoice discount exists exactly at header level; no immutable per-line net revenue is stored. Returns derive each line's net share deterministically from the original invoice (`returns.ts`). |
| Historical sale-item cost / COGS | `sale_items.unit_cost_syp`, `sale_items.line_cost_syp`, plus `sales.cost_syp` | Each new line cost is rounded once and summed for the sale (`database.ts:1716-1718`, `1773-1779`). The line total is the authoritative integer used by returns and analytics. The legacy columns have `REAL` affinity. |
| Invoice discount | `sales.discount_syp` | Fixed SYP amount stored with the sale. New sales clamp it to `[0, subtotal]` and require a safe integer (`database.ts:1718-1720`). |
| Customer return | `sale_returns.refund_total_syp` and `sale_return_items.refund_amount_syp` | Integer SYP, calculated from original sale snapshots, not current prices (`database.ts:144-178`, `1809-1859`; `returns.ts`). |
| Reversed historical cost | `sale_returns.returned_cost_syp` and `sale_return_items.cost_reversal_syp` | Integer SYP derived cumulatively from the original `sale_items.line_cost_syp`, preserving full-return equality (`returns.ts`). |
| Expense | `expenses.amount_syp` | Legacy column has `REAL` affinity, but current creation accepts only a positive safe integer and stores it unchanged (`database.ts:700-705`, `2023-2037`). |

Important limitation: a sale's historical COGS is immutable once sold, but it is not currently derived from a valued inventory ledger. It is a snapshot of the product cost selected by the sales UI at sale/draft time.

## Verified Fact 2 — Immutable USD Information

| Area | Current immutable USD data | Missing accounting data |
|---|---|---|
| Purchase receipt | Header supplier/reference/date snapshots; item `unit_cost_usd_cents` and `line_total_usd_cents` | No receipt exchange-rate snapshot, SYP total, or functional-currency inventory value (`database.ts:335-360`, `1331-1360`). |
| Purchase return | Header `total_value_usd_cents`; item historical `unit_cost_usd_cents` and `line_total_usd_cents` copied from the receipt item | No return-date or receipt-date SYP valuation and no exchange-rate snapshot (`database.ts:408-433`, `1393-1437`). |
| Supplier payment | Header `total_usd_equivalent_cents`; tender native amount and USD-equivalent cents; SYP tenders carry a rate; direct USD tenders carry no rate | No SYP carrying value for USD cash discharged and no SYP carrying value for the payable relieved (`database.ts:494-519`, `1179-1224`). |
| Supplier account | Balance cache and immutable entries are canonical signed USD cents | Opening, purchase, return, and payment entries do not carry functional-currency SYP amounts (`database.ts:489-542`). |

## Verified Fact 3 — Purchase Exchange-Rate Snapshot

Purchase receipts do not snapshot an exchange rate. `PurchaseReceiptInput` contains only supplier, optional reference/note, and items with quantity and USD unit cost (`src/types/index.ts:474-475`). The insert writes no rate field (`database.ts:1345-1353`).

Therefore a historical purchase cannot be converted to SYP later without choosing a rate that was not captured at the transaction time.

## Verified Fact 4 — Historical Purchase SYP Value

Purchase items have no stored historical SYP accounting value. Their only money fields are integer USD cents. Purchase receipt totals are derived by summing USD item totals; inventory movements created by the receipt contain quantities only.

This means current records cannot prove an SYP inventory debit or SYP accounts-payable credit for a purchase.

## Verified Fact 5 — Product Cost Over Time

`products.cost_usd` is a mutable product-master value (`database.ts:653-661`, `795-813`). Product creation/editing changes it directly. Purchase receipt creation updates stock quantity but does not update `products.cost_usd` (`database.ts:1331-1360`). Manual stock movements also do not update cost (`database.ts:887-916`).

At cart creation, the UI calculates `unitCostSyp = product.cost_usd * current exchange rate` (`src/screens/SalesScreen.tsx:114`). A completed sale then snapshots that value and the rounded line cost (`database.ts:1716-1718`, `1773-1779`). Drafts similarly snapshot unit cost. Consequently:

- historical sale COGS is stable after completion;
- different sales can carry different cost snapshots;
- the snapshot is based on mutable product cost and the sale-time operational rate;
- it is not a depletion from purchase layers or a weighted-average inventory valuation.

## Verified Fact 6 — Inventory Costing

Inventory currently has only:

- a quantity balance (`inventory_balances.quantity`);
- quantity movements with before/delta/after and source references;
- immutable product identity snapshots.

The inventory schema contains no money amount, unit carrying cost, lot, layer, FIFO queue, average cost, or valuation balance (`database.ts:275-312`, `401-470`). The health audit validates quantity arithmetic and unique source movements only (`database.ts:926-944`).

Therefore none of FIFO, weighted average, or lot costing exists. Product cost snapshots on sales are not an inventory valuation ledger.

## Verified Fact 7 — Cash Sessions Across Shifts

Each cash session accepts arbitrary non-negative SYP and USD opening amounts. Opening a new session checks only that no other session is open; it does not read the previous session (`database.ts:2095-2109`).

Closing computes expected and difference values and stores immutable closing snapshots (`database.ts:2115-2153`). There is no database link or invariant requiring:

- next opening = previous actual closing;
- next opening = previous expected closing;
- an explanation for cash inserted or removed between sessions.

The code therefore establishes a physical-drawer reconciliation model per shift, not a persistent business-cash subledger. Whether inter-session cash differences are owner contributions/draws, transfers, deposits, or simple recount resets is not represented.

## Verified Fact 8 — Customer-Return Currency Semantics

Customer returns are denominated entirely in SYP. The total refund and cost reversal are calculated from original SYP sale snapshots. Settlement is split into:

- `customer_account_credit_syp` posted to the SYP customer account; and
- `cashRefundSyp = refund_total_syp - customer_account_credit_syp` paid from the active session's SYP drawer.

A positive cash portion requires an active cash session and sufficient SYP cash (`database.ts:1831-1850`). There is no USD refund tender and no attempt to mirror the original sale tender currency. A fully on-account credit may be recorded without an active cash session because its cash portion is zero.

## Verified Fact 9 — Supplier-Return Financial Snapshots

A supplier return copies the original purchase item's USD unit cost and calculates integer USD line totals. The header stores the summed USD value (`database.ts:1410-1436`). If the supplier account is active, that same USD total posts as a negative supplier-account entry.

It does not store:

- an exchange rate;
- a historical SYP carrying value;
- an inventory cost-layer reduction;
- a cash refund or payment event.

The inventory effect is only a quantity decrement linked uniquely to the return item.

## Verified Fact 10 — Tender Snapshots

### Sales

- SYP tender: native SYP amount equals SYP equivalent; rate is null.
- USD tender: native USD cents, SYP equivalent, and sale rate are stored.
- Mixed: one row per currency.
- Sale header stores total tender equivalent and SYP change; change is always SYP.

Evidence: `database.ts:239-250`, `1764-1797`; `src/utils/multiCurrency.ts`.

### Supplier payments

- Canonical payment total is USD-equivalent cents.
- SYP tender stores native SYP, converted USD cents, and rate.
- USD tender stores native cents equal to USD-equivalent cents and a null rate.
- Mixed payment stores both tender rows; the header rate is the SYP conversion rate.

Evidence: `database.ts:494-519`, `1179-1224`; `src/utils/supplierAccounts.ts`.

### Customer payments

- Canonical payment total is SYP equivalent.
- SYP tender stores native SYP equal to SYP equivalent and a null rate.
- USD tender stores native USD cents, SYP equivalent, and rate.
- Mixed payment stores both tender rows; the header rate is the USD conversion rate.

Evidence: `database.ts:588-613`, `1048-1068`; `src/utils/customerAccounts.ts`.

These snapshots preserve operational settlement math. They do not establish the SYP carrying value of physical USD cash before it is received or when it is later spent.

## Verified Fact 11 — Transactions Outside an Active Cash Session

Yes. The following meaningful operational/accounting-adjacent actions do not require an active cash session:

- purchase receipts, including stock increase and an active supplier-account purchase entry;
- supplier returns, including stock decrease and an active supplier-account return entry;
- inventory opening, stock in/out, and physical-count adjustments;
- supplier/customer account activation and opening balance;
- exchange-rate changes;
- draft creation/deletion;
- product and party maintenance.

Sales, customer payments, supplier payments, and expenses require an active session. Customer returns require one only when there is a positive SYP cash refund. This is compatible with cash sessions being drawer controls, but it means a future general ledger cannot equate all journal activity with a cash-session boundary.

## Verified Fact 12 — Closing Differences

Cash-session closing differences are documentary only. Closing updates the `cash_sessions` row with expected, actual, and difference snapshots (`database.ts:2140-2152`). It does not mutate a persistent cash balance, create an expense/income record, affect the next opening, or post any other operational transaction.

## Approved Accounting Policies

### Functional currency and immutable journal

- The GL functional currency is SYP and every GL amount is integer SYP.
- USD operational values remain integer cents. Conversion must use deterministic `BigInt` arithmetic.
- Every posted journal balances exactly. Each line has exactly one positive side.
- Posted entries and lines are immutable. Corrections require a linked reversal and replacement; arbitrary manual journals are out of scope.
- A unique source identity prevents a second journal for the same operational source.

### Cutover

- Migration v18 to v19 creates structures only, leaves accounting disabled, and creates no historical journals or inferred values.
- Activation is explicit and is blocked while a cash session is open.
- The user must confirm cash SYP, native/carrying USD cash, customer AR/credit controls, each supplier payable/advance native and carrying position, every tracked product quantity/value, and the current rate.
- Exactly one balanced opening journal is created. `OPENING_EQUITY` is the sole final balancing amount; temporary P&L accounts cannot be used as plugs.
- Pre-cutover operational history remains immutable and legitimately has no GL journal.

### Inventory valuation

- Post-cutover method: perpetual moving weighted average in integer SYP.
- `inventory_balances` remains the quantity authority; separate balance and immutable valuation-movement records hold accounting quantity and carrying value.
- Existing tracked stock receives an explicitly confirmed opening SYP value per product; zero quantity requires zero value and untracked products receive no valuation.
- Outflows use proportional `BigInt` relief and remove all remaining value on full depletion.
- Purchases add translated historical SYP value; sales relieve moving-average value as separate GL COGS evidence without changing operational sale cost snapshots.
- A post-cutover customer restock restores the original accounting COGS allocation, not current average. Supplier returns and manual decreases relieve current moving-average value.
- Manual increases require an explicitly confirmed SYP value; product-master `cost_usd` is only a suggestion and never mutates accounting inventory.
- Manual decreases post Inventory Adjustment Loss; increases post Inventory Adjustment Gain.
- Supplier-return differences between inventory relief and liability/advance relief post to Inventory Valuation Variance.

### Purchase measurement

- Each new post-cutover purchase snapshots the committed operational exchange rate and immutable header/item SYP accounting values.
- Pre-cutover receipts keep null accounting rate/value and are never backfilled.
- A post-cutover purchase posts Inventory against Accounts Payable and creates a receipt-linked supplier liability layer atomically with stock, valuation, subledger, and journal changes.

### Supplier positions and realized FX

- The operational supplier account remains canonical signed USD cents.
- Positive supplier positions use FIFO payable layers with original/remaining native cents and SYP carrying value.
- Negative supplier positions are presented in the GL as Supplier Advances, never negative AP.
- Cutover requires explicit native and SYP carrying amounts per nonzero supplier position and creates cutover positions rather than pretending they came from old receipts.
- Supplier payments relieve payable layers FIFO. SYP consideration is exact SYP cash; USD consideration uses weighted-average USD cash carrying value. Differences against liability carrying value are realized FX gain/loss.
- A supplier return relieves the related receipt/cutover liability carrying value. Amount beyond remaining liability creates a Supplier Advance rather than resurrecting paid AP.
- A return against a pre-cutover receipt first relieves the supplier's cutover payable; excess advance uses the current committed rate. Inventory relief remains moving average and any mismatch posts to Inventory Valuation Variance.
- Changing the operational rate alone creates no journal or unrealized FX.

### USD cash carrying value

- Persistent USD cash stores both native cents and SYP carrying value; GL `CASH_USD` holds the carrying SYP amount.
- Cutover USD native/carrying values are explicitly confirmed.
- USD sale and customer-payment inflows add their immutable transaction SYP equivalents with no immediate FX.
- USD outflows use moving weighted-average carrying value with proportional `BigInt` relief and exact full depletion.
- Realized FX exists only when a settlement compares a liability carrying value with cash consideration carrying value.

### Customer controls

- The customer operational subledger remains signed integer SYP.
- GL uses separate Accounts Receivable and Customer Credits controls and applies explicit old/new balance zero-crossing calculations.
- Customer payments are not revenue. SYP increases Cash SYP; USD increases native/carrying USD cash using the payment snapshot; the exact operational SYP effect changes AR/Credit controls.
- Sales revenue is the immutable net invoice amount. Cash, AR, and Customer Credit lines reflect exact settlement; SYP change reduces Cash SYP. Accounting COGS is posted separately from moving-average inventory.

### Returns and prior-period adjustment

- A post-cutover customer return posts Sales Returns and its real Cash/AR/Credit settlement. Actual restocking reverses original accounting COGS into Inventory.
- A post-cutover return against a pre-cutover sale does not distort current Sales Returns or COGS. Real cash/account effects and any restock use the source-limited Prior Period Adjustment account; restock uses immutable historical operational cost evidence.
- Prior Period Adjustment cannot be used as a general balancing or cash-difference account.

### Cash control and sessions

- After activation, persistent Cash Control owns book SYP, native USD cents, and USD carrying SYP.
- Every cash-affecting source atomically updates its operational record, cash-session effect, Cash Control, and GL.
- The first and every later session opening must equal Cash Control; accounting-disabled behavior remains unchanged.
- Session close differences remain documentary and create no automatic journal or balance change.
- Unexplained actual cash cannot silently become the next opening. The operator must post an immutable, reasoned Cash Adjustment.
- Cash Adjustments are restricted to Owner Contribution, Owner Withdrawal, or Cash Over/Short. USD inflows use current-rate carrying value; USD outflows use moving-average relief. Outflows cannot overdraw Cash Control.

### Post-cutover account activation

- Customer or supplier account activation with a nonzero opening balance is blocked after GL cutover.
- Zero-opening activation remains allowed. Opening Equity is never mutated later to accommodate an operational account.

### Legacy numeric safety

- Every legacy `REAL`-affinity source amount is validated as finite, safe-integer SYP with correct sign before posting.
- Fractional values abort the entire operational transaction. The GL cannot silently round or truncate them.

### Reporting and equity

- Trial Balance, account ledger, General Journal, and P&L derive from journal lines, not operational analytics.
- Current Earnings is a presentation-only sum of temporary GL accounts; no period-close journal is created.
- Balance Sheet equity presents Opening Equity, Owner Contributions, Owner Drawings, Current Earnings, and Prior Period Adjustment.
- Balance Sheet is exposed as valid only when all cash, AR/Credit, AP/Advance, inventory, cache, and trial-balance reconciliations pass exactly.

### Portability

- Full backup/restore includes authoritative v19 accounting state and rejects unbalanced or inconsistent payloads.
- Restoring v8-v18 leaves accounting disabled with no invented opening state.
- Safe Merge skips all GL, valuation, cash-control, supplier-layer, and cash-adjustment history with an explicit operational-finance reason.
- Excel is report-only for accounting; it cannot import GL history.

## Original Five Blockers — Resolution

1. Inventory accounting value: resolved as explicit cutover value plus perpetual moving weighted average in SYP.
2. USD cash carrying value: resolved as native cents plus weighted-average SYP carrying value.
3. USD supplier-payable carrying value: resolved as explicit cutover positions plus FIFO receipt-linked payable layers.
4. Purchase exchange-rate semantics: resolved at the high level as immutable committed-rate snapshots on post-cutover receipts and no backfill.
5. Cash continuity: resolved through persistent Cash Control, exact session openings, documentary closes, and explicit Cash Adjustments.

## Final Allocation Policies

### Supplier Advance creation and consumption

- Supplier Advances are asset/prepayment positions, never negative AP, revenue, expense, or FX by themselves.
- Every advance origin creates an immutable FIFO layer preserving supplier, source identity, original/remaining native USD cents, original/remaining SYP carrying value, and timestamp.
- When a supplier payment crosses AP through zero, native USD-equivalent cents split exactly into payable settlement and advance creation.
- Payment consideration carrying value is exact SYP tender plus weighted-average USD Cash carrying relief. Mixed tenders are valued independently, summed, and then allocated; there is no arbitrary currency-first order.
- The total consideration carrying value is split between AP settlement and advance creation by deterministic cumulative `BigInt` proportional allocation using native supplier-account USD-equivalent cents. The final portion receives the exact residual.
- Only the AP-settlement portion can realize FX by comparing FIFO AP carrying value with its allocated consideration. The advance portion takes its allocated actual cash carrying value and creates no FX.
- Future purchases consume Supplier Advance layers FIFO before creating new AP. Full layer depletion removes all remaining SYP value; partial depletion uses proportional `BigInt` relief and retains exact residuals.
- Consumed advance carrying value transfers directly into Inventory (`DR Inventory / CR Supplier Advances`). It is not retranslated at the purchase rate and creates no FX.
- Only the uncovered native purchase amount is translated at the purchase rate and creates a new AP layer. A partly prepaid purchase's inventory value equals advance carrying value consumed plus new AP carrying value.
- Return-created advances use the approved receipt/cutover/return-time carrying basis and then behave like every other FIFO advance layer.
- Advance health requires native and SYP layer sums to equal the supplier-advance control, nonnegative remainders, no zero-native/nonzero-SYP residue, and no duplicate source allocation.

### Purchase conversion and allocation

- Purchase coverage is determined in native USD first: FIFO advances consumed, then uncovered USD becomes AP.
- The authoritative translated SYP amount for the uncovered AP portion uses `BigInt` half-up conversion of its USD-cent total at the immutable receipt rate.
- For a receipt without advances, this is the receipt's authoritative translated header amount. For a prepaid receipt, header accounting inventory value is advance carrying value transferred plus the uncovered AP translated value.
- Native prepaid and unpaid coverage is assigned to receipt lines deterministically by stable insertion sequence/immutable item ID.
- Translated SYP is allocated to lines using largest remainder: floor each exact numerator divided by 100, rank fractional remainders descending, and break ties by immutable insertion sequence/ID.
- Advance carrying value is allocated to the covered line portions using deterministic cumulative proportional relief from FIFO layers. Each line's accounting value is its advance basis plus allocated AP basis.
- Header accounting value and line accounting values are integer, nonnegative, reproducible after restore, and sum exactly.
- Partial supplier returns use cumulative proportional `BigInt` allocation from immutable original line quantity and accounting line total. Each return receives the new cumulative target minus previously allocated value; full return receives every remaining SYP unit.

### Customer-return physical restock COGS

- Financial return quantity and physical restock quantity remain independent.
- Each post-cutover sale item preserves original sold quantity, original accounting COGS, cumulative financial returns, cumulative restocked quantity, and cumulative accounting COGS restored.
- Inventory restoration is based solely on cumulative physical restock quantity, never cumulative financial return quantity.
- Target cumulative restored COGS is the `BigInt` half-up result of `originalAccountingCogs × cumulativeRestocked / originalQuantity`.
- The current return restores the new cumulative target minus prior cumulative restored COGS. Full physical restock forces exact restoration of all original accounting COGS.
- A zero-restock financial return has no inventory or accounting COGS effect.
- Cumulative restock cannot exceed cumulative financial returns or original sold quantity.
- Pre-cutover sale returns retain the approved Prior Period Adjustment treatment and use immutable operational historical cost evidence rather than a Phase 20 sale allocation.

### Centralized arithmetic

Pure centralized helpers must implement half-up ratios, cumulative proportional allocation, largest-remainder allocation, and full-depletion residual handling. Transaction functions cannot define independent rounding variants. Tests must cover equal remainders, safe-integer boundaries, multi-line purchases, staged supplier returns, staged restocks, and final exact depletion.

## Zero Cutover Policy

Accounting activation is valid when every explicitly confirmed opening accounting position is zero. In that case:

- `accounting_settings.enabled = 1`;
- `accounting_settings.started_at` and functional currency `SYP` are persisted normally;
- the confirmed cutover snapshot/state is persisted;
- `opening_journal_entry_id = NULL`;
- no opening journal and no journal lines are created;
- no nominal debit or credit is fabricated.

When any confirmed opening position is nonzero, exactly one nonempty `CUTOVER` journal is mandatory. `opening_journal_entry_id` references it, every line has exactly one positive side, total debits equal total credits, and Opening Equity is used only for the final net balancing amount.

The Accounting Health Audit classifies cutover as follows:

- Valid zero cutover: every confirmed opening position is zero, opening reference is null, and no cutover journal exists.
- Valid nonzero cutover: at least one confirmed opening position is nonzero, the opening reference is non-null, and exactly one matching valid balanced journal exists.
- Invalid: a fabricated journal for zero cutover, any zero-line or zero-value-line journal, missing journal for a nonzero cutover, multiple cutover journals, bad opening reference, or journal values inconsistent with the confirmed snapshot.

## Safe Facts Available to the Later Implementation

The approved allocation policies allow these existing snapshots to serve as posting sources without modifying historical documents:

- SYP sale revenue, discounts, receivables, returns, expenses, and historical operational sale COGS;
- native and converted sale/customer-payment tenders;
- native USD purchase, supplier-return, supplier-account, and supplier-payment values;
- immutable transaction UUIDs and unique source links for idempotent journal posting;
- cash-session transaction membership and immutable close snapshots.

## Gate Result

The design is internally complete for opening inventory, zero/nonzero cutover, purchase measurement and rounding, Supplier Advances and AP settlement, Realized FX, USD Cash, supplier returns, sale COGS, customer-return restocking, manual adjustments, Cash Control/sessions, cross-cutover returns, post-cutover account activation, Current Earnings, and conditional Balance Sheet presentation.

Schema remains v18 until the independent design approval commit is created. No migration or implementation code is part of this design gate.

**DESIGN APPROVED — READY FOR SCHEMA v19**
