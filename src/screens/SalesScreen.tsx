import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { CartReviewModal, CartLine, ExpensesView, InvoiceHistory, NewSaleView } from '@/components/sales/SalesViews';
import { SuspendedSalesView } from '@/components/sales/SuspendedSalesView';
import { AnalyticsDashboard } from '@/components/analytics/AnalyticsDashboard';
import { AppButton, ConfirmSheet, MonetaryValue, ScreenContainer, SegmentedControl, useSnackbar } from '@/components/ui';
import { useAppStore } from '@/store/useAppStore';
import { Product, Sale, SuspendedSaleSummary } from '@/types';
import { spacing, typography, useAppTheme } from '@/theme';
import { calculateSypPrice } from '@/utils/priceCalculator';
import { formatNumber } from '@/utils/formatters';
import { shareInvoicePdf } from '@/utils/invoice';
import { haptics } from '@/utils/haptics';
import { addCartLine, calculateCartSubtotal, calculatePayment, changeCartLineQuantity, clampCartDiscount, parseLocalizedNumber, setCartLineQuantity } from '@/utils/salesUiState';
import { uiText } from '@/i18n';
import { BarcodeScannerScreen } from '@/components/barcode/BarcodeScannerScreen';
import { ProductFormModal } from '@/components/ProductFormModal';
import { createProductBarcodeMap, findProductByExactBarcode } from '@/utils/barcode';
import { buildRepeatedSaleCart } from '@/utils/repeatSale';
import { ReturnFlowScreen } from '@/components/sales/ReturnFlowScreen';
import { shareReturnReceiptPdf } from '@/utils/returnReceipt';

type SalesSection = 'sale' | 'suspended' | 'invoices' | 'expenses' | 'analytics';

export function SalesScreen({ bottomNavigationInset = 0 }: { bottomNavigationInset?: number }) {
  const state = useAppStore();
  const { colors } = useAppTheme();
  const snackbar = useSnackbar();
  const rtl = state.language === 'ar';
  const copy = uiText(state.language);
  const [section, setSection] = useState<SalesSection>('sale');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState('');
  const [amountPaid, setAmountPaid] = useState('');
  const [exactPayment, setExactPayment] = useState(true);
  const [cartExchangeRate, setCartExchangeRate] = useState<number | null>(null);
  const [activeDraftId, setActiveDraftId] = useState<number | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [suspendConfirmOpen, setSuspendConfirmOpen] = useState(false);
  const [draftToResume, setDraftToResume] = useState<SuspendedSaleSummary | null>(null);
  const [draftToDelete, setDraftToDelete] = useState<SuspendedSaleSummary | null>(null);
  const [saleToRepeat, setSaleToRepeat] = useState<Sale | null>(null);
  const [draftBusyId, setDraftBusyId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [completedSale, setCompletedSale] = useState<Sale | null>(null);
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [sharingSaleId, setSharingSaleId] = useState<number | null>(null);
  const [returnSale, setReturnSale] = useState<Sale | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [unknownProductBarcode, setUnknownProductBarcode] = useState<string | null>(null);
  const savingRef = useRef(false);
  const sharingRef = useRef(false);
  const invoiceOpeningRef = useRef(false);
  const expenseSavingRef = useRef(false);

  const settings = useMemo(() => ({ exchangeRate: state.exchangeRate, isRoundingEnabled: state.isRoundingEnabled, roundingTarget: state.roundingTarget, language: state.language }), [state.exchangeRate, state.isRoundingEnabled, state.language, state.roundingTarget]);
  const subtotal = useMemo(() => calculateCartSubtotal(cart), [cart]);
  const parsedDiscount = useMemo(() => parseLocalizedNumber(discount), [discount]);
  const appliedDiscount = clampCartDiscount(parsedDiscount, subtotal);
  const total = subtotal - appliedDiscount;
  const payment = useMemo(() => calculatePayment(total, amountPaid, exactPayment), [amountPaid, exactPayment, total]);
  const cartItemCount = useMemo(() => cart.reduce((sum, line) => sum + line.quantity, 0), [cart]);
  const productsByBarcode = useMemo(() => createProductBarcodeMap(state.products), [state.products]);
  const visibleSuspendedSales = useMemo(() => state.suspendedSales.filter(draft => draft.id !== activeDraftId), [activeDraftId, state.suspendedSales]);
  const discountError = useMemo(() => {
    if (!discount.trim()) return undefined;
    if (!Number.isFinite(parsedDiscount)) return copy.sales.invalidDiscount;
    if (parsedDiscount < 0) return copy.sales.negativeDiscount;
    if (parsedDiscount > subtotal) return copy.sales.maximumDiscount(formatNumber(subtotal, state.language));
    return undefined;
  }, [copy.sales, discount, parsedDiscount, state.language, subtotal]);

  const addProduct = useCallback((product: Product) => {
    haptics.tap();
    setCompletedSale(null);
    const rate = cartExchangeRate ?? state.exchangeRate;
    if (cartExchangeRate == null) setCartExchangeRate(rate);
    setCart(current => addCartLine(current, {
        productId: product.id,
        cartKey: `product:${product.id}`,
        productName: product.name,
        barcodeSnapshot: product.barcode,
        isAvailable: product.is_active !== 0,
        quantity: 1,
        unitPriceSyp: calculateSypPrice({ priceUsd: product.price_usd, exchangeRate: rate, isRoundingEnabled: settings.isRoundingEnabled, roundingTarget: settings.roundingTarget }),
        unitCostSyp: product.cost_usd * rate,
      }));
  }, [cartExchangeRate, settings.isRoundingEnabled, settings.roundingTarget, state.exchangeRate]);

  const setQuantity = useCallback((key: string | number, quantity: number) => {
    setCart(current => setCartLineQuantity(current, key, quantity));
  }, []);

  const changeQuantity = useCallback((key: string | number, delta: number) => {
    setCart(current => changeCartLineQuantity(current, key, delta));
  }, []);

  const requestComplete = useCallback(() => {
    if (!cart.length || discountError || !payment.valid || cart.some(line => !line.isAvailable) || savingRef.current) return;
    haptics.warning();
    setConfirmOpen(true);
  }, [cart, discountError, payment.valid]);

  const completeSale = async () => {
    if (!cart.length || discountError || !payment.valid || cart.some(line => !line.isAvailable) || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const sale = await state.completeSale(cart, appliedDiscount, payment.amountPaidSyp, cartExchangeRate ?? state.exchangeRate, activeDraftId ?? undefined);
      setCart([]);
      setDiscount('');
      setAmountPaid(''); setExactPayment(true); setCartExchangeRate(null); setActiveDraftId(null);
      setReviewOpen(false);
      setConfirmOpen(false);
      setCompletedSale(sale);
      setSection('sale');
      haptics.success();
    } catch (error) {
      if (__DEV__) console.error('[SaleCompletionFailed]', error);
      haptics.error();
      snackbar.show({ text: copy.sales.saleFailed, tone: 'error', duration: 4800 });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const suspendCurrentSale = async () => {
    if (!cart.length || savingRef.current) return;
    savingRef.current = true; setSaving(true);
    try {
      await state.suspendSale(cart, appliedDiscount, cartExchangeRate ?? state.exchangeRate, activeDraftId ?? undefined);
      setCart([]); setDiscount(''); setAmountPaid(''); setExactPayment(true); setCartExchangeRate(null); setActiveDraftId(null);
      setReviewOpen(false); setSuspendConfirmOpen(false); setCompletedSale(null);
      haptics.success(); snackbar.show({ text: copy.sales.suspendedDone, tone: 'success' });
    } catch (error) {
      if (__DEV__) console.error('[SaleSuspendFailed]', error);
      snackbar.show({ text: copy.sales.suspendFailed, tone: 'error' });
    } finally { savingRef.current = false; setSaving(false); }
  };

  const loadDraftIntoCart = useCallback(async (draft: SuspendedSaleSummary, suspendCurrent: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true; setDraftBusyId(draft.id);
    try {
      const full = await state.getSuspendedSale(draft.id);
      if (!full) throw new Error('DRAFT_NOT_FOUND');
      if (suspendCurrent && cart.length) await state.suspendSale(cart, appliedDiscount, cartExchangeRate ?? state.exchangeRate, activeDraftId ?? undefined);
      const products = new Map(state.products.map(product => [product.id, product]));
      const restored: CartLine[] = full.items.map(item => {
        const product = item.product_id == null ? undefined : products.get(item.product_id);
        return { productId: item.product_id, cartKey: item.product_id == null ? `draft:${item.uuid}` : `product:${item.product_id}`, productName: item.product_name, barcodeSnapshot: item.barcode_snapshot, quantity: item.quantity, unitPriceSyp: item.unit_price_syp, unitCostSyp: item.unit_cost_syp, isAvailable: Boolean(product && product.is_active !== 0) };
      });
      setCart(restored); setDiscount(full.discount_syp ? String(full.discount_syp) : ''); setAmountPaid(''); setExactPayment(true);
      setCartExchangeRate(full.exchange_rate); setActiveDraftId(full.id); setCompletedSale(null); setSection('sale'); setReviewOpen(true); setDraftToResume(null);
      haptics.success();
    } catch (error) {
      if (__DEV__) console.error('[DraftResumeFailed]', error);
      snackbar.show({ text: copy.sales.resumeFailed, tone: 'error' });
    } finally { savingRef.current = false; setDraftBusyId(null); }
  }, [activeDraftId, appliedDiscount, cart, cartExchangeRate, copy.sales.resumeFailed, snackbar, state]);

  const deleteDraft = useCallback(async () => {
    if (!draftToDelete) return;
    setDraftBusyId(draftToDelete.id);
    try { await state.deleteSuspendedSale(draftToDelete.id); setDraftToDelete(null); snackbar.show({ text: copy.sales.draftDeleted, tone: 'success' }); }
    catch (error) { if (__DEV__) console.error('[DraftDeleteFailed]', error); snackbar.show({ text: copy.sales.deleteFailed, tone: 'error' }); }
    finally { setDraftBusyId(null); }
  }, [copy.sales.deleteFailed, copy.sales.draftDeleted, draftToDelete, snackbar, state]);

  const repeatSale = useCallback((sale: Sale) => {
    const result = buildRepeatedSaleCart(cart, sale, state.products, settings);
    const wasEmpty = cart.length === 0;
    setCart(result.cart); if (wasEmpty) { setDiscount(''); setCartExchangeRate(state.exchangeRate); setActiveDraftId(null); }
    setAmountPaid(''); setExactPayment(true); setCompletedSale(null); setSelectedSale(null); setSaleToRepeat(null); setSection('sale');
    snackbar.show({ text: result.unavailableNames.length ? copy.sales.repeatSummary(formatNumber(result.addedProducts, state.language), formatNumber(result.unavailableNames.length, state.language), result.unavailableNames.slice(0, 2).join('، ')) : copy.sales.repeatAllAdded(formatNumber(result.addedProducts, state.language)), tone: result.unavailableNames.length ? 'info' : 'success' });
  }, [cart, copy.sales, settings, snackbar, state.exchangeRate, state.language, state.products]);

  const shareSale = useCallback(async (sale: Sale) => {
    if (sharingRef.current) return;
    sharingRef.current = true;
    setSharingSaleId(sale.id);
    try {
      await shareInvoicePdf(sale, state.language);
      haptics.success();
      snackbar.show({ text: copy.sales.invoicePrepared, tone: 'success' });
    } catch (error) {
      if (__DEV__) console.error('[InvoiceShareFailed]', error);
      haptics.error();
      snackbar.show({ text: copy.sales.invoicePrepareFailed, tone: 'error' });
    } finally {
      sharingRef.current = false;
      setSharingSaleId(null);
    }
  }, [copy.sales.invoicePrepareFailed, copy.sales.invoicePrepared, snackbar, state.language]);

  const openInvoice = useCallback(async (sale: Sale) => {
    if (invoiceOpeningRef.current) return;
    invoiceOpeningRef.current = true;
    try {
      const details = await state.getInvoiceDetails(sale.id);
      if (!details) throw new Error('SALE_NOT_FOUND');
      setSelectedSale(details);
    } catch (error) {
      if (__DEV__) console.error('[InvoiceDetailsLoadFailed]', error);
      snackbar.show({ text: copy.sales.invoiceLoadFailed, tone: 'error' });
    } finally { invoiceOpeningRef.current = false; }
  }, [copy.sales.invoiceLoadFailed, snackbar, state]);

  const createExpense = useCallback(async (description: string, amount: number) => {
    if (expenseSavingRef.current) return;
    expenseSavingRef.current = true;
    try {
      await state.createExpense(description, amount);
      haptics.success();
      snackbar.show({ text: copy.sales.expenseRecorded, tone: 'success' });
    } catch (error) {
      if (__DEV__) console.error('[ExpenseCreationFailed]', error);
      haptics.error();
      snackbar.show({ text: copy.sales.expenseFailed, tone: 'error' });
      throw error;
    } finally { expenseSavingRef.current = false; }
  }, [copy.sales.expenseFailed, copy.sales.expenseRecorded, snackbar, state]);

  const createReturn = useCallback(async (saleId: number, selections: import('@/types').ReturnSelection[]) => {
    try { const record = await state.createReturn(saleId, selections); haptics.success(); snackbar.show({ text: copy.sales.returnRecorded, tone: 'success' }); return record; }
    catch (error) { if (__DEV__) console.error('[ReturnCreationFailed]', error); haptics.error(); snackbar.show({ text: copy.sales.returnFailed, tone: 'error' }); throw error; }
  }, [copy.sales.returnFailed, copy.sales.returnRecorded, snackbar, state]);

  const shareReturn = useCallback(async (record: import('@/types').SaleReturn, sale: Sale) => {
    try { await shareReturnReceiptPdf(record, sale, state.language); snackbar.show({ text: copy.sales.returnPrepared, tone: 'success' }); }
    catch (error) { if (__DEV__) console.error('[ReturnReceiptFailed]', error); snackbar.show({ text: copy.sales.returnPrepareFailed, tone: 'error' }); }
  }, [copy.sales.returnPrepareFailed, copy.sales.returnPrepared, snackbar, state.language]);

  const sectionOptions = [{ value: 'sale' as const, label: copy.sales.newSale }, { value: 'invoices' as const, label: copy.sales.invoices }, { value: 'expenses' as const, label: copy.sales.expenses }, { value: 'analytics' as const, label: copy.sales.analytics }];

  return <ScreenContainer>
    <View style={styles.page}>
      <View style={[styles.header, { backgroundColor: colors.surfaceSecondary }]}><View style={[styles.titleRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><View style={styles.titleCopy}><Text style={[typography.titleLarge, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.title}</Text><Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.subtitle}</Text></View><AppButton label={`${copy.sales.suspendedSales}${visibleSuspendedSales.length ? ` (${formatNumber(visibleSuspendedSales.length, state.language)})` : ''}`} icon="pause" variant={section === 'suspended' ? 'primary' : 'secondary'} onPress={() => setSection('suspended')} style={styles.suspendedButton} /></View><SegmentedControl value={section} onChange={setSection} options={sectionOptions} rtl={rtl} subtle compactLabels accessibilityLabel={copy.sales.sections} /></View>
      <Animated.View key={section} entering={FadeIn.duration(170).reduceMotion(ReduceMotion.System)} style={styles.content}>
        {section === 'sale' && <NewSaleView products={state.products} settings={settings} cart={cart} completedSale={completedSale} bottomNavigationInset={bottomNavigationInset} sharing={completedSale?.id === sharingSaleId} onAdd={addProduct} onQuantityChange={(id, quantity) => setQuantity(id, quantity)} onQuantityDelta={(id, delta) => changeQuantity(id, delta)} onReviewCart={() => setReviewOpen(true)} onNewSale={() => setCompletedSale(null)} onShare={sale => void shareSale(sale)} onViewDetails={sale => { setSelectedSale(sale); setSection('invoices'); }} onOpenScanner={() => setScannerOpen(true)} />}
        {section === 'suspended' && <SuspendedSalesView drafts={visibleSuspendedSales} language={state.language} bottomNavigationInset={bottomNavigationInset} busyId={draftBusyId} onResume={draft => { if (cart.length) setDraftToResume(draft); else void loadDraftIntoCart(draft, false); }} onDelete={setDraftToDelete} />}
        {section === 'invoices' && <InvoiceHistory language={state.language} bottomNavigationInset={bottomNavigationInset} selectedSale={selectedSale} sharingSaleId={sharingSaleId} revision={state.sales.reduce((sum, sale) => sum + (sale.returns?.length ?? 0), 0)} queryInvoices={state.queryInvoices} onSelect={sale => void openInvoice(sale)} onCloseDetails={() => setSelectedSale(null)} onShare={sale => void shareSale(sale)} onReturn={sale => { setSelectedSale(null); setReturnSale(sale); }} onRepeat={sale => { if (cart.length) setSaleToRepeat(sale); else repeatSale(sale); }} />}
        {section === 'expenses' && <ExpensesView expenses={state.expenses} language={state.language} bottomNavigationInset={bottomNavigationInset} onCreateExpense={createExpense} />}
        {section === 'analytics' && <AnalyticsDashboard sales={state.sales} expenses={state.expenses} language={state.language} bottomNavigationInset={bottomNavigationInset} />}
      </Animated.View>
    </View>
    <CartReviewModal visible={reviewOpen} cart={cart} discount={discount} discountError={discountError} subtotal={subtotal} appliedDiscount={appliedDiscount} total={total} amountPaid={amountPaid} exactPayment={exactPayment} payment={payment} language={state.language} saving={saving} draftRate={activeDraftId == null ? null : cartExchangeRate} currentRate={state.exchangeRate} onClose={() => setReviewOpen(false)} onDiscountChange={setDiscount} onAmountPaidChange={value => { setExactPayment(false); setAmountPaid(value); }} onExactPayment={() => { setExactPayment(true); setAmountPaid(''); }} onPaymentSuggestion={value => { setExactPayment(false); setAmountPaid(String(value)); }} onQuantityChange={setQuantity} onQuantityDelta={changeQuantity} onRequestComplete={requestComplete} onRequestSuspend={() => setSuspendConfirmOpen(true)} />
    <ConfirmSheet visible={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={() => void completeSale()} title={copy.sales.completeTitle} description={copy.sales.itemsLabel(formatNumber(cartItemCount, state.language))} confirmLabel={copy.sales.completeSale} cancelLabel={copy.sales.review} loading={saving} rtl={rtl} icon="check-circle" tone="success"><MonetaryValue value={total} language={state.language} currencyLabel={copy.common.syp} compact={false} /></ConfirmSheet>
    <ConfirmSheet visible={suspendConfirmOpen} onClose={() => setSuspendConfirmOpen(false)} onConfirm={() => void suspendCurrentSale()} title={copy.sales.suspendTitle} description={copy.sales.suspendDescription} confirmLabel={copy.sales.suspendSale} cancelLabel={copy.common.cancel} loading={saving} rtl={rtl} icon="pause-circle" tone="warning" />
    <ConfirmSheet visible={draftToResume !== null} onClose={() => setDraftToResume(null)} onConfirm={() => { if (draftToResume) void loadDraftIntoCart(draftToResume, true); }} title={copy.sales.currentSaleExists} description={copy.sales.suspendDescription} confirmLabel={copy.sales.holdCurrentAndResume} cancelLabel={copy.common.cancel} loading={draftBusyId !== null} rtl={rtl} icon="repeat" tone="warning" />
    <ConfirmSheet visible={draftToDelete !== null} onClose={() => setDraftToDelete(null)} onConfirm={() => void deleteDraft()} title={copy.sales.deleteDraftTitle} description={copy.sales.deleteDraftDescription} confirmLabel={copy.sales.deleteDraft} cancelLabel={copy.common.cancel} loading={draftBusyId !== null} rtl={rtl} isDestructive />
    <ConfirmSheet visible={saleToRepeat !== null} onClose={() => setSaleToRepeat(null)} onConfirm={() => { if (saleToRepeat) repeatSale(saleToRepeat); }} title={copy.sales.repeatCurrentCartTitle} description={copy.sales.repeatCurrentCartDescription} confirmLabel={copy.sales.addToCurrentCart} cancelLabel={copy.common.cancel} rtl={rtl} icon="repeat" />
    <BarcodeScannerScreen visible={scannerOpen} mode="cashier" language={state.language} onClose={() => setScannerOpen(false)} cartItemCount={formatNumber(cartItemCount, state.language)} cartTotal={total} onAddUnknown={barcode => { setScannerOpen(false); setUnknownProductBarcode(barcode); }} onScan={barcode => {
      const product = findProductByExactBarcode(productsByBarcode, barcode);
      if (!product) return { kind: 'unknown', barcode };
      if (product.is_active === 0) return { kind: 'inactive', title: product.name };
      const nextQuantity = Math.min(999, (cart.find(line => line.productId === product.id)?.quantity ?? 0) + 1);
      const rate = cartExchangeRate ?? settings.exchangeRate;
      const amount = calculateSypPrice({ priceUsd: product.price_usd, exchangeRate: rate, isRoundingEnabled: settings.isRoundingEnabled, roundingTarget: settings.roundingTarget });
      addProduct(product);
      return { kind: 'success', title: product.name, quantity: formatNumber(nextQuantity, state.language), amount };
    }} />
    <ProductFormModal visible={unknownProductBarcode !== null} product={null} mode="create" initialSection="identity" initialBarcode={unknownProductBarcode ?? undefined} onClose={() => setUnknownProductBarcode(null)} />
    <ReturnFlowScreen sale={returnSale} language={state.language} onClose={() => setReturnSale(null)} onCreate={createReturn} onShare={shareReturn} />
  </ScreenContainer>;
}

const styles = StyleSheet.create({ page: { flex: 1 }, header: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.sm, gap: spacing.xs }, titleRow: { alignItems: 'center', gap: spacing.xs }, titleCopy: { minWidth: 0, flex: 1 }, suspendedButton: { minWidth: 106 }, content: { flex: 1 } });
