import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { CartReviewModal, CartLine, InvoiceHistory, NewSaleView } from '@/components/sales/SalesViews';
import { ExpensesView } from '@/components/expenses/ExpensesView';
import { SuspendedSalesView } from '@/components/sales/SuspendedSalesView';
import { AnalyticsDashboard } from '@/components/analytics/AnalyticsDashboard';
import { AppButton, ConfirmSheet, MonetaryValue, ScreenContainer, SegmentedControl, useSnackbar } from '@/components/ui';
import { useAppStore } from '@/store/useAppStore';
import { Customer, PaymentMode, Product, Sale, SuspendedSaleSummary } from '@/types';
import { spacing, typography, useAppTheme } from '@/theme';
import { buildProductPricingSnapshot } from '@/utils/productPricing';
import { formatNumber } from '@/utils/formatters';
import { shareInvoicePdf } from '@/utils/invoice';
import { haptics } from '@/utils/haptics';
import { addCartLine, calculateCartSubtotal, changeCartLineQuantity, clampCartDiscount, isCartLineUnavailable, parseLocalizedNumber, setCartLineQuantity } from '@/utils/salesUiState';
import { calculateSettlement, formatUsdCents, minimumUsdCentsToCover, parseUsdToCents } from '@/utils/multiCurrency';
import { uiText } from '@/i18n';
import { BarcodeScannerScreen } from '@/components/barcode/BarcodeScannerScreen';
import { ProductFormModal } from '@/components/ProductFormModal';
import { createProductBarcodeMap, findProductByExactBarcode } from '@/utils/barcode';
import { buildRepeatedSaleCart } from '@/utils/repeatSale';
import { ReturnFlowScreen } from '@/components/sales/ReturnFlowScreen';
import { shareReturnReceiptPdf } from '@/utils/returnReceipt';
import { CashSessionScreen } from '@/components/cash/CashSessionScreen';
import { CustomersScreen } from '@/screens/CustomersScreen';

type SalesSection = 'sale' | 'suspended' | 'invoices' | 'customers' | 'expenses' | 'analytics' | 'cash';

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
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('SYP');
  const [usdAmount, setUsdAmount] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [onAccountAmount, setOnAccountAmount] = useState('0');
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

  const settings = useMemo(() => ({ exchangeRate: state.exchangeRate, isRoundingEnabled: state.isRoundingEnabled, roundingTarget: state.roundingTarget, language: state.language }), [state.exchangeRate, state.isRoundingEnabled, state.language, state.roundingTarget]);
  const subtotal = useMemo(() => calculateCartSubtotal(cart), [cart]);
  const parsedDiscount = useMemo(() => parseLocalizedNumber(discount), [discount]);
  const appliedDiscount = clampCartDiscount(parsedDiscount, subtotal);
  const total = subtotal - appliedDiscount;
  const selectedCustomer = customers.find(customer => customer.id === selectedCustomerId) ?? null;
  const parsedOnAccount = selectedCustomerId == null ? 0 : parseLocalizedNumber(onAccountAmount);
  const accountValid = Number.isSafeInteger(parsedOnAccount) && parsedOnAccount >= 0 && parsedOnAccount <= total && (parsedOnAccount === 0 || selectedCustomer?.accounting_enabled === 1);
  const cashDue = accountValid ? total - parsedOnAccount : total;
  const lockedRate = cartExchangeRate ?? state.exchangeRate;
  const payment = useMemo(() => {
    if (!accountValid) return null;
    const syp = paymentMode === 'USD' ? 0 : exactPayment ? cashDue : parseLocalizedNumber(amountPaid);
    const usd = paymentMode === 'SYP' ? 0 : parseUsdToCents(usdAmount);
    if (!Number.isSafeInteger(syp) || syp < 0 || usd == null) return null;
    try { return calculateSettlement(cashDue, lockedRate, { mode: paymentMode, sypAmount: syp, usdCents: usd }); } catch { return null; }
  }, [accountValid, amountPaid, cashDue, exactPayment, lockedRate, paymentMode, usdAmount]);
  useEffect(() => { void state.getCustomers('', false).then(setCustomers); }, [state.getCustomers]);
  useEffect(() => {
    if (reviewOpen || section === 'customers' || returnSale) void state.getCustomers('', false).then(setCustomers);
  }, [returnSale, reviewOpen, section, state.getCustomers]);
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
    const currentQuantity = cart.find(line => line.productId === product.id)?.quantity ?? 0;
    if (product.inventory_tracking_enabled && currentQuantity >= (product.inventory_quantity ?? 0)) { snackbar.show({ text: copy.inventory.insufficient, tone: 'info' }); return; }
    haptics.tap();
    setCompletedSale(null);
    const rate = cartExchangeRate ?? state.exchangeRate;
    if (cartExchangeRate == null) setCartExchangeRate(rate);
    const pricing = buildProductPricingSnapshot(product, rate, settings);
    setCart(current => addCartLine(current, {
        productId: product.id,
        cartKey: `product:${product.id}`,
        productName: product.name,
        barcodeSnapshot: product.barcode,
        isAvailable: product.is_active !== 0,
        availableQuantity: product.inventory_tracking_enabled ? product.inventory_quantity ?? 0 : undefined,
        quantity: 1,
        ...pricing,
      }));
  }, [cart, cartExchangeRate, copy.inventory.insufficient, settings.isRoundingEnabled, settings.roundingTarget, snackbar, state.exchangeRate]);

  const setQuantity = useCallback((key: string | number, quantity: number) => {
    const line = cart.find(item => item.cartKey === key || item.productId === key); const product = line?.productId == null ? undefined : state.products.find(item => item.id === line.productId);
    const capped = product?.inventory_tracking_enabled ? Math.min(quantity, product.inventory_quantity ?? 0) : quantity;
    setCart(current => setCartLineQuantity(current, key, capped));
  }, [cart, state.products]);

  const changeQuantity = useCallback((key: string | number, delta: number) => {
    const line = cart.find(item => item.cartKey === key || item.productId === key); const product = line?.productId == null ? undefined : state.products.find(item => item.id === line.productId);
    if (delta > 0 && product?.inventory_tracking_enabled && (line?.quantity ?? 0) >= (product.inventory_quantity ?? 0)) { snackbar.show({ text: copy.inventory.insufficient, tone: 'info' }); return; }
    setCart(current => changeCartLineQuantity(current, key, delta));
  }, [cart, copy.inventory.insufficient, snackbar, state.products]);

  const requestComplete = useCallback(() => {
    if (!cart.length || discountError || !payment?.valid || cart.some(isCartLineUnavailable) || savingRef.current) return;
    if (!state.activeCashSession) { snackbar.show({ text: copy.cashSession.cashRequired, tone: 'info' }); setSection('cash'); return; }
    haptics.warning();
    setConfirmOpen(true);
  }, [cart, copy.cashSession.cashRequired, discountError, payment?.valid, snackbar, state.activeCashSession]);

  const completeSale = async () => {
    if (!cart.length || discountError || !payment?.valid || cart.some(isCartLineUnavailable) || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const sale = await state.completeSale(cart, appliedDiscount, { mode: paymentMode, sypAmount: payment.payments.find(row => row.currency === 'SYP')?.amount_minor ?? 0, usdCents: payment.payments.find(row => row.currency === 'USD')?.amount_minor ?? 0 }, lockedRate, activeDraftId ?? undefined, { customerId: selectedCustomerId, onAccountSyp: parsedOnAccount });
      setCart([]);
      setDiscount('');
      setAmountPaid(''); setUsdAmount(''); setPaymentMode('SYP'); setExactPayment(true); setSelectedCustomerId(null); setOnAccountAmount('0'); setCartExchangeRate(null); setActiveDraftId(null);
      setReviewOpen(false);
      setConfirmOpen(false);
      setCompletedSale(sale);
      setSection('sale');
      haptics.success();
    } catch (error) {
      if (__DEV__) console.error('[SaleCompletionFailed]', error);
      haptics.error();
      const required = error instanceof Error && error.message === 'CASH_SESSION_REQUIRED';
      snackbar.show({ text: required ? copy.cashSession.cashRequired : copy.sales.saleFailed, tone: required ? 'info' : 'error', duration: 4800 });
      if (required) { setConfirmOpen(false); setSection('cash'); }
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
      setCart([]); setDiscount(''); setAmountPaid(''); setUsdAmount(''); setPaymentMode('SYP'); setExactPayment(true); setSelectedCustomerId(null); setOnAccountAmount('0'); setCartExchangeRate(null); setActiveDraftId(null);
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
        return { productId: item.product_id, cartKey: item.product_id == null ? `draft:${item.uuid}` : `product:${item.product_id}`, productName: item.product_name, barcodeSnapshot: item.barcode_snapshot, quantity: item.quantity, unitPriceSyp: item.unit_price_syp, unitCostSyp: item.unit_cost_syp,
          salePriceSourceCurrency: item.sale_price_source_currency, salePriceNativeDecimal: item.sale_price_native_decimal, salePriceNativeSyp: item.sale_price_native_syp,
          salePriceExchangeRate: item.sale_price_exchange_rate, salePriceRoundingEnabled: item.sale_price_rounding_enabled == null ? null : item.sale_price_rounding_enabled === 1,
          salePriceRoundingTarget: item.sale_price_rounding_target, costSourceCurrency: item.cost_source_currency, costNativeDecimal: item.cost_native_decimal,
          costNativeSyp: item.cost_native_syp, costExchangeRate: item.cost_exchange_rate,
          isAvailable: Boolean(product && product.is_active !== 0), availableQuantity: product?.inventory_tracking_enabled ? product.inventory_quantity ?? 0 : undefined };
      });
      setCart(restored); setDiscount(full.discount_syp ? String(full.discount_syp) : ''); setAmountPaid(''); setUsdAmount(''); setPaymentMode('SYP'); setExactPayment(true); setSelectedCustomerId(null); setOnAccountAmount('0');
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
    setAmountPaid(''); setUsdAmount(''); setPaymentMode('SYP'); setExactPayment(true); setSelectedCustomerId(null); setOnAccountAmount('0'); setCompletedSale(null); setSelectedSale(null); setSaleToRepeat(null); setSection('sale');
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

  const createReturn = useCallback(async (saleId: number, selections: import('@/types').ReturnSelection[], customerAccountCreditSyp = 0) => {
    try { const record = await state.createReturn(saleId, selections, customerAccountCreditSyp); haptics.success(); snackbar.show({ text: copy.sales.returnRecorded, tone: 'success' }); return record; }
    catch (error) { if (__DEV__) console.error('[ReturnCreationFailed]', error); haptics.error(); const required = error instanceof Error && error.message === 'CASH_SESSION_REQUIRED'; snackbar.show({ text: required ? copy.cashSession.cashRequired : copy.sales.returnFailed, tone: required ? 'info' : 'error' }); if (required) { setReturnSale(null); setSection('cash'); } throw error; }
  }, [copy.cashSession.cashRequired, copy.sales.returnFailed, copy.sales.returnRecorded, snackbar, state]);

  const shareReturn = useCallback(async (record: import('@/types').SaleReturn, sale: Sale) => {
    try { await shareReturnReceiptPdf(record, sale, state.language); snackbar.show({ text: copy.sales.returnPrepared, tone: 'success' }); }
    catch (error) { if (__DEV__) console.error('[ReturnReceiptFailed]', error); snackbar.show({ text: copy.sales.returnPrepareFailed, tone: 'error' }); }
  }, [copy.sales.returnPrepareFailed, copy.sales.returnPrepared, snackbar, state.language]);

  const sectionOptions = [{ value: 'sale' as const, label: copy.sales.newSale }, { value: 'invoices' as const, label: copy.sales.invoices }, { value: 'customers' as const, label: copy.customer.title }, { value: 'expenses' as const, label: copy.sales.expenses }, { value: 'analytics' as const, label: copy.sales.analytics }];

  return <ScreenContainer>
    <View style={styles.page}>
      <View style={[styles.header, { backgroundColor: colors.surfaceSecondary }]}><View style={[styles.titleRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><View style={styles.titleCopy}><Text style={[typography.titleLarge, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.title}</Text><Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.subtitle}</Text></View><View style={[styles.headerActions, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><AppButton label={copy.cashSession.title} icon="briefcase" variant={section === 'cash' ? 'primary' : 'secondary'} onPress={() => setSection('cash')} style={styles.cashButton} /><AppButton label={`${copy.sales.suspendedSales}${visibleSuspendedSales.length ? ` (${formatNumber(visibleSuspendedSales.length, state.language)})` : ''}`} icon="pause" variant={section === 'suspended' ? 'primary' : 'secondary'} onPress={() => setSection('suspended')} style={styles.suspendedButton} /></View></View><SegmentedControl value={section} onChange={setSection} options={sectionOptions} rtl={rtl} subtle compactLabels accessibilityLabel={copy.sales.sections} /></View>
      <Animated.View key={section} entering={FadeIn.duration(170).reduceMotion(ReduceMotion.System)} style={styles.content}>
        {section === 'sale' && <NewSaleView products={state.products} settings={settings} cart={cart} completedSale={completedSale} bottomNavigationInset={bottomNavigationInset} sharing={completedSale?.id === sharingSaleId} onAdd={addProduct} onQuantityChange={(id, quantity) => setQuantity(id, quantity)} onQuantityDelta={(id, delta) => changeQuantity(id, delta)} onReviewCart={() => setReviewOpen(true)} onNewSale={() => setCompletedSale(null)} onShare={sale => void shareSale(sale)} onViewDetails={sale => { setSelectedSale(sale); setSection('invoices'); }} onOpenScanner={() => setScannerOpen(true)} />}
        {section === 'suspended' && <SuspendedSalesView drafts={visibleSuspendedSales} language={state.language} bottomNavigationInset={bottomNavigationInset} busyId={draftBusyId} onResume={draft => { if (cart.length) setDraftToResume(draft); else void loadDraftIntoCart(draft, false); }} onDelete={setDraftToDelete} />}
        {section === 'invoices' && <InvoiceHistory language={state.language} bottomNavigationInset={bottomNavigationInset} selectedSale={selectedSale} sharingSaleId={sharingSaleId} revision={state.sales.reduce((sum, sale) => sum + (sale.returns?.length ?? 0), 0)} queryInvoices={state.queryInvoices} onSelect={sale => void openInvoice(sale)} onCloseDetails={() => setSelectedSale(null)} onShare={sale => void shareSale(sale)} onReturn={sale => { setSelectedSale(null); setReturnSale(sale); }} onRepeat={sale => { if (cart.length) setSaleToRepeat(sale); else repeatSale(sale); }} />}
        {section === 'customers' && <CustomersScreen bottomNavigationInset={bottomNavigationInset} />}
        {section === 'expenses' && <ExpensesView language={state.language} bottomNavigationInset={bottomNavigationInset} hasActiveCashSession={!!state.activeCashSession} onRequireCashSession={() => setSection('cash')} />}
        {section === 'analytics' && <AnalyticsDashboard sales={state.sales} expenses={state.expenses} language={state.language} bottomNavigationInset={bottomNavigationInset} />}
        {section === 'cash' && <CashSessionScreen language={state.language} bottomNavigationInset={bottomNavigationInset} />}
      </Animated.View>
    </View>
    <CartReviewModal visible={reviewOpen} cart={cart} discount={discount} discountError={discountError} subtotal={subtotal} appliedDiscount={appliedDiscount} total={total} customers={customers} selectedCustomerId={selectedCustomerId} onAccountAmount={onAccountAmount} cashDue={cashDue} paymentMode={paymentMode} sypAmount={exactPayment ? String(cashDue) : amountPaid} usdAmount={usdAmount} settlement={payment} language={state.language} saving={saving} draftRate={activeDraftId == null ? null : cartExchangeRate} currentRate={state.exchangeRate} onClose={() => setReviewOpen(false)} onDiscountChange={setDiscount} onCustomerChange={id => { setSelectedCustomerId(id); setOnAccountAmount('0'); setAmountPaid(''); setUsdAmount(''); setExactPayment(true); }} onAccountAmountChange={value => { setOnAccountAmount(value); setAmountPaid(''); setUsdAmount(''); setExactPayment(true); }} onPaymentModeChange={mode => { setPaymentMode(mode); setAmountPaid(''); setUsdAmount(''); setExactPayment(mode === 'SYP'); }} onSypAmountChange={value => { setExactPayment(false); setAmountPaid(value); }} onUsdAmountChange={setUsdAmount} onExactSyp={() => { setExactPayment(true); setAmountPaid(''); }} onMinimumUsd={() => { const syp = paymentMode === 'MIXED' ? (exactPayment ? cashDue : parseLocalizedNumber(amountPaid)) : 0; const remaining = Math.max(0, cashDue - (Number.isSafeInteger(syp) && syp >= 0 ? syp : 0)); setUsdAmount(formatUsdCents(minimumUsdCentsToCover(remaining, lockedRate)).replace(' USD', '')); }} onQuantityChange={setQuantity} onQuantityDelta={changeQuantity} onRequestComplete={requestComplete} onRequestSuspend={() => setSuspendConfirmOpen(true)} />
    <ConfirmSheet visible={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={() => void completeSale()} title={copy.sales.completeTitle} description={copy.sales.itemsLabel(formatNumber(cartItemCount, state.language))} confirmLabel={copy.sales.completeSale} cancelLabel={copy.sales.review} loading={saving} rtl={rtl} icon="check-circle" tone="success"><MonetaryValue value={total} language={state.language} currencyLabel={copy.common.syp} compact={false} /></ConfirmSheet>
    <ConfirmSheet visible={suspendConfirmOpen} onClose={() => setSuspendConfirmOpen(false)} onConfirm={() => void suspendCurrentSale()} title={copy.sales.suspendTitle} description={copy.sales.suspendDescription} confirmLabel={copy.sales.suspendSale} cancelLabel={copy.common.cancel} loading={saving} rtl={rtl} icon="pause-circle" tone="warning" />
    <ConfirmSheet visible={draftToResume !== null} onClose={() => setDraftToResume(null)} onConfirm={() => { if (draftToResume) void loadDraftIntoCart(draftToResume, true); }} title={copy.sales.currentSaleExists} description={copy.sales.suspendDescription} confirmLabel={copy.sales.holdCurrentAndResume} cancelLabel={copy.common.cancel} loading={draftBusyId !== null} rtl={rtl} icon="repeat" tone="warning" />
    <ConfirmSheet visible={draftToDelete !== null} onClose={() => setDraftToDelete(null)} onConfirm={() => void deleteDraft()} title={copy.sales.deleteDraftTitle} description={copy.sales.deleteDraftDescription} confirmLabel={copy.sales.deleteDraft} cancelLabel={copy.common.cancel} loading={draftBusyId !== null} rtl={rtl} isDestructive />
    <ConfirmSheet visible={saleToRepeat !== null} onClose={() => setSaleToRepeat(null)} onConfirm={() => { if (saleToRepeat) repeatSale(saleToRepeat); }} title={copy.sales.repeatCurrentCartTitle} description={copy.sales.repeatCurrentCartDescription} confirmLabel={copy.sales.addToCurrentCart} cancelLabel={copy.common.cancel} rtl={rtl} icon="repeat" />
    <BarcodeScannerScreen visible={scannerOpen} mode="cashier" language={state.language} onClose={() => setScannerOpen(false)} cartItemCount={formatNumber(cartItemCount, state.language)} cartTotal={total} onAddUnknown={barcode => { setScannerOpen(false); setUnknownProductBarcode(barcode); }} onScan={barcode => {
      const product = findProductByExactBarcode(productsByBarcode, barcode);
      if (!product) return { kind: 'unknown', barcode };
      if (product.is_active === 0) return { kind: 'inactive', title: product.name };
      const currentQuantity = cart.find(line => line.productId === product.id)?.quantity ?? 0;
      if (product.inventory_tracking_enabled && currentQuantity >= (product.inventory_quantity ?? 0)) return { kind: 'inactive', title: copy.inventory.outOfStock };
      const nextQuantity = Math.min(999, currentQuantity + 1);
      const rate = cartExchangeRate ?? settings.exchangeRate;
      const amount = buildProductPricingSnapshot(product, rate, settings).unitPriceSyp;
      addProduct(product);
      return { kind: 'success', title: product.name, quantity: formatNumber(nextQuantity, state.language), amount };
    }} />
    <ProductFormModal visible={unknownProductBarcode !== null} product={null} mode="create" initialSection="identity" initialBarcode={unknownProductBarcode ?? undefined} onClose={() => setUnknownProductBarcode(null)} />
    <ReturnFlowScreen key={returnSale?.id ?? 'closed'} sale={returnSale} language={state.language} hasActiveCashSession={!!state.activeCashSession} hasCustomerAccount={Boolean(returnSale?.customer_id && customers.some(customer => customer.id === returnSale.customer_id && customer.accounting_enabled === 1))} onRequireCashSession={() => { setReturnSale(null); setSection('cash'); snackbar.show({ text: copy.cashSession.cashRequired, tone: 'info' }); }} onClose={() => setReturnSale(null)} onCreate={createReturn} onShare={shareReturn} />
  </ScreenContainer>;
}

const styles = StyleSheet.create({ page: { flex: 1 }, header: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.sm, gap: spacing.xs }, titleRow: { alignItems: 'center', gap: spacing.xs }, titleCopy: { minWidth: 0, flex: 1 }, headerActions: { gap: spacing.xxs }, cashButton: { minWidth: 90 }, suspendedButton: { minWidth: 106 }, content: { flex: 1 } });
