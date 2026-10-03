import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { AppButton, AppInput, BottomSheet, EmptyState, ListItem, SearchInput, StatusChip, useSnackbar } from '@/components/ui';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';
import { uiText } from '@/i18n';
import { formatNumber } from '@/utils/formatters';

type Props = {
  visible: boolean;
  onClose: () => void;
  value?: string;
  onSelect?: (category: string) => void;
  management?: boolean;
};

export function CategoryPickerSheet({ visible, onClose, value, onSelect, management = false }: Props) {
  const { colors } = useAppTheme();
  const { language, categories, products, createCategory } = useAppStore();
  const snackbar = useSnackbar();
  const rtl = language === 'ar';
  const copy = uiText(language);
  const [query, setQuery] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (visible) { setQuery(''); setNewCategory(''); }
  }, [visible]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return categories.filter(item => !normalized || item.toLocaleLowerCase().includes(normalized));
  }, [categories, query]);
  const counts = useMemo(() => products.reduce<Record<string, number>>((map, product) => {
    map[product.category] = (map[product.category] ?? 0) + 1;
    return map;
  }, {}), [products]);

  const addCategory = async () => {
    const normalized = newCategory.trim();
    if (!normalized || savingRef.current) return;
    const existing = categories.find(item => item.toLocaleLowerCase() === normalized.toLocaleLowerCase());
    if (existing) {
      setNewCategory('');
      onSelect?.(existing);
      if (!management) onClose();
      return;
    }
    savingRef.current = true; setSaving(true);
    try {
      await createCategory(normalized);
      haptics.success();
      snackbar.show({ text: copy.categories.added, tone: 'success' });
      setNewCategory('');
      onSelect?.(normalized);
      if (!management) onClose();
    } catch (error) {
      if (__DEV__) console.error('[CategoryCreationFailed]', error);
      haptics.error();
      snackbar.show({ text: copy.categories.addFailed, tone: 'error' });
    } finally { savingRef.current = false; setSaving(false); }
  };

  return <BottomSheet visible={visible} onClose={onClose} title={management ? copy.categories.manageTitle : copy.categories.chooseTitle} rtl={rtl} scrollable keyboardAware>
    <View style={styles.content}>
      <SearchInput value={query} onChangeText={setQuery} placeholder={copy.categories.search} clearLabel={copy.common.clearSearch} rtl={rtl} />
      <View style={[styles.creator, { backgroundColor: colors.surfaceSecondary }]}>
        <Text style={[typography.label, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{copy.categories.newCategory}</Text>
        <View style={[styles.creatorRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
          <AppInput value={newCategory} onChangeText={setNewCategory} onSubmitEditing={() => void addCategory()} placeholder={copy.categories.name} accessibilityLabel={copy.categories.accessibleName} rtl={rtl} containerStyle={styles.creatorInput} returnKeyType="done" />
          <AppButton label={copy.common.add} icon="plus" onPress={() => void addCategory()} loading={saving} disabled={!newCategory.trim()} style={styles.addButton} />
        </View>
      </View>
      <View style={styles.list}>
        {filtered.map(category => {
          const selected = category === value;
          const count = formatNumber(counts[category] ?? 0, language);
          return <ListItem key={category} title={category} description={copy.categories.count(count)} icon="tag" rtl={rtl} haptic="selection" onPress={onSelect ? () => { onSelect(category); onClose(); } : undefined} trailing={selected ? <Feather name="check-circle" size={20} color={colors.primary} /> : <StatusChip label={count} tone="info" />} />;
        })}
      </View>
      {filtered.length === 0 && <EmptyState icon="search" title={copy.categories.noResults} description={copy.categories.noResultsDescription} />}
      {management && <Text style={[typography.caption, styles.note, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.categories.limitations}</Text>}
    </View>
  </BottomSheet>;
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.sm, gap: spacing.sm },
  creator: { padding: spacing.sm, borderRadius: radius.md, gap: spacing.xs }, creatorRow: { alignItems: 'flex-start', gap: spacing.xs }, creatorInput: { flex: 1 }, addButton: { minWidth: 92, minHeight: 48 },
  list: { gap: 0 }, note: { paddingHorizontal: spacing.sm, paddingTop: spacing.xs },
});
