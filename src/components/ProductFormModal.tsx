import { useEffect, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { KeyboardAvoidingView, LayoutChangeEvent, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton, AppInput, ConfirmSheet, IconButton, Skeleton, useSnackbar } from '@/components/ui';
import { CategoryPickerSheet } from '@/components/CategoryPickerSheet';
import { Product, ProductInput } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { resolveProductImageUri } from '@/media/productImageStorage';
import { haptics } from '@/utils/haptics';
import { uiText } from '@/i18n';
import { BarcodeScannerScreen } from '@/components/barcode/BarcodeScannerScreen';
import { ProductBarcodeConflictError } from '@/database/database';
import { findBarcodeConflict, normalizeBarcode } from '@/utils/barcode';

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
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
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
    setPrice(product ? String(product.price_usd) : '');
    setCost(product ? String(product.cost_usd ?? 0) : '');
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
    setBarcode(value);
    const normalized = normalizeBarcode(value);
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
    const numericPrice = parseNumeric(price);
    const numericCost = cost.trim() ? parseNumeric(cost) : 0;
    if (!name.trim()) next.name = copy.productForm.nameRequired;
    if (!category.trim()) next.category = copy.productForm.categoryRequired;
    if (!price.trim() || !Number.isFinite(numericPrice) || numericPrice < 0) next.price = copy.productForm.invalidSalePrice;
    if (!Number.isFinite(numericCost) || numericCost < 0) next.cost = copy.productForm.invalidCost;
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
    return { numericPrice, numericCost };
  };

  const save = async () => {
    if (savingRef.current) return;
    const numeric = validate();
    if (!numeric) return;
    savingRef.current = true; setSaving(true);
    const input: ProductInput = {
      name: name.trim(), category: category.trim(), price_usd: numeric.numericPrice, cost_usd: numeric.numericCost,
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
            <AppInput label={copy.productForm.salePrice} value={price} onChangeText={value => { setPrice(value); clearError('price'); }} error={errors.price} helper={copy.productForm.salePriceHelper} helperVisibility="focus" placeholder="0.00" keyboardType="decimal-pad" accessibilityLabel={copy.productForm.salePrice} rtl={rtl} />
            <AppInput label={copy.productForm.costPrice} value={cost} onChangeText={value => { setCost(value); clearError('cost'); }} error={errors.cost} helper={copy.productForm.costHelper} placeholder="0.00" keyboardType="decimal-pad" accessibilityLabel={copy.productForm.costPrice} rtl={rtl} />
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
  const normalized = value
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٬,\s]/g, '')
    .replace('٫', '.');
  return Number(normalized);
}

const styles = StyleSheet.create({
  page: { flex: 1 }, flex: { flex: 1 }, keyboardArea: { paddingBottom: spacing.md },
  header: { minHeight: 66, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center', gap: spacing.sm }, headerCopy: { minWidth: 0, flex: 1 },
  scroll: { width: '100%', maxWidth: 720, alignSelf: 'center', padding: spacing.md, gap: spacing.xs },
  section: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.lg, gap: spacing.sm }, sectionHeader: { alignItems: 'center', gap: spacing.xs }, fieldGroup: { gap: spacing.xxs },
  select: { minHeight: 48, paddingHorizontal: spacing.sm, borderWidth: 1, borderRadius: radius.md, alignItems: 'center', gap: spacing.xs },
  technicalInput: { writingDirection: 'ltr' },
  scanButton: { backgroundColor: 'transparent' },
  imageFrame: { height: 156, borderWidth: 1, borderStyle: 'dashed', borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, imagePlaceholder: { alignItems: 'center', gap: spacing.xs },
  imageActions: { gap: spacing.xs }, flexButton: { flex: 1 }, removeButton: { minWidth: 104 },
  footer: { flexShrink: 0, borderTopWidth: StyleSheet.hairlineWidth }, footerAction: { flexShrink: 0, paddingHorizontal: spacing.md, paddingVertical: spacing.xs }, saveButton: { width: '100%', maxWidth: 688, alignSelf: 'center', minHeight: 50 },
  pressed: { opacity: 0.76 },
});
