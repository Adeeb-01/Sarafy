import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppInput, MonetaryValue, SegmentedControl } from '@/components/ui';
import { uiText } from '@/i18n';
import { Language, PaymentMode, PaymentSettlement } from '@/types';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { formatNumber } from '@/utils/formatters';

export function PaymentSection({ total, rate, mode, sypAmount, usdAmount, settlement, language, onModeChange, onSypChange, onUsdChange, onExactSyp, onMinimumUsd }:
  { total: number; rate: number; mode: PaymentMode; sypAmount: string; usdAmount: string; settlement: PaymentSettlement | null; language: Language; onModeChange: (value: PaymentMode) => void; onSypChange: (value: string) => void; onUsdChange: (value: string) => void; onExactSyp: () => void; onMinimumUsd: () => void }) {
  const { colors } = useAppTheme();
  const copy = uiText(language);
  const rtl = language === 'ar';
  const paid = settlement?.totalTenderEquivalentSyp ?? 0;
  return <View style={styles.section}>
    <Text style={[typography.title, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.payment.method}</Text>
    <SegmentedControl value={mode} onChange={onModeChange} options={[{ value: 'SYP', label: copy.payment.syp }, { value: 'USD', label: copy.payment.usd }, { value: 'MIXED', label: copy.payment.mixed }]} rtl={rtl} compactLabels accessibilityLabel={copy.payment.method} />
    {mode !== 'USD' && <><AppInput label={copy.payment.sypReceived} value={sypAmount} onChangeText={onSypChange} error={sypAmount.trim() && !settlement ? copy.payment.invalidSyp : undefined} placeholder="0" keyboardType="number-pad" accessibilityLabel={copy.payment.sypReceived} rtl={rtl} style={styles.technicalInput} trailing={<Currency label={copy.common.syp} />} /><QuickAmount label={copy.payment.exactSyp} selected={settlement?.payments.some(row => row.currency === 'SYP' && row.amount_minor === total) ?? false} onPress={onExactSyp} /></>}
    {mode !== 'SYP' && <><AppInput label={copy.payment.usdReceived} value={usdAmount} onChangeText={onUsdChange} error={usdAmount.trim() && !settlement ? copy.payment.invalidUsd : undefined} placeholder="0.00" keyboardType="decimal-pad" accessibilityLabel={copy.payment.usdReceived} rtl={rtl} style={styles.technicalInput} trailing={<Currency label="USD" />} /><QuickAmount label={copy.payment.minimumUsd} selected={false} onPress={onMinimumUsd} /></>}
    <Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.payment.exchangeRate}: <Text style={styles.ltr}>{formatNumber(rate, language)} {copy.common.syp}/USD</Text></Text>
    {(settlement?.payments.some(row => row.currency === 'USD') ?? false) && <Text style={[typography.caption, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{copy.payment.usdEquivalent}: {formatNumber(settlement?.payments.find(row => row.currency === 'USD')?.syp_equivalent ?? 0, language)} {copy.common.syp}</Text>}
    <View style={[styles.change, { backgroundColor: settlement?.valid ? colors.successSoft : colors.surfaceSecondary, flexDirection: rtl ? 'row-reverse' : 'row' }]}>
      <View><Text style={[typography.bodyMedium, { color: settlement?.valid ? colors.success : colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{settlement?.valid ? copy.payment.change : copy.payment.remaining}</Text><Text style={[typography.caption, { color: colors.textMuted, writingDirection: 'ltr' }]}>{copy.payment.totalPaid}: {formatNumber(paid, language)} {copy.common.syp}</Text></View>
      <MonetaryValue value={settlement?.valid ? settlement.changeSyp : settlement?.remainingSyp ?? total} language={language} currencyLabel={copy.common.syp} inline
        style={{ flexDirection: rtl ? 'row-reverse' : 'row' }} textStyle={styles.changeValue} />
    </View>
  </View>;
}

function Currency({ label }: { label: string }) { const { colors } = useAppTheme(); return <View style={[styles.currency, { backgroundColor: colors.surfaceSecondary }]}><Text style={[typography.label, { color: colors.textSecondary }]}>{label}</Text></View>; }

function QuickAmount({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors } = useAppTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress}
    style={({ pressed }) => [styles.chip, { backgroundColor: selected ? colors.primarySoft : colors.surfaceSecondary, borderColor: selected ? colors.primary : colors.border }, pressed && styles.pressed]}>
    <Text numberOfLines={1} style={[typography.label, { color: selected ? colors.primary : colors.textSecondary }]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  section: { gap: spacing.xs, paddingTop: spacing.sm }, currency: { minHeight: 32, paddingHorizontal: spacing.xs, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  quick: { flexWrap: 'wrap', gap: spacing.xs }, chip: { minHeight: 44, alignSelf: 'flex-start', minWidth: 112, paddingHorizontal: spacing.sm, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.76 }, change: { minHeight: 52, paddingHorizontal: spacing.sm, borderRadius: radius.md, alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  technicalInput: { writingDirection: 'ltr' },
  ltr: { writingDirection: 'ltr' },
  changeValue: { ...typography.numericTotal, fontSize: 19, lineHeight: 25 },
});
