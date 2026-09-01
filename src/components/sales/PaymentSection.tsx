import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppInput, MonetaryValue } from '@/components/ui';
import { uiText } from '@/i18n';
import { Language } from '@/types';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { formatNumber } from '@/utils/formatters';
import { PaymentCalculation, paymentSuggestions } from '@/utils/salesUiState';

export function PaymentSection({ total, amount, exact, calculation, language, onAmountChange, onExact, onSuggestion }:
  { total: number; amount: string; exact: boolean; calculation: PaymentCalculation; language: Language; onAmountChange: (value: string) => void; onExact: () => void; onSuggestion: (value: number) => void }) {
  const { colors } = useAppTheme();
  const copy = uiText(language);
  const rtl = language === 'ar';
  const suggestions = paymentSuggestions(total);
  const error = calculation.valid ? undefined : calculation.reason === 'insufficient' ? copy.sales.insufficientPayment : calculation.reason === 'negative' ? copy.sales.negativePayment : copy.sales.invalidPayment;
  return <View style={styles.section}>
    <Text style={[typography.title, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.payment}</Text>
    <AppInput label={copy.sales.amountPaid} value={exact ? formatNumber(total, 'en') : amount} onChangeText={onAmountChange} error={error}
      placeholder="0" keyboardType="number-pad" accessibilityLabel={copy.sales.amountPaidAccessibility} rtl={rtl}
      style={styles.technicalInput}
      trailing={<View style={[styles.currency, { backgroundColor: colors.surfaceSecondary }]}><Text style={[typography.label, { color: colors.textSecondary }]}>{copy.common.syp}</Text></View>} />
    <View style={[styles.quick, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
      <QuickAmount label={copy.sales.fullAmount} selected={exact} onPress={onExact} />
      {suggestions.filter(value => value !== total).map(value => <QuickAmount key={value} label={formatNumber(value, language)} selected={!exact && calculation.valid && calculation.amountPaidSyp === value} onPress={() => onSuggestion(value)} />)}
    </View>
    <View style={[styles.change, { backgroundColor: calculation.valid ? colors.successSoft : colors.surfaceSecondary, flexDirection: rtl ? 'row-reverse' : 'row' }]}>
      <Text style={[typography.bodyMedium, { color: calculation.valid ? colors.success : colors.textSecondary }]}>{copy.sales.change}</Text>
      <MonetaryValue value={calculation.valid ? calculation.changeSyp : 0} language={language} currencyLabel={copy.common.syp} inline
        style={{ flexDirection: rtl ? 'row-reverse' : 'row' }} textStyle={styles.changeValue} />
    </View>
  </View>;
}

function QuickAmount({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors } = useAppTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress}
    style={({ pressed }) => [styles.chip, { backgroundColor: selected ? colors.primarySoft : colors.surfaceSecondary, borderColor: selected ? colors.primary : colors.border }, pressed && styles.pressed]}>
    <Text numberOfLines={1} style={[typography.label, { color: selected ? colors.primary : colors.textSecondary }]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  section: { gap: spacing.xs, paddingTop: spacing.sm }, currency: { minHeight: 32, paddingHorizontal: spacing.xs, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  quick: { flexWrap: 'wrap', gap: spacing.xs }, chip: { minHeight: 44, minWidth: 92, paddingHorizontal: spacing.sm, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.76 }, change: { minHeight: 52, paddingHorizontal: spacing.sm, borderRadius: radius.md, alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  technicalInput: { writingDirection: 'ltr' },
  changeValue: { ...typography.numericTotal, fontSize: 19, lineHeight: 25 },
});
