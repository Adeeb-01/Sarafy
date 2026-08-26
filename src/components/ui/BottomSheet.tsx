import { PropsWithChildren, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardEvent, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeIn, FadeOut, ReduceMotion, SlideInDown, SlideOutDown, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton } from '@/components/ui/AppButton';
import { calculateKeyboardAwareMaxHeight, calculateKeyboardInset } from '@/components/ui/bottomSheetKeyboard';
import type { KeyboardBounds, ViewportBounds } from '@/components/ui/bottomSheetKeyboard';
import { uiText } from '@/i18n';
import { motion, radius, shadows, spacing, typography, useAppTheme } from '@/theme';

type BottomSheetProps = PropsWithChildren<{
  visible: boolean;
  onClose: () => void;
  title?: string;
  rtl?: boolean;
  scrollable?: boolean;
  keyboardAware?: boolean;
}>;

export function BottomSheet({ visible, onClose, title, children, rtl = false, scrollable = false, keyboardAware = false }: BottomSheetProps) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const copy = uiText(rtl ? 'ar' : 'en');
  const hostRef = useRef<View>(null);
  const [viewport, setViewport] = useState<ViewportBounds>({ y: 0, height: window.height });
  const [keyboard, setKeyboard] = useState<KeyboardBounds | null>(null);
  const keyboardOffset = useSharedValue(0);

  const measureViewport = useCallback(() => {
    hostRef.current?.measureInWindow((_x, y, _width, height) => {
      if (height > 0) setViewport({ y, height });
    });
  }, []);

  useEffect(() => {
    if (!visible || !keyboardAware) {
      setKeyboard(null);
      return;
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (event: KeyboardEvent) => {
      setKeyboard({ screenY: event.endCoordinates.screenY, height: event.endCoordinates.height });
      requestAnimationFrame(measureViewport);
    };
    const showSubscription = Keyboard.addListener(showEvent, onShow);
    const hideSubscription = Keyboard.addListener(hideEvent, () => { setKeyboard(null); requestAnimationFrame(measureViewport); });
    requestAnimationFrame(measureViewport);
    return () => { showSubscription.remove(); hideSubscription.remove(); };
  }, [keyboardAware, measureViewport, visible]);

  useEffect(() => { requestAnimationFrame(measureViewport); }, [measureViewport, window.height, window.width]);

  const keyboardInset = keyboardAware ? calculateKeyboardInset(viewport, keyboard) : 0;
  const keyboardVisible = keyboard !== null;
  const keyboardMaximumHeight = calculateKeyboardAwareMaxHeight({
    viewportHeight: viewport.height,
    keyboardInset,
    safeAreaTop: insets.top,
    safeAreaBottom: insets.bottom,
  });
  useEffect(() => {
    keyboardOffset.value = withTiming(-keyboardInset, { duration: motion.duration.normal, easing: motion.easing, reduceMotion: ReduceMotion.System });
  }, [keyboardInset, keyboardOffset]);
  const keyboardStyle = useAnimatedStyle(() => ({ transform: [{ translateY: keyboardOffset.value }] }));

  const requestClose = () => {
    if (keyboardAware && keyboardVisible) { Keyboard.dismiss(); return; }
    onClose();
  };
  const shouldScroll = scrollable || keyboardAware;
  const content = shouldScroll
    ? <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" nestedScrollEnabled showsVerticalScrollIndicator={false}>{children}</ScrollView>
    : children;

  return <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
    <View ref={hostRef} onLayout={measureViewport} style={styles.host}><Animated.View entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)} style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}><Pressable accessibilityRole="button" accessibilityLabel={copy.common.close} onPress={requestClose} style={StyleSheet.absoluteFill} /></Animated.View>
      <Animated.View style={[styles.sheetLift, keyboardStyle]}>
        <Animated.View accessibilityViewIsModal entering={SlideInDown.duration(220).reduceMotion(ReduceMotion.System)} exiting={SlideOutDown.duration(180).reduceMotion(ReduceMotion.System)} style={[styles.sheet, keyboardAware && keyboardVisible && { maxHeight: keyboardMaximumHeight }, { backgroundColor: colors.surfaceElevated, paddingBottom: spacing.sm + insets.bottom }, shadows.sheet]}>
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          {title && <View style={[styles.header, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Text style={[typography.title, { flex: 1, color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{title}</Text><Pressable accessibilityRole="button" accessibilityLabel={copy.common.close} onPress={onClose} style={styles.close}><Feather name="x" size={21} color={colors.textSecondary} /></Pressable></View>}
          {content}
        </Animated.View>
      </Animated.View>
    </View>
  </Modal>;
}

export function ConfirmSheet({ visible, onClose, onConfirm, title, description, icon, confirmLabel, cancelLabel, tone = 'info', isDestructive = false, loading = false, rtl = false, children }: { visible: boolean; onClose: () => void; onConfirm: () => void; title: string; description: string; icon?: keyof typeof Feather.glyphMap; confirmLabel: string; cancelLabel: string; tone?: 'info' | 'warning' | 'danger' | 'success'; isDestructive?: boolean; loading?: boolean; rtl?: boolean; children?: ReactNode }) {
  const resolvedTone = isDestructive ? 'danger' : tone;
  const { colors } = useAppTheme(); const color = resolvedTone === 'info' ? colors.primary : colors[resolvedTone]; const soft = resolvedTone === 'info' ? colors.primarySoft : colors[`${resolvedTone}Soft` as const];
  return <BottomSheet visible={visible} onClose={loading ? () => undefined : onClose} rtl={rtl}><View style={styles.confirm}>
    <View style={[styles.confirmIcon, { backgroundColor: soft }]}><Feather name={icon ?? (resolvedTone === 'danger' ? 'trash-2' : resolvedTone === 'warning' ? 'alert-triangle' : resolvedTone === 'success' ? 'check' : 'info')} size={25} color={color} /></View>
    <Text style={[typography.titleLarge, { color: colors.textPrimary, textAlign: 'center' }]}>{title}</Text><Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>{description}</Text>{children}
    <View style={[styles.actions, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><AppButton label={cancelLabel} onPress={onClose} variant="secondary" disabled={loading} style={styles.action} /><AppButton label={confirmLabel} onPress={onConfirm} variant={resolvedTone === 'danger' ? 'danger' : 'primary'} loading={loading} style={styles.action} /></View>
  </View></BottomSheet>;
}

export function ActionSheet({ visible, onClose, title, children, rtl = false }: PropsWithChildren<{ visible: boolean; onClose: () => void; title: string; rtl?: boolean }>) { return <BottomSheet visible={visible} onClose={onClose} title={title} rtl={rtl}>{children}</BottomSheet>; }

const styles = StyleSheet.create({ host: { flex: 1, justifyContent: 'flex-end' }, sheetLift: { width: '100%', maxHeight: '100%' }, sheet: { maxHeight: '88%', borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingHorizontal: spacing.md, paddingTop: spacing.xs }, scroll: { flexShrink: 1 }, scrollContent: { flexGrow: 0 }, handle: { width: 40, height: 4, borderRadius: radius.pill, alignSelf: 'center', marginBottom: spacing.xxs }, header: { minHeight: 44, marginBottom: spacing.xxs, alignItems: 'center', gap: spacing.xs }, close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, confirm: { alignItems: 'center', paddingTop: spacing.xs, gap: spacing.xxs }, confirmIcon: { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xxs }, actions: { alignSelf: 'stretch', gap: spacing.xs, marginTop: spacing.sm }, action: { flex: 1 } });
