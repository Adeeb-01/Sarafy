import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { ProductFormModal } from '@/components/ProductFormModal';
import { CategoryPickerSheet } from '@/components/CategoryPickerSheet';
import { PRODUCT_ROW_GAP, PRODUCT_ROW_HEIGHT, ProductListRow } from '@/components/ProductListRow';
import { EMPTY_PRODUCT_FILTERS, ProductFilters, ProductFiltersSheet, ProductSort, ProductSortSheet } from '@/components/ProductControlSheets';
import { ActionSheet, AppButton, ConfirmSheet, EmptyState, FilterChip, IconButton, ListItem, ScreenContainer, SearchInput, StatusChip, useSnackbar } from '@/components/ui';
import { useAppStore } from '@/store/useAppStore';
import { Product } from '@/types';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';
import { uiText } from '@/i18n';
import { BarcodeScannerScreen } from '@/components/barcode/BarcodeScannerScreen';
import { createProductBarcodeMap, findProductByExactBarcode } from '@/utils/barcode';

type QuickFilter = 'all' | 'active' | 'no_image' | 'custom';
type FormState = { open: boolean; product: Product | null; mode: 'create' | 'edit' | 'duplicate'; initialSection: 'details' | 'identity' | 'image'; initialBarcode?: string };

export function ProductManagementScreen({ bottomNavigationInset = 0 }: { bottomNavigationInset?: number }) {
  const state = useAppStore(); const { colors } = useAppTheme(); const snackbar = useSnackbar();
  const rtl = state.language === 'ar';
  const copy = uiText(state.language);
  const [query, setQuery] = useState('');
  const [exactScanBarcode, setExactScanBarcode] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const [filters, setFilters] = useState<ProductFilters>(EMPTY_PRODUCT_FILTERS);
  const [sort, setSort] = useState<ProductSort>('newest');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [filterCategoryOpen, setFilterCategoryOpen] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [actionsProduct, setActionsProduct] = useState<Product | null>(null);
  const [deleteProduct, setDeleteProduct] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [form, setForm] = useState<FormState>({ open: false, product: null, mode: 'create', initialSection: 'details' });
  const [scannerOpen, setScannerOpen] = useState(false);
  const productsByBarcode = useMemo(() => createProductBarcodeMap(state.products), [state.products]);

  const quickFilter: QuickFilter = useMemo(() => {
    if (filters.category !== 'all' || filters.price !== 'all') return 'custom';
    if (filters.status === 'all' && filters.image === 'all') return 'all';
    if (filters.status === 'active' && filters.image === 'all') return 'active';
    if (filters.status === 'all' && filters.image === 'without') return 'no_image';
    return 'custom';
  }, [filters]);
  const activeFilterCount = Object.values(filters).filter(value => value !== 'all').length;

  const visibleProducts = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase();
    const filtered = state.products.filter(product => {
      const matchesSearch = exactScanBarcode !== null
        ? product.barcode === exactScanBarcode
        : !normalized || product.name.toLocaleLowerCase().includes(normalized) || product.category.toLocaleLowerCase().includes(normalized) || product.barcode?.toLocaleLowerCase().includes(normalized);
      const matchesCategory = filters.category === 'all' || product.category === filters.category;
      const matchesStatus = filters.status === 'all' || (filters.status === 'active' ? product.is_active !== 0 : product.is_active === 0);
      const matchesImage = filters.image === 'all' || (filters.image === 'with' ? Boolean(product.image_uri) : !product.image_uri);
      const matchesPrice = filters.price === 'all' || (filters.price === 'zero' ? product.price_usd === 0 : filters.price === 'under1' ? product.price_usd > 0 && product.price_usd < 1 : filters.price === 'oneToTen' ? product.price_usd >= 1 && product.price_usd <= 10 : product.price_usd > 10);
      return matchesSearch && matchesCategory && matchesStatus && matchesImage && matchesPrice;
    });
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, state.language);
      if (sort === 'sale') return b.price_usd - a.price_usd;
      if (sort === 'cost') return b.cost_usd - a.cost_usd;
      if (sort === 'category') return a.category.localeCompare(b.category, state.language) || a.name.localeCompare(b.name, state.language);
      return b.created_at.localeCompare(a.created_at);
    });
  }, [deferredQuery, exactScanBarcode, filters, sort, state.language, state.products]);

  const openCreate = useCallback(() => setForm({ open: true, product: null, mode: 'create', initialSection: 'details' }), []);
  const openEdit = useCallback((product: Product) => setForm({ open: true, product, mode: 'edit', initialSection: 'details' }), []);
  const openActions = useCallback((product: Product) => setActionsProduct(product), []);
  const closeForm = useCallback(() => setForm(current => ({ ...current, open: false })), []);
  const applyQuickFilter = (value: Exclude<QuickFilter, 'custom'>) => {
    if (value === 'all') setFilters(EMPTY_PRODUCT_FILTERS);
    else if (value === 'active') setFilters({ ...EMPTY_PRODUCT_FILTERS, status: 'active' });
    else setFilters({ ...EMPTY_PRODUCT_FILTERS, image: 'without' });
  };
  const clearCriteria = () => { setQuery(''); setExactScanBarcode(null); setFilters(EMPTY_PRODUCT_FILTERS); };

  const performDelete = async () => {
    if (!deleteProduct || deletingRef.current) return;
    deletingRef.current = true; setDeleting(true);
    try {
      await state.removeProduct(deleteProduct.id);
      haptics.success();
      snackbar.show({ text: copy.products.deleted, tone: 'success' });
      setDeleteProduct(null);
    } catch (error) {
      if (__DEV__) console.error('[ProductDeletionFailed]', error);
      haptics.error();
      snackbar.show({ text: copy.products.deleteFailed, tone: 'error' });
    } finally { deletingRef.current = false; setDeleting(false); }
  };

  const settings = useMemo(() => ({ exchangeRate: state.exchangeRate, isRoundingEnabled: state.isRoundingEnabled, roundingTarget: state.roundingTarget, language: state.language }), [state.exchangeRate, state.isRoundingEnabled, state.language, state.roundingTarget]);
  const renderItem = useCallback(({ item }: { item: Product }) => <ProductListRow product={item} settings={settings} onEdit={openEdit} onActions={openActions} />, [openActions, openEdit, settings]);
  const hasCriteria = query.trim().length > 0 || activeFilterCount > 0;
  const resultContext = hasCriteria ? copy.products.filteredResults : copy.products.allProducts;
  const listContentStyle = useMemo(() => [styles.list, { paddingBottom: bottomNavigationInset + spacing.md }, visibleProducts.length === 0 && styles.emptyList], [bottomNavigationInset, visibleProducts.length]);
  const quickOptions: { value: Exclude<QuickFilter, 'custom'>; label: string }[] = [
    { value: 'all', label: copy.common.all }, { value: 'active', label: copy.products.active }, { value: 'no_image', label: copy.products.noImage },
  ];

  return <ScreenContainer>
    <View style={[styles.header, { backgroundColor: colors.surfaceSecondary }]}> 
      <View style={[styles.titleRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
        <View style={styles.titleCopy}><Text style={[typography.titleLarge, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.products.title}</Text><Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.products.storedLocally(String(state.products.length))}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={copy.products.manageCategories} accessibilityHint={copy.products.manageCategoriesHint} onPress={() => { haptics.tap(); setCategoryManagerOpen(true); }} style={({ pressed }) => [styles.categoryButton, { backgroundColor: colors.surface, borderColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }, pressed && styles.pressed]}><Feather name="tag" size={18} color={colors.textSecondary} /><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} maxFontSizeMultiplier={1.2} style={[typography.label, { color: colors.textSecondary }]}>{copy.products.categories}</Text></Pressable>
        <AppButton label={copy.common.add} icon="plus" onPress={openCreate} style={styles.addButton} />
      </View>
      <View style={[styles.searchRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><View style={styles.searchInput}><SearchInput value={query} onChangeText={value => { setQuery(value); setExactScanBarcode(null); }} placeholder={copy.products.search} clearLabel={copy.common.clearSearch} rtl={rtl} /></View><IconButton icon="camera" label={copy.scanner.scanBarcode} tone="primary" onPress={() => setScannerOpen(true)} /></View>
      <View style={[styles.toolRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={copy.products.openFilters} onPress={() => { haptics.tap(); setFiltersOpen(true); }} style={({ pressed }) => [styles.toolButton, { backgroundColor: activeFilterCount ? colors.primarySoft : colors.surfaceSecondary, borderColor: activeFilterCount ? colors.primary : colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }, pressed && styles.pressed]}><Feather name="filter" size={17} color={activeFilterCount ? colors.primary : colors.textSecondary} /><Text style={[typography.label, { color: activeFilterCount ? colors.primary : colors.textSecondary }]}>{copy.products.filter}</Text>{activeFilterCount > 0 && <StatusChip label={String(activeFilterCount)} tone="info" />}</Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={copy.products.openSort} onPress={() => { haptics.tap(); setSortOpen(true); }} style={({ pressed }) => [styles.toolButton, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }, pressed && styles.pressed]}><Feather name="sliders" size={17} color={colors.textSecondary} /><Text style={[typography.label, { color: colors.textSecondary }]}>{copy.products.sort}</Text></Pressable>
        <View style={[styles.resultCount, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Feather name={hasCriteria ? 'filter' : 'list'} size={13} color={colors.textMuted} /><Text style={[typography.caption, { color: colors.textMuted }]}>{copy.products.resultCount(String(visibleProducts.length), String(state.products.length))}</Text><Text style={[typography.caption, { color: colors.textMuted }]}>·</Text><Text numberOfLines={1} style={[typography.caption, styles.resultContext, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{resultContext}</Text></View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.quickFilters, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
        {quickOptions.map(option => <FilterChip key={option.value} label={option.label} selected={quickFilter === option.value} onPress={() => applyQuickFilter(option.value)} />)}
      </ScrollView>
    </View>

    <FlatList data={visibleProducts} keyExtractor={item => String(item.id)} renderItem={renderItem} ItemSeparatorComponent={() => <View style={styles.separator} />} contentContainerStyle={listContentStyle} scrollIndicatorInsets={{ bottom: bottomNavigationInset }} keyboardShouldPersistTaps="handled"
      initialNumToRender={14} maxToRenderPerBatch={14} updateCellsBatchingPeriod={40} windowSize={7} removeClippedSubviews
      getItemLayout={(_, index) => ({ length: PRODUCT_ROW_HEIGHT + PRODUCT_ROW_GAP, offset: (PRODUCT_ROW_HEIGHT + PRODUCT_ROW_GAP) * index, index })}
      ListEmptyComponent={<EmptyState icon={hasCriteria ? 'search' : 'package'} title={hasCriteria ? copy.products.noMatch : copy.catalog.emptyTitle} description={hasCriteria ? copy.products.noMatchDescription : copy.products.emptyDescription} actionLabel={hasCriteria ? copy.common.reset : copy.products.addProduct} onAction={hasCriteria ? clearCriteria : openCreate} />}
    />

    <ProductFiltersSheet visible={filtersOpen} onClose={() => setFiltersOpen(false)} filters={filters} onChange={setFilters} onOpenCategory={() => setFilterCategoryOpen(true)} language={state.language} />
    <ProductSortSheet visible={sortOpen} onClose={() => setSortOpen(false)} value={sort} onChange={setSort} language={state.language} />
    <CategoryPickerSheet visible={filterCategoryOpen} onClose={() => setFilterCategoryOpen(false)} value={filters.category === 'all' ? undefined : filters.category} onSelect={category => setFilters(current => ({ ...current, category }))} />
    <CategoryPickerSheet visible={categoryManagerOpen} onClose={() => setCategoryManagerOpen(false)} management />

    <ActionSheet visible={Boolean(actionsProduct)} onClose={() => setActionsProduct(null)} title={actionsProduct?.name ?? ''} rtl={rtl}>
      <ListItem title={copy.products.edit} description={copy.products.editDescription} icon="edit-2" rtl={rtl} onPress={() => { if (!actionsProduct) return; const product = actionsProduct; setActionsProduct(null); setForm({ open: true, product, mode: 'edit', initialSection: 'details' }); }} />
      <ListItem title={copy.products.changeImage} description={copy.products.changeImageDescription} icon="image" rtl={rtl} onPress={() => { if (!actionsProduct) return; const product = actionsProduct; setActionsProduct(null); setForm({ open: true, product, mode: 'edit', initialSection: 'image' }); }} />
      <ListItem title={copy.products.duplicate} description={copy.products.duplicateDescription} icon="copy" rtl={rtl} onPress={() => { if (!actionsProduct) return; const product = actionsProduct; setActionsProduct(null); setForm({ open: true, product, mode: 'duplicate', initialSection: 'details' }); }} />
      <ListItem title={copy.products.delete} description={copy.products.deleteDescription} icon="trash-2" rtl={rtl} tone="danger" onPress={() => { if (!actionsProduct) return; setDeleteProduct(actionsProduct); setActionsProduct(null); }} />
    </ActionSheet>

    <ConfirmSheet visible={Boolean(deleteProduct)} onClose={() => setDeleteProduct(null)} onConfirm={() => void performDelete()} title={copy.products.deleteTitle} description={copy.products.deleteWarning(deleteProduct?.name ?? '')} confirmLabel={copy.products.deleteConfirm} cancelLabel={copy.common.cancel} isDestructive loading={deleting} rtl={rtl} />
    <ProductFormModal visible={form.open} product={form.product} mode={form.mode} initialSection={form.initialSection} initialBarcode={form.initialBarcode} onClose={closeForm} />
    <BarcodeScannerScreen visible={scannerOpen} mode="product-search" language={state.language} onClose={() => setScannerOpen(false)} onAddUnknown={barcode => { setScannerOpen(false); setForm({ open: true, product: null, mode: 'create', initialSection: 'identity', initialBarcode: barcode }); }} onScan={barcode => {
      const product = findProductByExactBarcode(productsByBarcode, barcode);
      if (!product) return { kind: 'unknown', barcode };
      setQuery(barcode);
      setExactScanBarcode(barcode);
      setFilters(EMPTY_PRODUCT_FILTERS);
      setScannerOpen(false);
      haptics.success();
      snackbar.show({ text: copy.scanner.found, tone: 'success' });
      return { kind: 'success', title: product.name };
    }} />
  </ScreenContainer>;
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.sm, gap: spacing.xs },
  searchRow: { alignItems: 'flex-end', gap: spacing.xs }, searchInput: { minWidth: 0, flex: 1 },
  titleRow: { minHeight: 48, alignItems: 'center', gap: spacing.xs }, titleCopy: { minWidth: 0, flex: 1 },
  categoryButton: { minWidth: 44, minHeight: 44, paddingHorizontal: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', gap: spacing.xxs }, addButton: { minWidth: 88 },
  toolRow: { minHeight: 44, alignItems: 'center', gap: spacing.xs }, toolButton: { minHeight: 44, paddingHorizontal: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', gap: spacing.xxs }, resultCount: { minWidth: 0, flex: 1, alignItems: 'center', gap: spacing.xxs }, resultContext: { minWidth: 0, flexShrink: 1 },
  quickFilters: { gap: spacing.xs, paddingEnd: spacing.xs },
  list: { padding: spacing.md }, emptyList: { flexGrow: 1, justifyContent: 'center' }, separator: { height: PRODUCT_ROW_GAP }, pressed: { opacity: 0.76, transform: [{ scale: 0.98 }] },
});
