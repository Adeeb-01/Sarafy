import { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useAppStore } from '@/store/useAppStore';
import { formatNumber } from '@/utils/formatters';
import { t } from '@/i18n';
import { AppButton, AppInput, AppSwitch, BottomSheet, monetaryFontSizeFor, StatusChip, useSnackbar } from '@/components/ui';
import { motion, radius, spacing, typography, useAppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';
import { uiText } from '@/i18n';
import { RateHistoryScreen } from '@/components/RateHistoryScreen';
import type { ExchangeRateHistoryEntry } from '@/types';
import { formatExchangeRateChange } from '@/utils/exchangeRate';

export function RateControl() {
  const { colors } = useAppTheme();
  const { exchangeRate, isRoundingEnabled, roundingTarget, language, updateSetting, updateExchangeRate, getExchangeRateHistory, latestRateChange } = useAppStore();
  const rtl = language === 'ar'; const formattedRate = formatNumber(exchangeRate, language);
  const copy = uiText(language); const snackbar = useSnackbar();
  const rateFontSize = monetaryFontSizeFor(formattedRate, false);
  const [open, setOpen] = useState(false); const [draft, setDraft] = useState(String(exchangeRate)); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false); const [history, setHistory] = useState<ExchangeRateHistoryEntry[]>([]);
  const savingRef = useRef(false);
  const progress = useSharedValue(isRoundingEnabled ? 1 : 0);
  useEffect(() => { progress.value = withTiming(isRoundingEnabled ? 1 : 0, { duration: motion.duration.normal, reduceMotion: ReduceMotion.System }); }, [isRoundingEnabled, progress]);
  const animated = useAnimatedStyle(() => ({ opacity: 0.72 + progress.value * 0.28 }));
  const closeRateSheet = () => { Keyboard.dismiss(); setOpen(false); };

  const saveRate = async () => {
    if (savingRef.current) return;
    const value = Number(draft.replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) { haptics.error(); setError(t(language, 'invalidRate')); return; }
    savingRef.current = true; setSaving(true); setError('');
    try { const entry = await updateExchangeRate(value); haptics.success(); snackbar.show({ text: entry ? copy.rate.updated : copy.rate.sameRate, tone: 'success' }); Keyboard.dismiss(); requestAnimationFrame(() => setOpen(false)); }
    catch (failure) { if (__DEV__) console.error('[ExchangeRateUpdateFailed]', failure); haptics.error(); snackbar.show({ text: copy.rate.updateFailed, tone: 'error' }); }
    finally { savingRef.current = false; setSaving(false); }
  };

  return <>
    <View style={[styles.shell, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
      <View style={[styles.brandRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Text style={[typography.subtitle, { color: colors.textPrimary }]}>{t(language, 'appName')}</Text><StatusChip label={t(language, 'offlineStatus')} tone="success" icon="wifi-off" /></View>
      <View style={[styles.rateRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
        <View style={styles.rateCopy}><Text style={[typography.caption, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{t(language, 'rate')}</Text><View style={[styles.valueRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Text style={[typography.label, { color: colors.textSecondary }]}>1$ =</Text><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85} maxFontSizeMultiplier={1.2} style={[typography.numericLarge, styles.rateValue, { color: colors.primary, fontSize: rateFontSize, lineHeight: rateFontSize + 6 }]}>{formattedRate}</Text><Text style={[typography.caption, { color: colors.textSecondary }]}>{t(language, 'syp')}</Text></View>{latestRateChange ? <Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.rate.lastUpdated}: {new Date(latestRateChange.created_at).toLocaleString(language === 'ar' ? 'ar-SY' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })} · {formatRateChange(latestRateChange.old_rate, latestRateChange.new_rate, language)}</Text> : <Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.rate.noHistory}</Text>}</View>
        <Pressable accessibilityRole="button" accessibilityLabel={t(language, 'editRate')} accessibilityHint={copy.rate.editHint} onPress={() => { haptics.tap(); setDraft(String(exchangeRate)); setError(''); setOpen(true); }} style={({ pressed }) => [styles.editButton, { backgroundColor: colors.primarySoft }, pressed && styles.pressed]}><Feather name="edit-2" size={18} color={colors.primary} /></Pressable>
      </View>
      <Animated.View style={[styles.rounding, animated, { backgroundColor: colors.surfaceSecondary, flexDirection: rtl ? 'row-reverse' : 'row' }]}><View style={[styles.roundingCopy, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Feather name="repeat" size={16} color={colors.warning} /><Text style={[typography.bodyMedium, { color: colors.textPrimary }]}>{t(language, 'rounding')}</Text><Text style={[typography.caption, { color: colors.textMuted }]}>{formatNumber(roundingTarget, language)} {t(language, 'syp')}</Text></View><AppSwitch label={t(language, 'rounding')} value={isRoundingEnabled} onValueChange={value => void updateSetting('isRoundingEnabled', value)} /></Animated.View>
      <Pressable accessibilityRole="button" accessibilityLabel={copy.rate.history} accessibilityHint={copy.rate.historyHint} onPress={() => { void getExchangeRateHistory().then(rows => { setHistory(rows); setHistoryOpen(true); }).catch(() => snackbar.show({ text: copy.rate.updateFailed, tone: 'error' })); }} style={({ pressed }) => [styles.historyButton, { flexDirection: rtl ? 'row-reverse' : 'row' }, pressed && styles.pressed]}><Feather name="clock" size={17} color={colors.primary} /><Text style={[typography.label, { color: colors.primary }]}>{copy.rate.history}</Text></Pressable>
    </View>
    <BottomSheet visible={open} onClose={saving ? () => undefined : closeRateSheet} title={t(language, 'editRate')} rtl={rtl} keyboardAware><View style={styles.sheetBody}><Text style={[typography.body, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{t(language, 'exchangeRate')}</Text><AppInput autoFocus keyboardType="numeric" returnKeyType="done" onSubmitEditing={() => void saveRate()} value={draft} onChangeText={setDraft} error={error} rtl={rtl} accessibilityLabel={copy.rate.input} selectTextOnFocus trailing={<Text style={[typography.label, { color: colors.primary }]}>{t(language, 'syp')}</Text>} /><View style={[styles.actions, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><AppButton label={t(language, 'cancel')} onPress={closeRateSheet} variant="secondary" disabled={saving} style={styles.action} /><AppButton label={t(language, 'save')} onPress={() => void saveRate()} loading={saving} style={styles.action} /></View></View></BottomSheet>
    <RateHistoryScreen visible={historyOpen} entries={history} language={language} onClose={() => setHistoryOpen(false)} />
  </>;
}

const styles = StyleSheet.create({
  shell: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.sm, gap: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  brandRow: { minHeight: 30, alignItems: 'center', justifyContent: 'space-between', gap: spacing.xs },
  rateRow: { minHeight: 48, alignItems: 'center', gap: spacing.xs }, rateCopy: { flex: 1, minWidth: 0, gap: 0 },
  valueRow: { minWidth: 0, alignItems: 'baseline', gap: spacing.xxs }, rateValue: { flexShrink: 1, minWidth: 0, writingDirection: 'ltr', fontVariant: ['tabular-nums'] },
  editButton: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  rounding: { minHeight: 44, paddingStart: spacing.sm, paddingEnd: spacing.xxs, borderRadius: radius.md, alignItems: 'center', justifyContent: 'space-between', gap: spacing.xs }, roundingCopy: { flex: 1, minWidth: 0, alignItems: 'center', gap: spacing.xs }, historyButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  pressed: { opacity: 0.76, transform: [{ scale: 0.96 }] }, sheetBody: { gap: spacing.xs, paddingBottom: spacing.xxs }, actions: { gap: spacing.xs, marginTop: spacing.xs }, action: { flex: 1 },
});

function formatRateChange(oldRate: number, newRate: number, language: 'ar' | 'en') {
  return formatExchangeRateChange(oldRate, newRate, language === 'ar' ? 'ar-SY' : 'en-US') ?? '0%';
}
