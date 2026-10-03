# Sarafy

Sarafy is a completely offline grocery pricing and sales-management app for store employees. It combines a USD-to-SYP product catalog, invoice creation, expense tracking, and day/week/month business analytics in one bilingual Expo application.

Arabic is the primary language. English is also supported with automatic RTL/LTR layout changes and Cairo as the default font.

## Features

### Pricing and catalog

- Store product selling prices and cost prices in USD
- Convert all selling prices using one manually managed SYP exchange rate
- Optionally round converted prices to the nearest 5, 10, 500, or 1,000 SYP
- Search by product name or barcode
- Filter products by manually managed categories
- Store product images locally on the device

### Sales and invoices

- Create a sale by selecting products and adjusting quantities
- Apply a fixed SYP discount before completing an invoice
- Preserve product name, price, cost, and exchange rate snapshots in every sale
- Review complete invoice history
- Generate and share invoices as PDF files
- Record operating expenses locally

### Analytics

The sales dashboard supports today, current week, and current month views:

- Revenue
- Gross profit
- Operating expenses
- Net profit
- Invoice count
- Items sold
- Average invoice value
- Daily sales trend
- Top-selling products

Profit is calculated as:

```text
Gross profit = Net sales − Product costs
Net profit   = Gross profit − Operating expenses
```

Existing products created before cost tracking was introduced receive a cost of `0`. Update those products with their actual USD cost to obtain accurate profit figures.

### Backup and data exchange

- JSON backup and restore for products, categories, settings, sales, invoice items, and expenses
- Excel export containing:
  - `Products`
  - `Categories`
  - `Settings`
  - `Sales`
  - `Sale Items`
  - `Expenses`
- Excel product import for bulk product and category maintenance
- Blank or duplicate product IDs in imported workbooks are assigned safe IDs automatically
- All import and export operations use local files and system document/share sheets

## Technology

- Expo managed workflow
- React Native and TypeScript
- `expo-sqlite` with WAL mode and foreign-key enforcement
- Zustand for application state
- `react-native-reanimated` for state transitions
- `expo-print` and `expo-sharing` for PDF invoices
- SheetJS for offline Excel files
- Cairo via `@expo-google-fonts/cairo`

No server, API key, user account, or network request is required.

## Getting started

Requirements:

- Node.js
- npm
- Expo Go or an Android development build

Install and start:

```bash
npm install
npx expo start --clear
```

Useful commands:

```bash
npm run android
npm run typecheck
npx expo-doctor
```

The configured production target is Android:

```text
com.sarafy.catalog
```

## Application structure

```text
App.tsx                         Bottom navigation and application shell
src/components/                Shared bilingual UI components
src/database/database.ts       SQLite schema, migrations, and transactions
src/i18n/                      Arabic and English interface copy
src/screens/MainCatalogScreen  Converted-price catalog
src/screens/SalesScreen        Sales, invoices, expenses, and analytics
src/screens/ProductManagement  Product and category administration
src/screens/SettingsAndBackup  Preferences, backup, and Excel operations
src/store/useAppStore.ts       Zustand state and persistence bridge
src/utils/priceCalculator.ts   Pure USD-to-SYP calculation
src/utils/salesAnalytics.ts    Period metrics and trend calculations
src/utils/invoice.ts           Offline PDF invoice generation
src/backup/backupManager.ts    Portable backup creation, validation, and rotation
src/backup/backupArchive.ts    Streamed .sarafy archive and image checksums
src/import/                    Preview and transactional safe import
src/media/                     Permanent product-image storage and health checks
src/utils/excel.ts             Excel import and export
```

## Local database

The SQLite database is named `sarafy.db` and contains:

- `products`
- `categories`
- `settings`
- `sales`
- `sale_items`
- `expenses`

Historical invoice data is stored separately from current product data. Editing a product or changing the exchange rate therefore does not alter completed invoices or historical profit.

## Web development

The project can be previewed on the web during development. SQLite’s web worker is enabled in `metro.config.js`, including the COEP/COOP headers required by `SharedArrayBuffer`.

A production web host must preserve equivalent cross-origin isolation headers. Native document sharing and PDF behavior should be verified on the Android target before release.

## Data safety

- Importing JSON replaces the current local database, including sales and expenses.
- Importing Excel replaces current products, categories, and applicable settings.
- Create a JSON backup before importing data that may overwrite existing records.
- Product image URIs point to local device files and may not be portable to another device.

## Copyright

All rights reserved – Mohammad Adeeb Al-Salih 2026<br>
جميع الحقوق محفوظة – محمد أديب الصالح 2026
