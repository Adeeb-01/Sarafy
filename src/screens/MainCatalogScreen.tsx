import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, useWindowDimensions, View } from 'react-native';
import { RateControl } from '@/components/RateControl';
import { ProductCard } from '@/components/ProductCard';
import { EmptyState, FilterChip, ScreenContainer, SearchInput, SectionHeader, StatusChip } from '@/components/ui';
import { useAppStore } from '@/store/useAppStore';
import { spacing, useAppTheme } from '@/theme';
import { t, uiText } from '@/i18n';

export function MainCatalogScreen({ onManageProducts }: { onManageProducts?: () => void }) {
  const state = useAppStore(); const { colors } = useAppTheme(); const { width } = useWindowDimensions();
  const columns = width >= 1000 ? 4 : width >= 700 ? 3 : 2; const cellWidth = (width - spacing.xxl - spacing.xs * (columns - 1)) / columns;
  const rtl = state.language === 'ar'; const [query, setQuery] = useState(''); const [category, setCategory] = useState('all');
  const copy = uiText(state.language);
  const categories = useMemo(() => Array.from(new Set(state.products.map(product => product.category))).sort(), [state.products]);
  const products = useMemo(() => { const normalized = query.trim().toLowerCase(); return state.products.filter(product => (category === 'all' || product.category === category) && (!normalized || product.name.toLowerCase().includes(normalized) || product.barcode?.toLowerCase().includes(normalized))); }, [state.products, query, category]);
  const hasFilters = query.trim().length > 0 || category !== 'all';

  return <ScreenContainer><FlatList data={products} keyExtractor={item => String(item.id)} key={columns} numColumns={columns} columnWrapperStyle={styles.columns} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled" initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7} removeClippedSubviews
    renderItem={({ item }) => <View style={{ width: cellWidth }}><ProductCard product={item} settings={state} /></View>}
    ListHeaderComponent={<View><RateControl /><View style={styles.tools}><View style={[styles.headingRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><SectionHeader title={t(state.language, 'catalogTitle')} subtitle={t(state.language, 'catalogSubtitle')} rtl={rtl} /><StatusChip label={`${products.length} ${t(state.language, 'itemCount')}`} tone="info" /></View><SearchInput value={query} onChangeText={setQuery} placeholder={t(state.language, 'search')} clearLabel={copy.common.clearSearch} rtl={rtl} />
      <FlatList horizontal inverted={rtl} showsHorizontalScrollIndicator={false} data={['all', ...categories]} keyExtractor={item => item} contentContainerStyle={styles.filters} renderItem={({ item }) => <FilterChip label={item === 'all' ? t(state.language, 'all') : item} selected={category === item} onPress={() => setCategory(item)} />} />
    </View></View>}
    ListEmptyComponent={<View style={[styles.empty, { backgroundColor: colors.surface }]}><EmptyState icon={hasFilters ? 'search' : 'package'} title={hasFilters ? t(state.language, 'noProducts') : copy.catalog.emptyTitle} description={hasFilters ? copy.catalog.searchEmptyDescription : copy.catalog.emptyDescription} actionLabel={!hasFilters && onManageProducts ? t(state.language, 'addProduct') : undefined} onAction={!hasFilters ? onManageProducts : undefined} /></View>}
  /></ScreenContainer>;
}

const styles = StyleSheet.create({ list: { paddingBottom: spacing.lg }, tools: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs }, headingRow: { alignItems: 'center', justifyContent: 'space-between', gap: spacing.xs }, filters: { gap: spacing.xs }, columns: { paddingHorizontal: spacing.md, gap: spacing.xs, marginBottom: spacing.xs }, empty: { marginHorizontal: spacing.md }, });
