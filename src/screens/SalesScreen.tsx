import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { CartReviewModal, CartLine, ExpensesView, InvoiceHistory, NewSaleView } from '@/components/sales/SalesViews';
import { AnalyticsDashboard } from '@/components/analytics/AnalyticsDashboard';
import { ConfirmSheet, MonetaryValue, ScreenContainer, SegmentedControl, useSnackbar } from '@/components/ui';
import { useAppStore } from '@/store/useAppStore';
import { Product, Sale } from '@/types';
import { spacing, typography, useAppTheme } from '@/theme';
import { calculateSypPrice } from '@/utils/priceCalculator';
import { formatNumber } from '@/utils/formatters';
import { shareInvoicePdf } from '@/utils/invoice';
import { haptics } from '@/utils/haptics';
import { addCartLine, calculateCartSubtotal, changeCartLineQuantity, clampCartDiscount, parseLocalizedNumber, setCartLineQuantity } from '@/utils/salesUiState';
import { uiText } from '@/i18n';
import { BarcodeScannerScreen } from '@/components/barcode/BarcodeScannerScreen';
import { ProductFormModal } from '@/components/ProductFormModal';
import { createProductBarcodeMap, findProductByExactBarcode } from '@/utils/barcode';

type SalesSection = 'sale' | 'invoices' | 'expenses' | 'analytics';

export function SalesScreen({ bottomNavigationInset = 0 }: { bottomNavigationInset?: number }) {
  const state = useAppStore();
  const { colors } = useAppTheme();
  const snackbar = useSnackbar();
  const rtl = state.language === 'ar';
  const copy = uiText(state.language);
  const [section, setSection] = useState<SalesSection>('sale');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completedSale, setCompletedSale] = useState<Sale | null>(null);
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [sharingSaleId, setSharingSaleId] = useState<number | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [unknownProductBarcode, setUnknownProductBarcode] = useState<string | null>(null);
  const savingRef = useRef(false);
  const sharingRef = useRef(false);
  const expenseSavingRef = useRef(false);

  const settings = useMemo(() => ({ exchangeRate: state.exchangeRate, isRoundingEnabled: state.isRoundingEnabled, roundingTarget: state.roundingTarget, language: state.language }), [state.exchangeRate, state.isRoundingEnabled, state.language, state.roundingTarget]);
  const subtotal = useMemo(() => calculateCartSubtotal(cart), [cart]);
  const parsedDiscount = useMemo(() => parseLocalizedNumber(discount), [discount]);
  const appliedDiscount = clampCartDiscount(parsedDiscount, subtotal);
  const total = subtotal - appliedDiscount;
  const cartItemCount = useMemo(() => cart.reduce((sum, line) => sum + line.quantity, 0), [cart]);
  const productsByBarcode = useMemo(() => createProductBarcodeMap(state.products), [state.products]);
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
    setCart(current => addCartLine(current, {
        productId: product.id,
        productName: product.name,
        quantity: 1,
        unitPriceSyp: calculateSypPrice({ priceUsd: product.price_usd, exchangeRate: settings.exchangeRate, isRoundingEnabled: settings.isRoundingEnabled, roundingTarget: settings.roundingTarget }),
        unitCostSyp: product.cost_usd * settings.exchangeRate,
      }));
  }, [settings.exchangeRate, settings.isRoundingEnabled, settings.roundingTarget]);

  const setQuantity = useCallback((productId: number, quantity: number) => {
    setCart(current => setCartLineQuantity(current, productId, quantity));
  }, []);

  const changeQuantity = useCallback((productId: number, delta: number) => {
    setCart(current => changeCartLineQuantity(current, productId, delta));
  }, []);

  const requestComplete = useCallback(() => {
    if (!cart.length || discountError || savingRef.current) return;
    haptics.warning();
    setConfirmOpen(true);
  }, [cart.length, discountError]);

  const completeSale = async () => {
    if (!cart.length || discountError || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const sale = await state.completeSale(cart, appliedDiscount);
      setCart([]);
      setDiscount('');
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

  const sectionOptions = [{ value: 'sale' as const, label: copy.sales.newSale }, { value: 'invoices' as const, label: copy.sales.invoices }, { value: 'expenses' as const, label: copy.sales.expenses }, { value: 'analytics' as const, label: copy.sales.analytics }];

  return <ScreenContainer>
    <View style={styles.page}>
      <View style={[styles.header, { backgroundColor: colors.surfaceSecondary }]}><Text style={[typography.titleLarge, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.title}</Text><Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.subtitle}</Text><SegmentedControl value={section} onChange={setSection} options={sectionOptions} rtl={rtl} subtle compactLabels accessibilityLabel={copy.sales.sections} /></View>
      <Animated.View key={section} entering={FadeIn.duration(170).reduceMotion(ReduceMotion.System)} style={styles.content}>
        {section === 'sale' && <NewSaleView products={state.products} settings={settings} cart={cart} completedSale={completedSale} bottomNavigationInset={bottomNavigationInset} sharing={completedSale?.id === sharingSaleId} onAdd={addProduct} onQuantityChange={setQuantity} onQuantityDelta={changeQuantity} onReviewCart={() => setReviewOpen(true)} onNewSale={() => setCompletedSale(null)} onShare={sale => void shareSale(sale)} onOpenScanner={() => setScannerOpen(true)} />}
        {section === 'invoices' && <InvoiceHistory sales={state.sales} language={state.language} bottomNavigationInset={bottomNavigationInset} selectedSale={selectedSale} sharingSaleId={sharingSaleId} onSelect={setSelectedSale} onCloseDetails={() => setSelectedSale(null)} onShare={sale => void shareSale(sale)} />}
        {section === 'expenses' && <ExpensesView expenses={state.expenses} language={state.language} bottomNavigationInset={bottomNavigationInset} onCreateExpense={createExpense} />}
        {section === 'analytics' && <AnalyticsDashboard sales={state.sales} expenses={state.expenses} language={state.language} bottomNavigationInset={bottomNavigationInset} />}
      </Animated.View>
    </View>
    <CartReviewModal visible={reviewOpen} cart={cart} discount={discount} discountError={discountError} subtotal={subtotal} appliedDiscount={appliedDiscount} total={total} language={state.language} saving={saving} onClose={() => setReviewOpen(false)} onDiscountChange={setDiscount} onQuantityChange={setQuantity} onQuantityDelta={changeQuantity} onRequestComplete={requestComplete} />
    <ConfirmSheet visible={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={() => void completeSale()} title={copy.sales.completeTitle} description={copy.sales.itemsLabel(formatNumber(cartItemCount, state.language))} confirmLabel={copy.sales.completeSale} cancelLabel={copy.sales.review} loading={saving} rtl={rtl} icon="check-circle" tone="success"><MonetaryValue value={total} language={state.language} currencyLabel={copy.common.syp} compact={false} /></ConfirmSheet>
    <BarcodeScannerScreen visible={scannerOpen} mode="cashier" language={state.language} onClose={() => setScannerOpen(false)} cartItemCount={formatNumber(cartItemCount, state.language)} cartTotal={total} onAddUnknown={barcode => { setScannerOpen(false); setUnknownProductBarcode(barcode); }} onScan={barcode => {
      const product = findProductByExactBarcode(productsByBarcode, barcode);
      if (!product) return { kind: 'unknown', barcode };
      if (product.is_active === 0) return { kind: 'inactive', title: product.name };
      const nextQuantity = Math.min(999, (cart.find(line => line.productId === product.id)?.quantity ?? 0) + 1);
      const amount = calculateSypPrice({ priceUsd: product.price_usd, exchangeRate: settings.exchangeRate, isRoundingEnabled: settings.isRoundingEnabled, roundingTarget: settings.roundingTarget });
      addProduct(product);
      return { kind: 'success', title: product.name, quantity: formatNumber(nextQuantity, state.language), amount };
    }} />
    <ProductFormModal visible={unknownProductBarcode !== null} product={null} mode="create" initialSection="identity" initialBarcode={unknownProductBarcode ?? undefined} onClose={() => setUnknownProductBarcode(null)} />
  </ScreenContainer>;
}

const styles = StyleSheet.create({ page: { flex: 1 }, header: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.sm, gap: spacing.xs }, content: { flex: 1 } });
