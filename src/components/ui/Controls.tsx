import { useEffect, useState } from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { haptics } from '@/utils/haptics';
import { motion, radius, spacing, typography, useAppTheme } from '@/theme';
import { formatNumber } from '@/utils/formatters';

export function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors } = useAppTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={() => { if (!selected) haptics.selection(); onPress(); }} style={({ pressed }) => [styles.chip, { backgroundColor: selected ? colors.primarySoft : colors.surface, borderColor: selected ? colors.primary : colors.border }, pressed && styles.pressed]}>
    <Text style={[typography.label, { color: selected ? colors.primary : colors.textSecondary }]}>{label}</Text>
  </Pressable>;
}

export function StatusChip({ label, tone = 'info', icon }: { label: string; tone?: 'success' | 'warning' | 'danger' | 'info'; icon?: keyof typeof Feather.glyphMap }) {
  const { colors } = useAppTheme();
  const color = tone === 'info' ? colors.primary : colors[tone];
  const backgroundColor = tone === 'info' ? colors.primarySoft : colors[`${tone}Soft` as const];
  return <View style={[styles.status, { backgroundColor }]}>{icon && <Feather name={icon} size={13} color={color} />}{label ? <Text style={[typography.caption, { color }]}>{label}</Text> : null}</View>;
}

export function SegmentedControl<T extends string | number>({ options, value, onChange, rtl = false, accessibilityLabel, subtle = false, compactLabels = false }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; rtl?: boolean; accessibilityLabel?: string; subtle?: boolean; compactLabels?: boolean }) {
  const { colors, isDark } = useAppTheme(); const [width, setWidth] = useState(0);
  const selectedIndex = options.findIndex(option => option.value === value);
  const physicalIndex = selectedIndex < 0 ? -1 : rtl ? options.length - 1 - selectedIndex : selectedIndex;
  const itemWidth = options.length > 0 ? (width - spacing.xs - spacing.xxs * (options.length - 1)) / options.length : 0;
  const translate = useSharedValue(0);
  useEffect(() => { if (physicalIndex >= 0) translate.value = withTiming(physicalIndex * (itemWidth + spacing.xxs), { duration: motion.duration.normal, easing: motion.easing, reduceMotion: ReduceMotion.System }); }, [itemWidth, physicalIndex, translate]);
  const indicatorStyle = useAnimatedStyle(() => ({ width: itemWidth, transform: [{ translateX: translate.value }] }));
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  return <View onLayout={onLayout} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={[styles.segment, { backgroundColor: colors.surfaceSecondary, flexDirection: rtl ? 'row-reverse' : 'row' }]}>
    {itemWidth > 0 && selectedIndex >= 0 && <Animated.View pointerEvents="none" style={[styles.segmentIndicator, { backgroundColor: colors.primarySoft, opacity: subtle ? (isDark ? 0.68 : 0.84) : 1 }, indicatorStyle]} />}
    {options.map(option => { const active = option.value === value; return <Pressable key={String(option.value)} accessibilityRole="radio" accessibilityState={{ checked: active }} onPress={() => { if (!active) { haptics.selection(); onChange(option.value); } }} style={({ pressed }) => [styles.segmentItem, compactLabels && styles.segmentItemCompact, pressed && styles.pressed]}><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={compactLabels ? 0.75 : 0.82} maxFontSizeMultiplier={1.2} style={[typography.label, compactLabels && styles.segmentLabelCompact, { color: active ? colors.primary : colors.textSecondary }]}>{option.label}</Text></Pressable>; })}
  </View>;
}

export function AppSwitch({ value, onValueChange, label, disabled = false }: { value: boolean; onValueChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  const { colors } = useAppTheme();
  return <Switch accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value, disabled }} disabled={disabled} value={value} onValueChange={next => { haptics.selection(); onValueChange(next); }} trackColor={{ false: colors.disabled, true: colors.success }} thumbColor={colors.onPrimary} />;
}

export function QuantityStepper({ value, onChange, onIncrement, onDecrement, min = 0, max = 999, label, increaseLabel, decreaseLabel, compact = false }: { value: number; onChange: (value: number) => void; onIncrement?: () => void; onDecrement?: () => void; min?: number; max?: number; label: string; increaseLabel: string; decreaseLabel: string; compact?: boolean }) {
  const { colors } = useAppTheme();
  const control = (icon: 'minus' | 'plus', disabled: boolean, accessibilityLabel: string, onPress: () => void) => <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={styles.stepButton}><View style={[compact ? styles.stepVisualCompact : styles.stepVisual, compact && { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}><Feather name={icon} size={compact ? 17 : 18} color={disabled ? colors.disabled : colors.textPrimary} /></View></Pressable>;
  return <View accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ min, max, now: value }} style={[styles.stepper, compact && styles.stepperCompact, { borderColor: colors.border }]}>{control('minus', value <= min, decreaseLabel, () => { haptics.selection(); if (onDecrement) onDecrement(); else onChange(Math.max(min, value - 1)); })}<Text maxFontSizeMultiplier={1.2} style={[typography.numericMedium, styles.stepValue, compact && styles.stepValueCompact, { color: colors.textPrimary }]}>{formatNumber(value, 'en')}</Text>{control('plus', value >= max, increaseLabel, () => { haptics.selection(); if (onIncrement) onIncrement(); else onChange(Math.min(max, value + 1)); })}</View>;
}

const styles = StyleSheet.create({
  chip: { minHeight: 44, paddingHorizontal: spacing.sm, borderRadius: radius.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  status: { minHeight: 26, paddingHorizontal: spacing.xs, borderRadius: radius.pill, flexDirection: 'row', alignItems: 'center', gap: spacing.xxs },
  segment: { position: 'relative', padding: spacing.xxs, borderRadius: radius.md, gap: spacing.xxs, overflow: 'hidden' },
  segmentIndicator: { position: 'absolute', left: spacing.xxs, top: spacing.xxs, bottom: spacing.xxs, borderRadius: radius.sm },
  segmentItem: { zIndex: 1, flex: 1, minHeight: 44, paddingHorizontal: spacing.xxs, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' }, segmentItemCompact: { paddingHorizontal: 2 }, segmentLabelCompact: { fontSize: 11, lineHeight: 16 },
  stepper: { minHeight: 44, borderWidth: 1, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md }, stepperCompact: { gap: 0, borderWidth: 0 }, stepButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, stepVisual: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, stepVisualCompact: { width: 38, height: 38, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' }, stepValue: { minWidth: 32, textAlign: 'center', writingDirection: 'ltr' }, stepValueCompact: { minWidth: 28, fontSize: 16, lineHeight: 22 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
});
