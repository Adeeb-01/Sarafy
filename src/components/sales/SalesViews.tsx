import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeIn, FadeOut, ReduceMotion, SlideInDown } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton, AppInput, BottomSheet, EmptyState, IconButton, MonetaryValue, QuantityStepper, SegmentedControl } from '@/components/ui';
import { CASHIER_PRODUCT_ROW_GAP, CASHIER_PRODUCT_ROW_HEIGHT, CashierProductRow } from '@/components/sales/CashierProductRow';
import { Expense, Product, Sale, SaleItemInput, Settings } from '@/types';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { formatNumber } from '@/utils/formatters';
import { parseLocalizedNumber } from '@/utils/salesUiState';
import { uiText } from '@/i18n';

export type CartLine = SaleItemInput;
const CART_LINE_HEIGHT = 80;

type NewSaleProps = {
  products: Product[];
  settings: Settings;
  cart: CartLine[];
  completedSale: Sale | null;
  bottomNavigationInset: number;
  sharing: boolean;
  onAdd: (product: Product) => void;
  onQuantityChange: (productId: number, quantity: number) => void;
  onQuantityDelta: (productId: number, delta: number) => void;
  onReviewCart: () => void;
  onNewSale: () => void;
  onShare: (sale: Sale) => void;
};

export function NewSaleView({ products, settings, cart, completedSale, bottomNavigationInset, sharing, onAdd, onQuantityChange, onQuantityDelta, onReviewCart, onNewSale, onShare }: NewSaleProps) {
  const { colors } = useAppTheme();
  const rtl = settings.language === 'ar';
  const copy = uiText(settings.language);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [summaryHeight, setSummaryHeight] = useState(0);
  const quantityByProduct = useMemo(() => new Map(cart.map(line => [line.productId, line.quantity])), [cart]);
  const visibleProducts = useMemo(() => {
    const query = deferredSearch.trim().toLocaleLowerCase();
    return products.filter(product => !query || product.name.toLocaleLowerCase().includes(query) || product.barcode?.toLocaleLowerCase().includes(query));
  }, [deferredSearch, products]);
  const itemCount = useMemo(() => cart.reduce((sum, line) => sum + line.quantity, 0), [cart]);
  const total = useMemo(() => cart.reduce((sum, line) => sum + line.unitPriceSyp * line.quantity, 0), [cart]);
  const contentStyle = useMemo(() => ({ paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: bottomNavigationInset + (cart.length ? summaryHeight : 0) + spacing.md }), [bottomNavigationInset, cart.length, summaryHeight]);
  const renderItem = useCallback(({ item }: { item: Product }) => <CashierProductRow product={item} settings={settings} quantity={quantityByProduct.get(item.id) ?? 0} onAdd={onAdd} onQuantityChange={onQuantityChange} onQuantityDelta={onQuantityDelta} />, [onAdd, onQuantityChange, onQuantityDelta, quantityByProduct, settings]);

  if (completedSale) return <SaleSuccess sale={completedSale} language={settings.language} bottomNavigationInset={bottomNavigationInset} sharing={sharing} onShare={onShare} onNewSale={onNewSale} />;

  return <View style={styles.flex}>
    <View style={[styles.searchSurface, { backgroundColor: colors.surfaceSecondary }]}>
      <AppInput value={search} onChangeText={setSearch} placeholder={copy.sales.search} accessibilityLabel={copy.sales.searchAccessibility} rtl={rtl} leadingIcon="search" subtleFocus autoCorrect={false} returnKeyType="search" />
      <View style={[styles.resultCaption, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Feather name="package" size={13} color={colors.textMuted} /><Text style={[typography.caption, { color: colors.textMuted }]}>{copy.sales.productCount(String(visibleProducts.length))}</Text></View>
    </View>
    <FlatList style={styles.flex} data={visibleProducts} keyExtractor={item => String(item.id)} renderItem={renderItem} ItemSeparatorComponent={CashierRowSeparator} contentContainerStyle={[contentStyle, visibleProducts.length === 0 && styles.grow]} keyboardShouldPersistTaps="handled" initialNumToRender={14} maxToRenderPerBatch={14} updateCellsBatchingPeriod={40} windowSize={7} removeClippedSubviews getItemLayout={(_, index) => ({ length: CASHIER_PRODUCT_ROW_HEIGHT + CASHIER_PRODUCT_ROW_GAP, offset: (CASHIER_PRODUCT_ROW_HEIGHT + CASHIER_PRODUCT_ROW_GAP) * index, index })} ListEmptyComponent={<EmptyState icon="search" title={copy.sales.noProducts} description={copy.sales.noProductsDescription} />} />
    {cart.length > 0 && <Animated.View entering={SlideInDown.duration(200).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(140).reduceMotion(ReduceMotion.System)} onLayout={event => setSummaryHeight(event.nativeEvent.layout.height)} style={[styles.cartSummary, { bottom: bottomNavigationInset, backgroundColor: colors.surfaceElevated, borderTopColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }]}>
      <View style={styles.cartSummaryCopy}><MonetaryValue value={total} language={settings.language} currencyLabel={copy.common.syp} inline style={[styles.summaryMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={styles.summaryMoneyText} /><Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.cartItems(formatNumber(itemCount, settings.language))}</Text></View>
      <AppButton label={copy.sales.reviewCart} icon={rtl ? 'arrow-left' : 'arrow-right'} onPress={onReviewCart} accessibilityHint={copy.sales.reviewCartHint} style={styles.reviewButton} />
    </Animated.View>}
  </View>;
}

function CashierRowSeparator() { return <View style={{ height: CASHIER_PRODUCT_ROW_GAP }} />; }

export function CartReviewModal({ visible, cart, discount, discountError, subtotal, appliedDiscount, total, language, saving, onClose, onDiscountChange, onQuantityChange, onQuantityDelta, onRequestComplete }: { visible: boolean; cart: CartLine[]; discount: string; discountError?: string; subtotal: number; appliedDiscount: number; total: number; language: Settings['language']; saving: boolean; onClose: () => void; onDiscountChange: (value: string) => void; onQuantityChange: (productId: number, quantity: number) => void; onQuantityDelta: (productId: number, delta: number) => void; onRequestComplete: () => void }) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const rtl = language === 'ar';
  const copy = uiText(language);
  const [footerHeight, setFooterHeight] = useState(0);
  const itemCount = useMemo(() => cart.reduce((sum, line) => sum + line.quantity, 0), [cart]);
  const renderItem = useCallback(({ item }: { item: CartLine }) => <CartLineRow line={item} language={language} onQuantityChange={onQuantityChange} onQuantityDelta={onQuantityDelta} />, [language, onQuantityChange, onQuantityDelta]);

  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={saving ? () => undefined : onClose}>
    <SafeAreaView edges={['top']} style={[styles.reviewPage, { backgroundColor: colors.background }]}>
      <View style={[styles.reviewHeader, { backgroundColor: colors.surface, borderBottomColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }]}><View style={styles.flex}><Text style={[typography.titleLarge, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.reviewCart}</Text><Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.cartCount(formatNumber(itemCount, language))}</Text></View><IconButton icon="x" label={copy.sales.closeCart} onPress={onClose} disabled={saving} /></View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <FlatList style={styles.flex} data={cart} keyExtractor={item => String(item.productId)} renderItem={renderItem} ItemSeparatorComponent={() => <View style={[styles.lineSeparator, { backgroundColor: colors.border }]} />} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: footerHeight + insets.bottom + spacing.md }} initialNumToRender={12} maxToRenderPerBatch={12} updateCellsBatchingPeriod={40} windowSize={7} getItemLayout={(_, index) => ({ length: CART_LINE_HEIGHT + StyleSheet.hairlineWidth, offset: (CART_LINE_HEIGHT + StyleSheet.hairlineWidth) * index, index })} ListEmptyComponent={<EmptyState icon="shopping-bag" title={copy.sales.emptyCart} description={copy.sales.emptyCartDescription} />} ListFooterComponent={cart.length ? <CartTotals discount={discount} discountError={discountError} subtotal={subtotal} appliedDiscount={appliedDiscount} total={total} language={language} onDiscountChange={onDiscountChange} /> : null} />
        <View style={[styles.reviewFooter, { backgroundColor: colors.surface, borderTopColor: colors.border, paddingBottom: insets.bottom }]}><View onLayout={event => setFooterHeight(event.nativeEvent.layout.height)} style={styles.reviewFooterAction}><AppButton label={saving ? copy.sales.completing : copy.sales.completeSale} icon="check-circle" onPress={onRequestComplete} loading={saving} disabled={!cart.length || Boolean(discountError)} accessibilityHint={copy.sales.completeHint} style={styles.fullButton} /></View></View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const CartLineRow = memo(function CartLineRow({ line, language, onQuantityChange, onQuantityDelta }: { line: CartLine; language: Settings['language']; onQuantityChange: (productId: number, quantity: number) => void; onQuantityDelta: (productId: number, delta: number) => void }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language);
  return <Animated.View exiting={FadeOut.duration(140).reduceMotion(ReduceMotion.System)} style={[styles.cartLine, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><View style={styles.cartLineCopy}><Text numberOfLines={1} style={[typography.bodyMedium, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{line.productName}</Text><Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.unitPrice(formatNumber(line.unitPriceSyp, language))}</Text><MonetaryValue value={line.unitPriceSyp * line.quantity} language={language} currencyLabel={copy.common.syp} inline style={[styles.lineMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={styles.lineMoneyText} /></View><View style={[styles.cartLineActions, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><QuantityStepper value={line.quantity} min={0} max={999} compact label={copy.sales.quantity(line.productName)} decreaseLabel={copy.sales.decrease(line.productName)} increaseLabel={copy.sales.increase(line.productName)} onChange={value => onQuantityChange(line.productId, value)} onDecrement={() => onQuantityDelta(line.productId, -1)} onIncrement={() => onQuantityDelta(line.productId, 1)} /><IconButton icon="trash-2" label={copy.sales.removeFromCart(line.productName)} tone="danger" onPress={() => onQuantityChange(line.productId, 0)} style={styles.removeCartLine} /></View></Animated.View>;
});

function CartTotals({ discount, discountError, subtotal, appliedDiscount, total, language, onDiscountChange }: { discount: string; discountError?: string; subtotal: number; appliedDiscount: number; total: number; language: Settings['language']; onDiscountChange: (value: string) => void }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language);
  return <View style={styles.totals}><AppInput label={copy.sales.discount} value={discount} onChangeText={onDiscountChange} error={discountError} placeholder="0" keyboardType="decimal-pad" accessibilityLabel={copy.sales.discountAccessibility} rtl={rtl} trailing={<View style={[styles.currencyAffix, { backgroundColor: colors.surfaceSecondary }]}><Text style={[typography.label, { color: colors.textSecondary }]}>{copy.common.syp}</Text></View>} /><CartTotalRow label={copy.sales.subtotal} value={subtotal} language={language} /><CartTotalRow label={copy.sales.discount} value={appliedDiscount} language={language} negative={appliedDiscount > 0} /><View style={[styles.netTotal, { borderTopColor: colors.border }]}><CartTotalRow label={copy.sales.total} value={total} language={language} strong /></View></View>;
}

function CartTotalRow({ label, value, language, negative = false, strong = false }: { label: string; value: number; language: Settings['language']; negative?: boolean; strong?: boolean }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language);
  return <View style={[styles.totalRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Text style={[strong ? typography.title : typography.body, { color: strong ? colors.textPrimary : colors.textSecondary }]}>{label}</Text><View style={[styles.totalMoneyWrap, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>{negative && <Text style={[typography.bodyMedium, { color: colors.danger }]}>−</Text>}<MonetaryValue value={value} language={language} currencyLabel={copy.common.syp} inline style={[styles.totalMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={[strong ? styles.totalStrongText : styles.totalText, negative && !strong && { color: colors.danger }]} /></View></View>;
}

export function SaleSuccess({ sale, language, bottomNavigationInset, sharing, onShare, onNewSale }: { sale: Sale; language: Settings['language']; bottomNavigationInset: number; sharing: boolean; onShare: (sale: Sale) => void; onNewSale: () => void }) {
  const { colors } = useAppTheme(); const copy = uiText(language);
  return <Animated.View entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)} style={[styles.success, { paddingBottom: bottomNavigationInset + spacing.lg }]}><View style={styles.successCore}><View style={[styles.successIcon, { backgroundColor: colors.successSoft }]}><Feather name="check" size={30} color={colors.success} /></View><Text style={[typography.titleLarge, { color: colors.textPrimary, textAlign: 'center' }]}>{copy.sales.completed}</Text><MonetaryValue value={sale.net_total_syp} language={language} currencyLabel={copy.common.syp} compact={false} /><View style={styles.invoiceIdentity}><Text style={[typography.caption, { color: colors.textMuted, textAlign: 'center' }]}>{copy.sales.invoiceNumber}</Text><Text selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[typography.bodyMedium, styles.successInvoiceNumber, { color: colors.textPrimary, textAlign: 'center', writingDirection: 'ltr' }]}>#{sale.invoice_number}</Text></View></View><View style={styles.successActions}><AppButton label={copy.sales.shareInvoice} icon="share-2" onPress={() => onShare(sale)} loading={sharing} variant="secondary" style={styles.fullButton} /><AppButton label={copy.sales.newSaleAction} icon="plus" onPress={onNewSale} disabled={sharing} style={styles.fullButton} /></View></Animated.View>;
}

type InvoiceFilter = 'all' | 'today' | 'week' | 'month';
export const INVOICE_ROW_HEIGHT = 84;

export function InvoiceHistory({ sales, language, bottomNavigationInset, selectedSale, sharingSaleId, onSelect, onCloseDetails, onShare }: { sales: Sale[]; language: Settings['language']; bottomNavigationInset: number; selectedSale: Sale | null; sharingSaleId: number | null; onSelect: (sale: Sale) => void; onCloseDetails: () => void; onShare: (sale: Sale) => void }) {
  const rtl = language === 'ar';
  const copy = uiText(language);
  const [filter, setFilter] = useState<InvoiceFilter>('all');
  const filtered = useMemo(() => sales.filter(sale => invoiceMatchesFilter(sale, filter)), [filter, sales]);
  const renderItem = useCallback(({ item }: { item: Sale }) => <InvoiceRow sale={item} language={language} onPress={onSelect} />, [language, onSelect]);
  const filters: { value: InvoiceFilter; label: string }[] = [{ value: 'all', label: copy.common.all }, { value: 'today', label: copy.sales.today }, { value: 'week', label: copy.sales.thisWeek }, { value: 'month', label: copy.sales.thisMonth }];
  return <View style={styles.flex}><View style={styles.invoiceFilters}><SegmentedControl options={filters} value={filter} onChange={setFilter} rtl={rtl} subtle compactLabels accessibilityLabel={copy.sales.historyPeriod} /></View><FlatList style={styles.flex} data={filtered} keyExtractor={sale => String(sale.id)} renderItem={renderItem} ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />} contentContainerStyle={[styles.invoiceList, { paddingBottom: bottomNavigationInset + spacing.md }, filtered.length === 0 && styles.grow]} initialNumToRender={14} maxToRenderPerBatch={14} updateCellsBatchingPeriod={40} windowSize={7} removeClippedSubviews getItemLayout={(_, index) => ({ length: INVOICE_ROW_HEIGHT + spacing.xs, offset: (INVOICE_ROW_HEIGHT + spacing.xs) * index, index })} ListEmptyComponent={<EmptyState icon="file-text" title={copy.sales.noInvoices} description={copy.sales.noInvoicesDescription} />} /><InvoiceDetailsSheet sale={selectedSale} language={language} sharing={selectedSale?.id === sharingSaleId} onClose={onCloseDetails} onShare={onShare} /></View>;
}

const InvoiceRow = memo(function InvoiceRow({ sale, language, onPress }: { sale: Sale; language: Settings['language']; onPress: (sale: Sale) => void }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language);
  const count = sale.items.reduce((sum, item) => sum + item.quantity, 0);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${sale.invoice_number}, ${formatNumber(sale.net_total_syp, language)} ${copy.common.sypLong}`} accessibilityHint={copy.sales.invoiceDetailsHint} onPress={() => onPress(sale)} style={({ pressed }) => [styles.invoiceRow, { backgroundColor: colors.surface, borderColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }, pressed && styles.pressed]}><View style={styles.invoiceCopy}><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[typography.bodyMedium, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left', writingDirection: 'ltr' }]}>#{sale.invoice_number}</Text><Text numberOfLines={1} style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{formatInvoiceDate(sale.created_at, language)} • {copy.sales.cartCount(formatNumber(count, language))}</Text></View><MonetaryValue value={sale.net_total_syp} language={language} currencyLabel={copy.common.syp} inline style={[styles.invoiceMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={styles.invoiceMoneyText} /><Feather name={rtl ? 'chevron-left' : 'chevron-right'} size={20} color={colors.textMuted} /></Pressable>;
});

function InvoiceDetailsSheet({ sale, language, sharing, onClose, onShare }: { sale: Sale | null; language: Settings['language']; sharing: boolean; onClose: () => void; onShare: (sale: Sale) => void }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language);
  if (!sale) return null;
  return <BottomSheet visible onClose={sharing ? () => undefined : onClose} title={`#${sale.invoice_number}`} rtl={rtl} scrollable><View style={styles.invoiceDetails}><View style={[styles.snapshotMeta, { backgroundColor: colors.surfaceSecondary }]}><Text style={[typography.bodyMedium, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{formatInvoiceDate(sale.created_at, language, true)}</Text><Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.savedRate(formatNumber(sale.exchange_rate, language))}</Text></View><Text style={[typography.title, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.products}</Text>{sale.items.map(item => <View key={item.id} style={[styles.snapshotItem, { borderBottomColor: colors.border }]}><View style={[styles.snapshotLine, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Text numberOfLines={1} style={[typography.bodyMedium, styles.snapshotName, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{item.product_name}</Text><Text style={[typography.label, styles.quantityTechnical, { color: colors.textSecondary }]}>{formatNumber(item.quantity, language)} ×</Text><MonetaryValue value={item.line_total_syp} language={language} currencyLabel={copy.common.syp} inline style={[styles.snapshotMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={styles.snapshotMoneyText} /></View><Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.savedPriceCost(formatNumber(item.unit_price_syp, language), formatNumber(item.unit_cost_syp, language))}</Text></View>)}<View style={styles.detailsTotals}><CartTotalRow label={copy.sales.subtotal} value={sale.subtotal_syp} language={language} /><CartTotalRow label={copy.sales.discount} value={sale.discount_syp} language={language} negative={sale.discount_syp > 0} /><View style={[styles.netTotal, { borderTopColor: colors.border }]}><CartTotalRow label={copy.sales.total} value={sale.net_total_syp} language={language} strong /></View></View><AppButton label={copy.sales.sharePdf} icon="share-2" onPress={() => onShare(sale)} loading={sharing} style={styles.fullButton} /></View></BottomSheet>;
}

export const EXPENSE_ROW_HEIGHT = 76;

export function ExpensesView({ expenses, language, bottomNavigationInset, onCreateExpense }: { expenses: Expense[]; language: Settings['language']; bottomNavigationInset: number; onCreateExpense: (description: string, amount: number) => Promise<void> }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language); const [open, setOpen] = useState(false);
  const renderItem = useCallback(({ item }: { item: Expense }) => <ExpenseRow expense={item} language={language} />, [language]);
  return <View style={styles.flex}><View style={[styles.expenseHeader, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><View style={styles.flex}><Text style={[typography.title, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.expenses}</Text>{expenses.length > 0 && <Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.expensesCount(formatNumber(expenses.length, language))}</Text>}</View><AppButton label={copy.sales.addExpense} icon="plus" onPress={() => setOpen(true)} accessibilityHint={copy.sales.addExpenseHint} style={styles.addExpenseButton} /></View><FlatList style={styles.flex} data={expenses} keyExtractor={item => String(item.id)} renderItem={renderItem} ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />} contentContainerStyle={[styles.expenseList, { paddingBottom: bottomNavigationInset + spacing.md }, expenses.length === 0 && styles.grow]} initialNumToRender={14} maxToRenderPerBatch={14} updateCellsBatchingPeriod={40} windowSize={7} removeClippedSubviews getItemLayout={(_, index) => ({ length: EXPENSE_ROW_HEIGHT + spacing.xs, offset: (EXPENSE_ROW_HEIGHT + spacing.xs) * index, index })} ListEmptyComponent={<EmptyState icon="minus-circle" title={copy.sales.noExpenses} description={copy.sales.noExpensesDescription} />} /><ExpenseFormSheet visible={open} language={language} onClose={() => setOpen(false)} onSave={onCreateExpense} /></View>;
}

const ExpenseRow = memo(function ExpenseRow({ expense, language }: { expense: Expense; language: Settings['language'] }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language);
  return <View style={[styles.expenseRow, { backgroundColor: colors.surface, borderColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }]}><View style={[styles.expenseIcon, { backgroundColor: colors.surfaceSecondary }]}><Feather name="minus" size={18} color={colors.textSecondary} /></View><View style={styles.flex}><Text numberOfLines={1} style={[typography.bodyMedium, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{expense.description}</Text><Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{formatInvoiceDate(expense.created_at, language)}</Text></View><MonetaryValue value={expense.amount_syp} language={language} currencyLabel={copy.common.syp} inline style={[styles.expenseMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={styles.expenseMoneyText} /></View>;
});

function ExpenseFormSheet({ visible, language, onClose, onSave }: { visible: boolean; language: Settings['language']; onClose: () => void; onSave: (description: string, amount: number) => Promise<void> }) {
  const rtl = language === 'ar'; const copy = uiText(language); const [amount, setAmount] = useState(''); const [description, setDescription] = useState(''); const [amountError, setAmountError] = useState<string>(); const [descriptionError, setDescriptionError] = useState<string>(); const [saving, setSaving] = useState(false); const savingRef = useRef(false);
  useEffect(() => { if (visible) { setAmount(''); setDescription(''); setAmountError(undefined); setDescriptionError(undefined); } }, [visible]);
  const submit = async () => {
    const numeric = parseLocalizedNumber(amount); const nextAmountError = !amount.trim() || !Number.isFinite(numeric) || numeric <= 0 ? copy.sales.invalidExpenseAmount : undefined; const nextDescriptionError = !description.trim() ? copy.sales.expenseDescriptionRequired : undefined;
    setAmountError(nextAmountError); setDescriptionError(nextDescriptionError); if (nextAmountError || nextDescriptionError || savingRef.current) return;
    savingRef.current = true; setSaving(true); try { await onSave(description.trim(), numeric); Keyboard.dismiss(); requestAnimationFrame(onClose); } catch { /* Parent reports the persistence error through the shared Snackbar. */ } finally { savingRef.current = false; setSaving(false); }
  };
  return <BottomSheet visible={visible} onClose={saving ? () => undefined : onClose} title={copy.sales.addExpense} rtl={rtl} keyboardAware><View style={styles.expenseForm}><AppInput label={copy.sales.amount} value={amount} onChangeText={value => { setAmount(value); setAmountError(undefined); }} error={amountError} placeholder="0" keyboardType="decimal-pad" accessibilityLabel={copy.sales.expenseAmountAccessibility} rtl={rtl} /><AppInput label={copy.sales.description} value={description} onChangeText={value => { setDescription(value); setDescriptionError(undefined); }} error={descriptionError} placeholder={copy.sales.descriptionExample} accessibilityLabel={copy.sales.expenseDescriptionAccessibility} rtl={rtl} returnKeyType="done" onSubmitEditing={() => void submit()} /><AppButton label={saving ? copy.productForm.saving : copy.sales.saveExpense} icon="check" onPress={() => void submit()} loading={saving} style={styles.fullButton} /></View></BottomSheet>;
}

function invoiceMatchesFilter(sale: Sale, filter: InvoiceFilter) {
  if (filter === 'all') return true;
  const date = new Date(sale.created_at); const now = new Date(); const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (filter === 'week') { const day = start.getDay(); start.setDate(start.getDate() - (day === 0 ? 6 : day - 1)); }
  if (filter === 'month') start.setDate(1);
  return date.getTime() >= start.getTime();
}

function formatInvoiceDate(value: string, language: Settings['language'], full = false) {
  const date = new Date(value); const locale = language === 'ar' ? 'ar-SY' : 'en-US'; const today = new Date(); const sameDay = date.toDateString() === today.toDateString(); const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (!full && sameDay) return `${uiText(language).sales.today} • ${time}`;
  return date.toLocaleString(locale, full ? { dateStyle: 'medium', timeStyle: 'short' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, grow: { flexGrow: 1, justifyContent: 'center' }, pressed: { opacity: 0.76, transform: [{ scale: 0.99 }] }, fullButton: { width: '100%' },
  searchSurface: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.xs, gap: spacing.xxs }, resultCaption: { alignItems: 'center', gap: spacing.xxs },
  cartSummary: { position: 'absolute', left: 0, right: 0, minHeight: 70, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, alignItems: 'center', gap: spacing.sm }, cartSummaryCopy: { minWidth: 0, flex: 1 }, summaryMoney: { justifyContent: 'flex-start' }, summaryMoneyText: { ...typography.titleLarge, fontSize: 20, lineHeight: 26 }, reviewButton: { minWidth: 132 },
  reviewPage: { flex: 1 }, reviewHeader: { minHeight: 66, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center', gap: spacing.sm }, reviewFooter: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: StyleSheet.hairlineWidth }, reviewFooterAction: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  cartLine: { height: CART_LINE_HEIGHT, paddingVertical: spacing.xxs, alignItems: 'center', gap: spacing.sm }, cartLineCopy: { minWidth: 0, flex: 1 }, cartLineActions: { alignItems: 'center', gap: spacing.xxs }, removeCartLine: { backgroundColor: 'transparent' }, lineMoney: { justifyContent: 'flex-start' }, lineMoneyText: { ...typography.numericEmphasis }, lineSeparator: { height: StyleSheet.hairlineWidth },
  totals: { paddingTop: spacing.md, paddingBottom: spacing.xs, gap: spacing.sm }, currencyAffix: { minHeight: 32, paddingHorizontal: spacing.xs, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' }, totalRow: { minHeight: 36, alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }, totalMoneyWrap: { alignItems: 'center', gap: spacing.xxs }, totalMoney: { justifyContent: 'flex-end' }, totalText: { ...typography.numericCompact }, totalStrongText: { ...typography.numericTotal }, netTotal: { paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
  success: { flex: 1, paddingHorizontal: spacing.xl, paddingTop: spacing.lg, alignItems: 'center', justifyContent: 'space-evenly', gap: spacing.lg }, successCore: { alignItems: 'center', gap: spacing.sm }, successIcon: { width: 58, height: 58, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' }, invoiceIdentity: { gap: 0, alignItems: 'center' }, successInvoiceNumber: { maxWidth: 280 }, successActions: { width: '100%', gap: spacing.xs },
  invoiceFilters: { height: 52, paddingHorizontal: spacing.md, paddingVertical: spacing.xxs }, invoiceList: { paddingHorizontal: spacing.md, paddingTop: spacing.xxs }, invoiceRow: { height: INVOICE_ROW_HEIGHT, paddingHorizontal: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, alignItems: 'center', gap: spacing.xs }, invoiceCopy: { minWidth: 0, flex: 1 }, invoiceMoney: { width: 116, justifyContent: 'flex-end' }, invoiceMoneyText: { ...typography.numericCompact },
  invoiceDetails: { paddingBottom: spacing.xs, gap: spacing.sm }, snapshotMeta: { padding: spacing.sm, borderRadius: radius.md, gap: spacing.xxs }, snapshotItem: { paddingVertical: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, gap: spacing.xxs }, snapshotLine: { alignItems: 'center', gap: spacing.xs }, snapshotName: { minWidth: 0, flex: 1 }, quantityTechnical: { writingDirection: 'ltr' }, snapshotMoney: { width: 116, justifyContent: 'flex-end' }, snapshotMoneyText: { ...typography.numericSmall }, detailsTotals: { paddingTop: spacing.xs, gap: spacing.xs },
  expenseHeader: { minHeight: 60, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, alignItems: 'center', gap: spacing.sm }, addExpenseButton: { minWidth: 126 }, expenseList: { paddingHorizontal: spacing.md, paddingTop: spacing.xs }, expenseRow: { height: EXPENSE_ROW_HEIGHT, paddingHorizontal: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, alignItems: 'center', gap: spacing.xs }, expenseIcon: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }, expenseMoney: { width: 116, justifyContent: 'flex-end' }, expenseMoneyText: { ...typography.numericCompact }, expenseForm: { paddingBottom: spacing.xs, gap: spacing.sm },
});
