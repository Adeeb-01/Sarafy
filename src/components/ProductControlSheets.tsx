import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { ActionSheet, AppButton, BottomSheet, FilterChip, ListItem, SegmentedControl } from '@/components/ui';
import { Language } from '@/types';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { uiText } from '@/i18n';

export type ProductStatusFilter = 'all' | 'active';
export type ProductImageFilter = 'all' | 'with' | 'without';
export type ProductPriceFilter = 'all' | 'zero' | 'under1' | 'oneToTen' | 'over10';
export type ProductFilters = { category: string; status: ProductStatusFilter; image: ProductImageFilter; price: ProductPriceFilter };
export type ProductSort = 'newest' | 'name' | 'sale' | 'cost' | 'category';

export const EMPTY_PRODUCT_FILTERS: ProductFilters = { category: 'all', status: 'all', image: 'all', price: 'all' };

export function ProductFiltersSheet({ visible, onClose, filters, onChange, onOpenCategory, language }: {
  visible: boolean;
  onClose: () => void;
  filters: ProductFilters;
  onChange: (filters: ProductFilters) => void;
  onOpenCategory: () => void;
  language: Language;
}) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language);
  const update = <K extends keyof ProductFilters>(key: K, value: ProductFilters[K]) => onChange({ ...filters, [key]: value });
  return <BottomSheet visible={visible} onClose={onClose} title={copy.filters.title} rtl={rtl} scrollable>
    <View style={styles.content}>
      <FilterGroup label={copy.filters.status} rtl={rtl}>
        <SegmentedControl rtl={rtl} value={filters.status} onChange={value => update('status', value)} options={[
          { value: 'all', label: copy.common.all }, { value: 'active', label: copy.filters.active },
        ]} />
      </FilterGroup>
      <FilterGroup label={copy.filters.image} rtl={rtl}>
        <SegmentedControl rtl={rtl} value={filters.image} onChange={value => update('image', value)} options={[
          { value: 'all', label: copy.common.all }, { value: 'with', label: copy.filters.withImage }, { value: 'without', label: copy.filters.withoutImage },
        ]} />
      </FilterGroup>
      <FilterGroup label={copy.filters.salePrice} rtl={rtl}>
        <View style={[styles.wrap, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
          {([
            ['all', copy.common.all], ['zero', '$0'], ['under1', '< $1'], ['oneToTen', '$1–10'], ['over10', '> $10'],
          ] as const).map(([value, label]) => <FilterChip key={value} label={label} selected={filters.price === value} onPress={() => update('price', value)} />)}
        </View>
      </FilterGroup>
      <View style={[styles.category, { borderColor: colors.border }]}>
        <ListItem title={copy.filters.category} description={filters.category === 'all' ? copy.filters.allCategories : filters.category} icon="tag" rtl={rtl} onPress={() => { onClose(); setTimeout(onOpenCategory, 180); }} />
      </View>
      <View style={[styles.actions, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
        <AppButton label={copy.common.reset} onPress={() => onChange(EMPTY_PRODUCT_FILTERS)} variant="secondary" style={styles.button} />
        <AppButton label={copy.filters.showResults} onPress={onClose} style={styles.button} />
      </View>
    </View>
  </BottomSheet>;
}

export function ProductSortSheet({ visible, onClose, value, onChange, language }: { visible: boolean; onClose: () => void; value: ProductSort; onChange: (value: ProductSort) => void; language: Language }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language);
  const options: { value: ProductSort; title: string; description: string }[] = [
    { value: 'newest', title: copy.filters.newest, description: copy.filters.byAddedDate },
    { value: 'name', title: copy.filters.productName, description: copy.filters.alphabetical },
    { value: 'sale', title: copy.filters.salePrice, description: copy.filters.highestFirst },
    { value: 'cost', title: copy.filters.costPrice, description: copy.filters.highestFirst },
    { value: 'category', title: copy.filters.category, description: copy.filters.thenProductName },
  ];
  return <ActionSheet visible={visible} onClose={onClose} title={copy.filters.sortTitle} rtl={rtl}>
    {options.map(option => <ListItem key={option.value} title={option.title} description={option.description} rtl={rtl} onPress={() => { onChange(option.value); onClose(); }} trailing={option.value === value ? <Feather name="check-circle" size={20} color={colors.primary} /> : <View style={[styles.radio, { borderColor: colors.border }]} />} />)}
  </ActionSheet>;
}

function FilterGroup({ label, rtl, children }: { label: string; rtl: boolean; children: React.ReactNode }) {
  const { colors } = useAppTheme();
  return <View style={styles.group}><Text style={[typography.label, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{label}</Text>{children}</View>;
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.sm, gap: spacing.md }, group: { gap: spacing.xs }, wrap: { flexWrap: 'wrap', gap: spacing.xs },
  category: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' }, actions: { gap: spacing.xs }, button: { flex: 1 },
  radio: { width: 20, height: 20, borderWidth: 2, borderRadius: radius.pill },
});
