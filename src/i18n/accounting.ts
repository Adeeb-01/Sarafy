import type { Language } from '@/types';

const ar = {
  title: 'المحاسبة', subtitle: 'دفتر أستاذ مزدوج القيد بعملة وظيفية ليرة سورية', enabled: 'المحاسبة مفعّلة', disabled: 'المحاسبة غير مفعّلة',
  startAccounting: 'بدء المحاسبة', startedAt: 'تاريخ البدء', functionalCurrency: 'العملة الوظيفية', overview: 'نظرة عامة', journal: 'دفتر اليومية', accounts: 'دليل الحسابات', reports: 'التقارير',
  cutoverTitle: 'تفعيل المحاسبة', cutoverIntro: 'أكد الأرصدة الافتتاحية كما هي فعليًا الآن. لن تُنشأ قيود للفترات السابقة.', cutoverBlocked: 'أغلق جلسة النقد الحالية قبل تفعيل المحاسبة.',
  cashSyp: 'النقد الافتتاحي — ل.س', cashUsd: 'النقد الافتتاحي — USD', cashUsdCarrying: 'القيمة الدفترية لنقد USD بالليرة', currentRate: 'سعر الصرف المثبت',
  customers: 'أرصدة العملاء', suppliers: 'أرصدة الموردين', inventory: 'تقييم المخزون', payable: 'مستحق للمورد', advance: 'دفعة مقدمة للمورد', receivable: 'ذمم مدينة', customerCredit: 'رصيد دائن للعميل',
  carryingValue: 'القيمة الدفترية بالليرة', quantity: 'الكمية', currentCostSuggestion: 'تكلفة المنتج الحالية للمرجع فقط', confirmCutover: 'تأكيد بدء المحاسبة', irreversible: 'يبدأ دفتر الأستاذ من هذه اللحظة ولا يمكن تعطيله أو إعادة بناء التاريخ تلقائيًا.',
  activationSuccess: 'تم تفعيل المحاسبة', activationFailed: 'تعذر تفعيل المحاسبة. راجع القيم وحالة الجلسة.', zeroCutover: 'تم التفعيل دون قيد افتتاحي لأن كل القيم المؤكدة صفر.',
  journalEmpty: 'لا توجد قيود بعد', reference: 'المرجع', source: 'المصدر', description: 'البيان', debit: 'مدين', credit: 'دائن', total: 'الإجمالي', lines: 'سطور القيد',
  trialBalance: 'ميزان المراجعة', profitLoss: 'الأرباح والخسائر', balanceSheet: 'الميزانية العمومية', accountLedger: 'كشف حساب الأستاذ', healthAudit: 'تدقيق سلامة المحاسبة',
  auditPassed: 'سلامة المحاسبة ناجحة', auditFailed: 'توجد مشكلات محاسبية', journalEntries: 'عدد القيود', journalLines: 'عدد السطور', balanced: 'متوازن', unbalanced: 'غير متوازن',
  salesRevenue: 'إيرادات المبيعات', salesReturns: 'مردودات المبيعات', netSales: 'صافي المبيعات', cogs: 'تكلفة البضاعة المباعة', grossProfit: 'مجمل الربح', operatingExpenses: 'المصاريف التشغيلية', realizedFx: 'فروقات الصرف المحققة', netProfit: 'صافي الربح',
  assets: 'الأصول', liabilities: 'الالتزامات', equity: 'حقوق الملكية', liabilitiesEquity: 'الالتزامات وحقوق الملكية', reportBlocked: 'التقرير محجوب حتى تصبح كل المطابقات المحاسبية سليمة.',
  broughtForward: 'الرصيد المرحّل', runningBalance: 'الرصيد الجاري', viewLedger: 'عرض الأستاذ', sharePdf: 'مشاركة PDF', close: 'إغلاق', retry: 'إعادة المحاولة',
  cashAdjustment: 'تسوية نقدية', cashAdjustmentIntro: 'استخدمها فقط لإدخال أو سحب مال المالك أو لإثبات زيادة/عجز نقدي. لا تعمل أثناء جلسة نقد مفتوحة.', currency: 'العملة', amount: 'المبلغ', reason: 'السبب', note: 'ملاحظة',
  ownerContribution: 'إيداع مالك', ownerWithdrawal: 'سحب مالك', cashOver: 'زيادة نقدية', cashShort: 'عجز نقدي', saveAdjustment: 'تسجيل التسوية', adjustmentSaved: 'تم تسجيل التسوية', adjustmentFailed: 'تعذر تسجيل التسوية',
  noData: 'لا توجد بيانات', allTime: 'كل المدة', today: 'اليوم', week: 'الأسبوع', month: 'الشهر', status: 'الحالة', bookCash: 'النقد الدفتري', openJournal: 'عرض القيود', loadFailed: 'تعذر تحميل البيانات المحاسبية',
  reconciliation: 'مطابقة الحسابات الرقابية', controlValue: 'النظام الفرعي', ledgerValue: 'دفتر الأستاذ', difference: 'الفرق', matched: 'مطابق', mismatch: 'غير مطابق',
  sypShort: 'ل.س',
  allAccounts: 'كل الحسابات', sale: 'بيع', saleReturn: 'مرتجع بيع', expense: 'مصروف', purchase: 'شراء', supplierReturn: 'مرتجع مورد', supplierPayment: 'دفعة مورد', customerPayment: 'دفعة عميل', inventoryAdjustment: 'تسوية مخزون', cashAdjustmentSource: 'تسوية نقدية', opening: 'افتتاحي', reversal: 'عكس قيد',
};

const en: typeof ar = {
  title: 'Accounting', subtitle: 'Immutable double-entry ledger in SYP functional currency', enabled: 'Accounting enabled', disabled: 'Accounting not enabled',
  startAccounting: 'Start accounting', startedAt: 'Started at', functionalCurrency: 'Functional currency', overview: 'Overview', journal: 'General Journal', accounts: 'Chart of Accounts', reports: 'Reports',
  cutoverTitle: 'Activate accounting', cutoverIntro: 'Confirm the actual opening positions as of now. No historical transactions will be back-posted.', cutoverBlocked: 'Close the active cash session before activating accounting.',
  cashSyp: 'Opening cash — SYP', cashUsd: 'Opening cash — USD', cashUsdCarrying: 'USD cash carrying value in SYP', currentRate: 'Committed exchange rate',
  customers: 'Customer balances', suppliers: 'Supplier balances', inventory: 'Inventory valuation', payable: 'Supplier payable', advance: 'Supplier advance', receivable: 'Receivable', customerCredit: 'Customer credit',
  carryingValue: 'Carrying value in SYP', quantity: 'Quantity', currentCostSuggestion: 'Current product cost — reference only', confirmCutover: 'Confirm accounting start', irreversible: 'The ledger begins at this point and cannot be silently disabled or historically reconstructed.',
  activationSuccess: 'Accounting activated', activationFailed: 'Accounting activation failed. Review the values and session state.', zeroCutover: 'Activated without an opening journal because every confirmed position is zero.',
  journalEmpty: 'No journal entries yet', reference: 'Reference', source: 'Source', description: 'Description', debit: 'Debit', credit: 'Credit', total: 'Total', lines: 'Journal lines',
  trialBalance: 'Trial Balance', profitLoss: 'Profit & Loss', balanceSheet: 'Balance Sheet', accountLedger: 'Account Ledger', healthAudit: 'Accounting Health Audit',
  auditPassed: 'Accounting health passed', auditFailed: 'Accounting issues found', journalEntries: 'Journal entries', journalLines: 'Journal lines', balanced: 'Balanced', unbalanced: 'Unbalanced',
  salesRevenue: 'Sales Revenue', salesReturns: 'Sales Returns', netSales: 'Net Sales', cogs: 'Cost of Goods Sold', grossProfit: 'Gross Profit', operatingExpenses: 'Operating Expenses', realizedFx: 'Realized FX', netProfit: 'Net Profit',
  assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity', liabilitiesEquity: 'Liabilities & Equity', reportBlocked: 'This report is blocked until every accounting reconciliation passes.',
  broughtForward: 'Brought forward', runningBalance: 'Running balance', viewLedger: 'View ledger', sharePdf: 'Share PDF', close: 'Close', retry: 'Retry',
  cashAdjustment: 'Cash adjustment', cashAdjustmentIntro: 'Use only for owner cash in/out or documented cash over/short. It is unavailable while a cash session is open.', currency: 'Currency', amount: 'Amount', reason: 'Reason', note: 'Note',
  ownerContribution: 'Owner contribution', ownerWithdrawal: 'Owner withdrawal', cashOver: 'Cash over', cashShort: 'Cash short', saveAdjustment: 'Record adjustment', adjustmentSaved: 'Cash adjustment recorded', adjustmentFailed: 'Cash adjustment failed',
  noData: 'No data', allTime: 'All time', today: 'Today', week: 'Week', month: 'Month', status: 'Status', bookCash: 'Book cash', openJournal: 'Open journal', loadFailed: 'Could not load accounting data',
  reconciliation: 'Control account reconciliation', controlValue: 'Subledger', ledgerValue: 'General ledger', difference: 'Difference', matched: 'Matched', mismatch: 'Mismatch',
  sypShort: 'SYP',
  allAccounts: 'All accounts', sale: 'Sale', saleReturn: 'Sale return', expense: 'Expense', purchase: 'Purchase', supplierReturn: 'Supplier return', supplierPayment: 'Supplier payment', customerPayment: 'Customer payment', inventoryAdjustment: 'Inventory adjustment', cashAdjustmentSource: 'Cash adjustment', opening: 'Opening', reversal: 'Reversal',
};

export function accountingText(language: Language) { return language === 'ar' ? ar : en }
