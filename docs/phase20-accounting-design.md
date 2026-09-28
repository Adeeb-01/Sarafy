# Sarafy Phase 20 — Accounting Design Gate

## Status

DESIGN BLOCKED — ACCOUNTING POLICY DECISION REQUIRED

No schema v19 migration or posting engine has been created. The current source remains at schema v18. This gate records only facts that can be proved from the current database and transaction paths; it does not invent inventory valuation, foreign-currency carrying values, or cash-continuity semantics.

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

## Mandatory Stop Findings

All five mandatory stop conditions are unresolved by existing evidence.

### 1. Inventory accounting value — unresolved

The system cannot derive a defensible functional-currency inventory asset from its quantity ledger. Existing purchase data lacks SYP value, while sale COGS snapshots are based on mutable product cost rather than inventory-layer depletion.

Decision required:

- the post-cutover costing method (FIFO, perpetual weighted average, standard cost, or another explicit method);
- treatment of opening tracked quantities and manually adjusted quantities;
- treatment of customer restocks and supplier returns;
- whether pre-cutover inventory receives an explicitly entered opening SYP valuation or remains outside GL until valued.

### 2. USD cash carrying value — unresolved

The system knows physical USD cents and transaction-time conversions for USD sales/customer receipts, but it has no carrying-value ledger for USD on hand. Direct USD opening cash and direct USD supplier payments have no SYP basis.

Decision required:

- how USD cash acquisitions create SYP carrying value;
- how USD outflows relieve that value (FIFO, weighted average, specific identification, or another policy);
- how opening USD cash is valued at cutover;
- when realized FX is recognized and how rounding is handled.

### 3. USD supplier-payable carrying value — unresolved

Supplier balances and entries are canonical USD cents only. Purchases, opening balances, and returns have no SYP carrying value. Paying a USD liability with SYP records a conversion for settlement but does not identify which liability carrying value was relieved.

Decision required:

- initial SYP carrying value for opening supplier positions;
- purchase-date SYP recognition policy;
- how payments and returns relieve payable carrying values;
- treatment of partial settlements, supplier credits, overpayments, and realized FX.

### 4. Purchase accounting exchange-rate semantics — unresolved

Purchases do not capture a rate. Applying the current rate later would rewrite history and is not acceptable. The system needs an explicit policy for new purchases and a cutover policy for existing purchase/stock history.

Decision required:

- which rate is snapshotted for new receipts and returns;
- whether the operational setting is authoritative or the user confirms a transaction rate;
- deterministic integer conversion/rounding rules;
- whether supplier returns reverse original receipt SYP value or use return-date value plus FX.

### 5. Cash continuity between sessions — unresolved

There is no persistent cash balance outside a session and no enforced continuity between closes and openings. Posting every opening as Cash and every close difference without a policy could create arbitrary equity, income, expense, or duplicate cash.

Decision required:

- whether GL cash persists continuously across shifts or each session is merely a drawer control;
- whether the next opening must reconcile to the prior actual close;
- how cash deposited, withdrawn, transferred, or recounted between sessions is documented;
- whether closing shortages/surpluses post automatically, require confirmation, or remain documentary.

## Accounting Cutover Consequence

A single cutover timestamp alone is insufficient. Safe Phase 20 implementation also needs explicit opening functional-currency balances for any GL-controlled inventory, USD cash, and USD supplier payable/credit positions. Historical operational documents must remain immutable and must not be retro-posted using inferred rates.

Until the policies above are approved:

- chart-of-accounts rows and journal tables must not be introduced as if their balances were authoritative;
- no automated journal posting should be wired into sales, purchases, returns, payments, expenses, or sessions;
- no trial balance, balance sheet, or realized-FX report can be represented as complete;
- existing analytics and subledgers remain the authoritative operational views.

## Safe Facts Available for a Later Design

Once the missing policies are supplied, these existing snapshots are suitable posting sources without modifying historical documents:

- SYP sale revenue, discounts, receivables, returns, expenses, and historical sale COGS;
- native and converted sale/customer-payment tenders;
- native USD purchase, supplier-return, supplier-account, and supplier-payment values;
- immutable transaction UUIDs and unique source links for idempotent journal posting;
- cash-session transaction membership and immutable close snapshots.

They are necessary source facts, but they do not resolve the five blocked accounting policies.

## Required Policy Decisions Before Schema v19

Phase 20 can resume only after an explicit answer to each of these questions:

1. Which perpetual inventory valuation method will Sarafy use after cutover, and what SYP opening value applies to existing stock?
2. Which method assigns and relieves SYP carrying value for physical USD cash, including opening USD?
3. How are USD supplier payables initially measured in SYP and subsequently relieved by returns/payments, including realized FX?
4. Which exchange rate and rounding rule is snapshotted for each new purchase, and do returns reverse original SYP cost or use return-date measurement?
5. Is business cash continuous across sessions? If yes, what documents inter-session additions/removals and how do close variances post?

Secondary presentation decisions will also be needed for negative customer balances (customer credit) and negative supplier balances (supplier credit), but those do not repair the five missing measurement policies above.

## Gate Result

Schema remains v18. No migration, chart of accounts, journal, posting engine, reporting UI, backup shape, or accounting PDF/Excel output has been implemented in Phase 20.

**DESIGN BLOCKED — ACCOUNTING POLICY DECISION REQUIRED**
