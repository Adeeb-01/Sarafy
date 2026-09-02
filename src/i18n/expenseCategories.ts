export const DEFAULT_EXPENSE_CATEGORIES = [
  ['5a8d8194-27e5-4d6b-a1f4-81060cb99e01', 'إيجار', 'Rent'],
  ['5a8d8194-27e5-4d6b-a1f4-81060cb99e02', 'كهرباء', 'Electricity'],
  ['5a8d8194-27e5-4d6b-a1f4-81060cb99e03', 'رواتب', 'Salaries'],
  ['5a8d8194-27e5-4d6b-a1f4-81060cb99e04', 'نقل', 'Transportation'],
  ['5a8d8194-27e5-4d6b-a1f4-81060cb99e05', 'صيانة', 'Maintenance'],
  ['5a8d8194-27e5-4d6b-a1f4-81060cb99e06', 'مشتريات / مستلزمات', 'Supplies'],
  ['5a8d8194-27e5-4d6b-a1f4-81060cb99e07', 'أخرى', 'Other'],
] as const;

export const OTHER_EXPENSE_CATEGORY_UUID = DEFAULT_EXPENSE_CATEGORIES[6][0];
