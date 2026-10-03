import { useEffect, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { KeyboardAvoidingView, LayoutChangeEvent, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton, AppInput, ConfirmSheet, IconButton, SegmentedControl, Skeleton, useSnackbar } from '@/components/ui';
import { CategoryPickerSheet } from '@/components/CategoryPickerSheet';
import { Product, ProductInput, ProductPricingCurrency } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { resolveProductImageUri } from '@/media/productImageStorage';
import { haptics } from '@/utils/haptics';
import { uiText } from '@/i18n';
import { BarcodeScannerScreen } from '@/components/barcode/BarcodeScannerScreen';
import { ProductBarcodeConflictError } from '@/database/database';
import { findBarcodeConflict, normalizeBarcode } from '@/utils/barcode';
import { validateNewUsdDecimal } from '@/utils/productPricing';
import { normalizeIdentifierDigits, normalizeNumericInput, sanitizeNumericInput } from '@/utils/numerals';

type FormMode = 'create' | 'edit' | 'duplicate';
type SectionKey = 'details' | 'pricing' | 'identity' | 'image';
type Errors = Partial<Record<'name' | 'category' | 'price' | 'cost' | 'barcode', string>>;

export function ProductFormModal({ visible, product, mode, initialSection = 'details', initialBarcode, onClose, onSaved }: {
  visible: boolean;
  product: Product | null;
  mode?: FormMode;
  initialSection?: SectionKey;
  initialBarcode?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { language, categories, products, createProduct, editProduct } = useAppStore();
  const snackbar = useSnackbar();
  const rtl = language === 'ar';
  const copy = uiText(language);
  const resolvedMode: FormMode = mode ?? (product ? 'edit' : 'create');
  const scrollRef = useRef<ScrollView>(null);
  const sectionOffsets = useRef<Partial<Record<SectionKey, number>>>({});
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [saleCurrency, setSaleCurrency] = useState<ProductPricingCurrency>('USD');
  const [costCurrency, setCostCurrency] = useState<ProductPricingCurrency>('USD');
  const [priceUsd, setPriceUsd] = useState('');
  const [priceSyp, setPriceSyp] = useState('');
  const [costUsd, setCostUsd] = useState('');
  const [costSyp, setCostSyp] = useState('');
  const [barcode, setBarcode] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [removeImageConfirmOpen, setRemoveImageConfirmOpen] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [scannerOpen, setScannerOpen] = useState(false);

  useEffect(() => {
    const duplicate = resolvedMode === 'duplicate';
    setName(product ? `${product.name}${duplicate ? copy.productForm.copySuffix : ''}` : '');
    setCategory(product?.category ?? '');
    setSaleCurrency(product?.sale_price_currency ?? 'USD');
    setCostCurrency(product?.cost_currency ?? 'USD');
    setPriceUsd(product ? String(product.price_usd) : '');
    setPriceSyp(product?.sale_price_syp == null ? '' : String(product.sale_price_syp));
    setCostUsd(product ? String(product.cost_usd ?? 0) : '');
    setCostSyp(product?.cost_syp == null ? '' : String(product.cost_syp));
    setBarcode(initialBarcode ?? (duplicate ? '' : (product?.barcode ?? '')));
    setImageUri(product?.image_uri ?? null);
    setImageLoading(Boolean(product?.image_uri));
    setImageFailed(false);
    setRemoveImageConfirmOpen(false);
    setErrors({});
    if (visible && initialSection !== 'details') {
      const timer = setTimeout(() => scrollToSection(initialSection), 260);
      return () => clearTimeout(timer);
    }
  }, [copy.productForm.copySuffix, initialBarcode, initialSection, product, resolvedMode, visible]);

  const setSectionOffset = (section: SectionKey) => (event: LayoutChangeEvent) => { sectionOffsets.current[section] = event.nativeEvent.layout.y; };
  const scrollToSection = (section: SectionKey) => scrollRef.current?.scrollTo({ y: Math.max(0, (sectionOffsets.current[section] ?? 0) - spacing.sm), animated: true });
  const clearError = (key: keyof Errors) => setErrors(current => current[key] ? { ...current, [key]: undefined } : current);
  const updateBarcode = (value: string) => {
    const canonical = normalizeIdentifierDigits(value);
    setBarcode(canonical);
    const normalized = normalizeBarcode(canonical);
    const editId = resolvedMode === 'edit' ? product?.id : undefined;
    const duplicate = findBarcodeConflict(products, normalized, editId);
    setErrors(current => ({ ...current, barcode: duplicate ? copy.productForm.duplicateBarcodeNamed(duplicate.name) : undefined }));
  };

  const chooseImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.75 });
      if (!result.canceled && result.assets[0]) {
        setImageUri(result.assets[0].uri);
        setImageLoading(true);
        setImageFailed(false);
      }
    } catch {
      haptics.error();
      snackbar.show({ text: copy.productForm.photoLibraryError, tone: 'error' });
    }
  };

  const validate = () => {
    const next: Errors = {};
    const numericPriceUsd = priceUsd.trim() ? parseNumeric(priceUsd) : 0;
    const numericCostUsd = costUsd.trim() ? parseNumeric(costUsd) : 0;
    const numericPriceSyp = priceSyp.trim() ? parseNumeric(priceSyp) : null;
    const numericCostSyp = costSyp.trim() ? parseNumeric(costSyp) : null;
    if (!name.trim()) next.name = copy.productForm.nameRequired;
    if (!category.trim()) next.category = copy.productForm.categoryRequired;
    if (saleCurrency === 'USD') {
      if (!priceUsd.trim() || !Number.isFinite(numericPriceUsd) || numericPriceUsd < 0) next.price = copy.productForm.invalidSalePrice;
      else if (resolvedMode !== 'edit' || numericPriceUsd !== product?.price_usd) try { validateNewUsdDecimal(normalizeDecimalText(priceUsd)); } catch { next.price = copy.productForm.usdPrecision; }
    } else if (!Number.isSafeInteger(numericPriceSyp) || (numericPriceSyp ?? -1) < 0) next.price = copy.productForm.invalidSypSalePrice;
    if (costCurrency === 'USD') {
      if (!Number.isFinite(numericCostUsd) || numericCostUsd < 0) next.cost = copy.productForm.invalidCost;
      else if (resolvedMode !== 'edit' || numericCostUsd !== product?.cost_usd) try { validateNewUsdDecimal(normalizeDecimalText(costUsd || '0')); } catch { next.cost = copy.productForm.usdPrecision; }
    } else if (!Number.isSafeInteger(numericCostSyp) || (numericCostSyp ?? -1) < 0) next.cost = copy.productForm.invalidSypCost;
    const normalizedBarcode = barcode.trim();
    const editId = resolvedMode === 'edit' ? product?.id : undefined;
    const duplicate = findBarcodeConflict(products, normalizedBarcode, editId);
    if (duplicate) next.barcode = copy.productForm.duplicateBarcodeNamed(duplicate.name);
    setErrors(next);
    const first = (['name', 'category', 'price', 'cost', 'barcode'] as const).find(key => next[key]);
    if (first) {
      haptics.warning();
      const section: SectionKey = first === 'name' || first === 'category' ? 'details' : first === 'barcode' ? 'identity' : 'pricing';
      scrollToSection(section);
      return null;
    }
    return { numericPriceUsd, numericCostUsd, numericPriceSyp, numericCostSyp };
  };

  const save = async () => {
    if (savingRef.current) return;
    const numeric = validate();
    if (!numeric) return;
    savingRef.current = true; setSaving(true);
    const input: ProductInput = {
      name: name.trim(), category: category.trim(), price_usd: numeric.numericPriceUsd, cost_usd: numeric.numericCostUsd,
      sale_price_currency: saleCurrency, sale_price_syp: numeric.numericPriceSyp,
      cost_currency: costCurrency, cost_syp: numeric.numericCostSyp,
      barcode: barcode.trim() || null, image_uri: imageUri,
    };
    try {
      if (resolvedMode === 'edit' && product) await editProduct(product.id, input);
      else await createProduct(input);
      haptics.success();
      snackbar.show({ text: resolvedMode === 'edit' ? copy.productForm.updated : copy.productForm.saved, tone: 'success' });
      onSaved?.();
      onClose();
    } catch (error) {
      if (__DEV__) console.error('[ProductSaveFailed]', error);
      haptics.error();
      if (error instanceof ProductBarcodeConflictError || (error instanceof Error && error.message === 'DUPLICATE_BARCODE')) {
        setErrors(current => ({ ...current, barcode: error instanceof ProductBarcodeConflictError ? copy.productForm.duplicateBarcodeNamed(error.productName) : copy.productForm.duplicateBarcode }));
        scrollToSection('identity');
        return;
      }
      const imageError = error instanceof Error && (error.message === 'IMAGE_TOO_LARGE' || error.message === 'IMAGE_NOT_FOUND');
      snackbar.show({ text: imageError ? copy.productForm.imageSaveFailed : copy.productForm.saveFailed, tone: 'error' });
    } finally { savingRef.current = false; setSaving(false); }
  };

  const title = resolvedMode === 'edit' ? copy.productForm.editTitle : resolvedMode === 'duplicate' ? copy.productForm.duplicateTitle : copy.productForm.addTitle;
  const resolvedImage = resolveProductImageUri(imageUri);
  const removeImage = () => {
    setImageUri(null);
    setImageFailed(false);
    setImageLoading(false);
    setRemoveImageConfirmOpen(false);
  };

  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={saving ? () => undefined : onClose}>
    <SafeAreaView edges={['top']} style={[styles.page, { backgroundColor: colors.background }]}> 
      <View style={[styles.header, { backgroundColor: colors.surface, borderBottomColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }]}>
        <View style={styles.headerCopy}><Text style={[typography.titleLarge, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{title}</Text><Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.productForm.subtitle}</Text></View>
        <IconButton icon="x" label={copy.common.close} onPress={onClose} disabled={saving} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.flex, styles.keyboardArea]}>
        <ScrollView ref={scrollRef} style={styles.flex} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
          <FormSection title={copy.productForm.basic} icon="package" rtl={rtl} onLayout={setSectionOffset('details')}>
            <AppInput label={copy.productForm.productName} value={name} onChangeText={value => { setName(value); clearError('name'); }} error={errors.name} placeholder={copy.productForm.nameExample} accessibilityLabel={copy.productForm.productName} rtl={rtl} autoCapitalize="sentences" returnKeyType="next" />
            <View style={styles.fieldGroup}>
              <Text style={[typography.label, { color: errors.category ? colors.danger : colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{copy.productForm.category}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={copy.productForm.chooseCategory} accessibilityState={{ expanded: categoryOpen }} onPress={() => setCategoryOpen(true)} style={({ pressed }) => [styles.select, { backgroundColor: colors.surface, borderColor: errors.category ? colors.danger : colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }, pressed && styles.pressed]}>
                <Feather name="tag" size={19} color={category ? colors.primary : colors.textMuted} />
                <Text numberOfLines={1} style={[typography.body, { flex: 1, color: category ? colors.textPrimary : colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{category || copy.productForm.chooseSavedCategory}</Text>
                <Feather name={rtl ? 'chevron-left' : 'chevron-right'} size={20} color={colors.textMuted} />
              </Pressable>
              {errors.category ? <Text accessibilityLiveRegion="polite" style={[typography.caption, { color: colors.danger, textAlign: rtl ? 'right' : 'left' }]}>{errors.category}</Text> : !categories.length && <Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.productForm.noCategories}</Text>}
            </View>
          </FormSection>

          <FormSection title={copy.productForm.pricing} icon="dollar-sign" rtl={rtl} onLayout={setSectionOffset('pricing')}>
            <View style={styles.currencyField}><Text style={[typography.label, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{copy.productForm.saleCurrency}</Text><SegmentedControl value={saleCurrency} onChange={value => { setSaleCurrency(value); clearError('price'); }} options={[{ value: 'USD', label: 'USD' }, { value: 'SYP', label: copy.common.syp }]} rtl={rtl} /></View>
            <AppInput label={copy.productForm.salePrice} value={saleCurrency === 'USD' ? priceUsd : priceSyp} onChangeText={value => { if (saleCurrency === 'USD') setPriceUsd(value); else setPriceSyp(value); clearError('price'); }} error={errors.price} helper={saleCurrency === 'USD' ? copy.productForm.salePriceHelper : copy.productForm.sypNativeHelper} helperVisibility="focus" placeholder={saleCurrency === 'USD' ? '0.0000' : '0'} keyboardType={saleCurrency === 'USD' ? 'decimal-pad' : 'number-pad'} accessibilityLabel={copy.productForm.salePrice} rtl={rtl} />
            <View style={styles.currencyField}><Text style={[typography.label, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{copy.productForm.costCurrency}</Text><SegmentedControl value={costCurrency} onChange={value => { setCostCurrency(value); clearError('cost'); }} options={[{ value: 'USD', label: 'USD' }, { value: 'SYP', label: copy.common.syp }]} rtl={rtl} /></View>
            <AppInput label={copy.productForm.costPrice} value={costCurrency === 'USD' ? costUsd : costSyp} onChangeText={value => { if (costCurrency === 'USD') setCostUsd(value); else setCostSyp(value); clearError('cost'); }} error={errors.cost} helper={costCurrency === 'USD' ? copy.productForm.costHelper : copy.productForm.sypNativeCostHelper} placeholder={costCurrency === 'USD' ? '0.0000' : '0'} keyboardType={costCurrency === 'USD' ? 'decimal-pad' : 'number-pad'} accessibilityLabel={copy.productForm.costPrice} rtl={rtl} />
          </FormSection>

          <FormSection title={copy.productForm.identification} icon="hash" rtl={rtl} onLayout={setSectionOffset('identity')}>
            <AppInput label={copy.productForm.barcode} value={barcode} onChangeText={updateBarcode} error={errors.barcode} helper={copy.productForm.barcodeHelper} helperVisibility="focus" placeholder={copy.productForm.barcodePlaceholder} accessibilityLabel={copy.productForm.barcode} rtl={rtl} style={styles.technicalInput} trailing={<IconButton icon="camera" label={copy.scanner.scanBarcode} onPress={() => setScannerOpen(true)} style={styles.scanButton} />} />
          </FormSection>

          <FormSection title={copy.productForm.image} icon="image" rtl={rtl} onLayout={setSectionOffset('image')}>
            <Pressable accessibilityRole="button" accessibilityLabel={copy.productForm.chooseProductImage} onPress={() => void chooseImage()} style={({ pressed }) => [styles.imageFrame, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }, pressed && styles.pressed]}>
              {resolvedImage && !imageFailed ? <Image source={resolvedImage} style={StyleSheet.absoluteFill} contentFit="cover" transition={140} onLoadStart={() => setImageLoading(true)} onLoad={() => setImageLoading(false)} onError={() => { setImageLoading(false); setImageFailed(true); }} /> : <View style={styles.imagePlaceholder}><Feather name={imageFailed ? 'image' : 'camera'} size={30} color={imageFailed ? colors.danger : colors.textMuted} /><Text style={[typography.body, { color: imageFailed ? colors.danger : colors.textSecondary }]}>{imageFailed ? copy.productForm.imageUnavailable : copy.productForm.imagePrompt}</Text></View>}
              {imageLoading && <Skeleton width="100%" height={156} radius={radius.md} style={StyleSheet.absoluteFill} />}
            </Pressable>
            <View style={[styles.imageActions, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
              <AppButton label={imageUri ? copy.productForm.changeImage : copy.productForm.chooseImage} icon="image" onPress={() => void chooseImage()} variant="secondary" style={styles.flexButton} />
              {imageUri && <AppButton label={copy.productForm.removeImage} icon="trash-2" onPress={() => setRemoveImageConfirmOpen(true)} variant="ghost" style={styles.removeButton} />}
            </View>
            <Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.productForm.imageNote}</Text>
          </FormSection>
        </ScrollView>
        <View style={[styles.footer, { backgroundColor: colors.surface, borderTopColor: colors.border, paddingBottom: insets.bottom }]}> 
          <View style={styles.footerAction}>
            <AppButton label={saving ? copy.productForm.saving : copy.productForm.saveProduct} icon="check" onPress={() => void save()} loading={saving} style={styles.saveButton} />
          </View>
        </View>
      </KeyboardAvoidingView>
      <CategoryPickerSheet visible={categoryOpen} onClose={() => setCategoryOpen(false)} value={category} onSelect={value => { setCategory(value); clearError('category'); }} />
      <ConfirmSheet visible={removeImageConfirmOpen} onClose={() => setRemoveImageConfirmOpen(false)} onConfirm={removeImage} title={copy.productForm.removeImageTitle} description={copy.productForm.removeImageDescription} confirmLabel={copy.productForm.removeImage} cancelLabel={copy.common.cancel} isDestructive rtl={rtl} />
      <BarcodeScannerScreen visible={scannerOpen} mode="product-input" language={language} onClose={() => setScannerOpen(false)} onScan={scannedBarcode => { updateBarcode(scannedBarcode); setScannerOpen(false); return { kind: 'success', title: scannedBarcode }; }} />
    </SafeAreaView>
  </Modal>;
}

function FormSection({ title, icon, rtl, onLayout, children }: { title: string; icon: keyof typeof Feather.glyphMap; rtl: boolean; onLayout: (event: LayoutChangeEvent) => void; children: React.ReactNode }) {
  const { colors } = useAppTheme();
  return <View onLayout={onLayout} style={[styles.section, { backgroundColor: colors.surface }]}>
    <View style={[styles.sectionHeader, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Feather name={icon} size={18} color={colors.primary} /><Text style={[typography.title, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{title}</Text></View>
    {children}
  </View>;
}

function parseNumeric(value: string) {
  const normalized = normalizeNumericInput(value, { allowDecimal: true });
  return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}

function normalizeDecimalText(value: string) {
  return sanitizeNumericInput(value, { allowDecimal: true });
}

const styles = StyleSheet.create({
  page: { flex: 1 }, flex: { flex: 1 }, keyboardArea: { paddingBottom: spacing.md },
  header: { minHeight: 66, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center', gap: spacing.sm }, headerCopy: { minWidth: 0, flex: 1 },
  scroll: { width: '100%', maxWidth: 720, alignSelf: 'center', padding: spacing.md, gap: spacing.xs },
  section: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.lg, gap: spacing.sm }, sectionHeader: { alignItems: 'center', gap: spacing.xs }, fieldGroup: { gap: spacing.xxs }, currencyField: { gap: spacing.xxs },
  select: { minHeight: 48, paddingHorizontal: spacing.sm, borderWidth: 1, borderRadius: radius.md, alignItems: 'center', gap: spacing.xs },
  technicalInput: { writingDirection: 'ltr' },
  scanButton: { backgroundColor: 'transparent' },
  imageFrame: { height: 156, borderWidth: 1, borderStyle: 'dashed', borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, imagePlaceholder: { alignItems: 'center', gap: spacing.xs },
  imageActions: { gap: spacing.xs }, flexButton: { flex: 1 }, removeButton: { minWidth: 104 },
  footer: { flexShrink: 0, borderTopWidth: StyleSheet.hairlineWidth }, footerAction: { flexShrink: 0, paddingHorizontal: spacing.md, paddingVertical: spacing.xs }, saveButton: { width: '100%', maxWidth: 688, alignSelf: 'center', minHeight: 50 },
  pressed: { opacity: 0.76 },
});
