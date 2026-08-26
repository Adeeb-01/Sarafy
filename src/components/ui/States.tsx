import { useEffect } from 'react';
import { ActivityIndicator, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, { cancelAnimation, ReduceMotion, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { AppButton } from '@/components/ui/AppButton';
import { radius, spacing, typography, useAppTheme } from '@/theme';

export function EmptyState({ title, description, icon = 'inbox', actionLabel, onAction, compact = false }: { title: string; description: string; icon?: keyof typeof Feather.glyphMap; actionLabel?: string; onAction?: () => void; compact?: boolean }) {
  const { colors } = useAppTheme();
  return <View style={[styles.state, compact && styles.compactState]}><View style={[styles.stateIcon, { backgroundColor: colors.primarySoft }]}><Feather name={icon} size={25} color={colors.primary} /></View><Text style={[typography.title, { color: colors.textPrimary, textAlign: 'center' }]}>{title}</Text><Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>{description}</Text>{actionLabel && onAction && <AppButton label={actionLabel} onPress={onAction} style={styles.action} />}</View>;
}

export function ErrorState({ title, description, retryLabel, onRetry, retrying = false }: { title: string; description: string; retryLabel: string; onRetry: () => void; retrying?: boolean }) {
  const { colors } = useAppTheme();
  return <View style={styles.state}><View style={[styles.stateIcon, { backgroundColor: colors.dangerSoft }]}><Feather name="alert-circle" size={25} color={colors.danger} /></View><Text style={[typography.title, { color: colors.textPrimary, textAlign: 'center' }]}>{title}</Text><Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>{description}</Text><AppButton label={retryLabel} onPress={onRetry} variant="secondary" loading={retrying} style={styles.action} /></View>;
}

export function LoadingState({ label }: { label: string }) {
  const { colors } = useAppTheme();
  return <View accessibilityRole="progressbar" accessibilityLabel={label} style={styles.loading}><ActivityIndicator size="large" color={colors.primary} /><Text style={[typography.body, { color: colors.textSecondary }]}>{label}</Text></View>;
}

export function Skeleton({ width = '100%', height = 16, radius: cornerRadius = radius.sm, style }: { width?: number | `${number}%`; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const { colors } = useAppTheme(); const opacity = useSharedValue(0.48);
  useEffect(() => { opacity.value = withRepeat(withTiming(0.9, { duration: 700, reduceMotion: ReduceMotion.System }), -1, true); return () => cancelAnimation(opacity); }, [opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View accessible={false} style={[{ width, height, borderRadius: cornerRadius, backgroundColor: colors.skeleton }, animated, style]} />;
}

const styles = StyleSheet.create({ state: { minHeight: 176, padding: spacing.lg, alignItems: 'center', justifyContent: 'center', gap: spacing.xs }, compactState: { minHeight: 132, paddingVertical: spacing.md }, stateIcon: { width: 46, height: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }, action: { marginTop: spacing.xxs, minWidth: 144 }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm } });
