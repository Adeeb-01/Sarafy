import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeInDown, FadeOutDown, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout, radius, shadows, spacing, typography, useAppTheme } from '@/theme';

type Tone = 'success' | 'error' | 'info';
type Message = { text: string; tone?: Tone; actionLabel?: string; onAction?: () => void; duration?: number };
type SnackbarApi = { show: (message: Message) => void; dismiss: () => void };
const SnackbarContext = createContext<SnackbarApi | null>(null);

export function SnackbarProvider({ children, bottomInset }: PropsWithChildren<{ bottomInset?: number }>) {
  const { colors } = useAppTheme(); const insets = useSafeAreaInsets(); const [message, setMessage] = useState<Message | null>(null); const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismiss = useCallback(() => { if (timeout.current) clearTimeout(timeout.current); timeout.current = null; setMessage(null); }, []);
  const show = useCallback((next: Message) => {
    if (timeout.current) clearTimeout(timeout.current);
    setMessage(next);
    timeout.current = setTimeout(() => { timeout.current = null; setMessage(null); }, next.duration ?? 3600);
  }, []);
  useEffect(() => () => { if (timeout.current) clearTimeout(timeout.current); }, []);
  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const toneColor = message?.tone === 'error' ? colors.danger : message?.tone === 'success' ? colors.success : colors.primary;
  const toneSoft = message?.tone === 'error' ? colors.dangerSoft : message?.tone === 'success' ? colors.successSoft : colors.primarySoft;
  const resolvedBottomInset = bottomInset && bottomInset > 0 ? bottomInset : insets.bottom + layout.bottomNavigationHeight;
  return <SnackbarContext.Provider value={value}>{children}{message && <Animated.View entering={FadeInDown.duration(180).reduceMotion(ReduceMotion.System)} exiting={FadeOutDown.duration(140).reduceMotion(ReduceMotion.System)} accessibilityLiveRegion="polite" style={[styles.snackbar, { backgroundColor: colors.surfaceElevated, bottom: resolvedBottomInset + spacing.xs }, shadows.sheet]}>
    <View style={[styles.icon, { backgroundColor: toneSoft }]}><Feather name={message.tone === 'error' ? 'alert-circle' : message.tone === 'success' ? 'check' : 'info'} size={18} color={toneColor} /></View><Text style={[typography.bodyMedium, { color: colors.textPrimary, flex: 1 }]}>{message.text}</Text>{message.actionLabel && <Pressable accessibilityRole="button" accessibilityLabel={message.actionLabel} onPress={() => { message.onAction?.(); dismiss(); }} style={styles.action}><Text style={[typography.label, { color: colors.primary }]}>{message.actionLabel}</Text></Pressable>}
  </Animated.View>}</SnackbarContext.Provider>;
}

export function useSnackbar() { const value = useContext(SnackbarContext); if (!value) throw new Error('useSnackbar must be used inside SnackbarProvider'); return value; }

const styles = StyleSheet.create({ snackbar: { position: 'absolute', zIndex: 50, left: spacing.md, right: spacing.md, minHeight: 52, borderRadius: radius.md, paddingHorizontal: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.xs }, icon: { width: 30, height: 30, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' }, action: { minWidth: layout.minimumTouchTarget, minHeight: layout.minimumTouchTarget, alignItems: 'center', justifyContent: 'center' } });
