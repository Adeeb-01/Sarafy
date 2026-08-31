import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { Feather } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton, MonetaryValue } from '@/components/ui';
import { Language } from '@/types';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { uiText } from '@/i18n';
import { SUPPORTED_RETAIL_BARCODE_TYPES } from '@/utils/barcode';
import { createBarcodeScanGate } from '@/utils/barcodeScanGate';
import { haptics } from '@/utils/haptics';

export type BarcodeScannerMode = 'product-input' | 'product-search' | 'cashier';
export type BarcodeScanOutcome =
  | { kind: 'success'; title: string; quantity?: string; amount?: number }
  | { kind: 'unknown'; barcode: string }
  | { kind: 'inactive'; title: string };

type Props = {
  visible: boolean;
  mode: BarcodeScannerMode;
  language: Language;
  onClose: () => void;
  onScan: (barcode: string, type: string) => BarcodeScanOutcome | Promise<BarcodeScanOutcome>;
  onAddUnknown?: (barcode: string) => void;
  cartItemCount?: string;
  cartTotal?: number;
};

export function BarcodeScannerScreen({ visible, mode, language, onClose, onScan, onAddUnknown, cartItemCount, cartTotal = 0 }: Props) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const copy = uiText(language);
  const rtl = language === 'ar';
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [cameraKey, setCameraKey] = useState(0);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [outcome, setOutcome] = useState<BarcodeScanOutcome | null>(null);
  const gateRef = useRef(createBarcodeScanGate());
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(false);

  const clearFeedbackTimer = useCallback(() => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = null;
  }, []);

  const resetSession = useCallback(() => {
    clearFeedbackTimer();
    setTorch(false);
    setCameraError(false);
    setOutcome(null);
    pausedRef.current = false;
    gateRef.current.reset();
  }, [clearFeedbackTimer]);

  useEffect(() => {
    if (visible) resetSession();
    return () => { clearFeedbackTimer(); gateRef.current.reset(); };
  }, [clearFeedbackTimer, resetSession, visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const subscription = AppState.addEventListener('change', state => {
      const active = state === 'active';
      setAppActive(active);
      gateRef.current.reset();
      pausedRef.current = !active || Boolean(outcome && outcome.kind !== 'success');
    });
    return () => subscription.remove();
  }, [outcome, visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (outcome?.kind === 'unknown' || outcome?.kind === 'inactive') {
        setOutcome(null); pausedRef.current = false; gateRef.current.reset();
      } else onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose, outcome, visible]);

  const handleScan = useCallback(async (result: BarcodeScanningResult) => {
    if (pausedRef.current || !appActive) return;
    const barcode = gateRef.current.begin(result.data);
    if (!barcode) return;
    try {
      const next = await onScan(barcode, result.type);
      setOutcome(next);
      if (next.kind === 'unknown' || next.kind === 'inactive') {
        haptics.warning();
        pausedRef.current = true;
        return;
      }
      clearFeedbackTimer();
      feedbackTimer.current = setTimeout(() => setOutcome(current => current === next ? null : current), 900);
    } catch (error) {
      if (__DEV__) console.error('[BarcodeScanHandlerFailed]', error);
    } finally {
      gateRef.current.complete(barcode);
    }
  }, [appActive, clearFeedbackTimer, onScan]);

  const continueScanning = () => {
    setOutcome(null);
    pausedRef.current = false;
    gateRef.current.reset();
  };
  const close = () => { resetSession(); onClose(); };
  const granted = permission?.granted === true;
  const denied = permission && !permission.granted && !permission.canAskAgain;
  if (!visible) return null;

  return <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={close}>
    <View style={[styles.page, { backgroundColor: colors.background }]}>
      {granted && appActive && !cameraError ? <CameraView key={cameraKey} style={StyleSheet.absoluteFill} facing="back" enableTorch={torch}
        barcodeScannerSettings={{ barcodeTypes: SUPPORTED_RETAIL_BARCODE_TYPES }} onBarcodeScanned={handleScan}
        onCameraReady={() => setCameraError(false)} onMountError={error => { if (__DEV__) console.error('[BarcodeCameraMountFailed]', error); setCameraError(true); }} /> : null}

      {granted && appActive && !cameraError ? <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        <View style={[styles.topShade, { backgroundColor: colors.overlay }]} />
        <View style={styles.middleRow}><View style={[styles.sideShade, { backgroundColor: colors.overlay }]} /><View accessibilityElementsHidden style={[styles.scanFrame, { borderColor: outcome?.kind === 'success' ? colors.success : colors.scannerForeground }]} /><View style={[styles.sideShade, { backgroundColor: colors.overlay }]} /></View>
        <View style={[styles.bottomShade, { backgroundColor: colors.overlay }]} />
        <SafeAreaView pointerEvents="box-none" edges={['top', 'bottom']} style={StyleSheet.absoluteFill}>
          <View style={[styles.controls, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
            <ScannerControl icon="x" label={copy.scanner.close} active={false} onPress={close} />
            <ScannerControl icon={torch ? 'zap' : 'zap-off'} label={torch ? copy.scanner.torchOff : copy.scanner.torchOn} active={torch} onPress={() => setTorch(value => !value)} />
          </View>
          <View pointerEvents="none" style={styles.instruction}><Text style={[typography.bodyMedium, { color: colors.scannerForeground, textAlign: 'center' }]}>{copy.scanner.instruction}</Text></View>
          {outcome && <View style={[styles.feedback, { backgroundColor: outcome.kind === 'success' ? colors.successSoft : outcome.kind === 'inactive' ? colors.warningSoft : colors.surfaceElevated, bottom: mode === 'cashier' ? insets.bottom + 112 : insets.bottom + spacing.lg }]}>
            {outcome.kind === 'success' ? <><View style={styles.feedbackTitle}><Feather name="check-circle" size={20} color={colors.success} /><Text numberOfLines={1} style={[typography.bodyMedium, styles.feedbackName, { color: colors.textPrimary }]}>{outcome.title}</Text></View>{outcome.quantity && <Text style={[typography.caption, { color: colors.textSecondary, textAlign: 'center' }]}>{copy.scanner.quantity(outcome.quantity)}</Text>}{outcome.amount !== undefined && <MonetaryValue value={outcome.amount} language={language} currencyLabel={copy.common.syp} inline />}</> : <>
              <Text style={[typography.title, { color: colors.textPrimary, textAlign: 'center' }]}>{outcome.kind === 'unknown' ? copy.scanner.unknown : copy.scanner.inactive}</Text>
              <Text selectable style={[typography.bodyMedium, styles.barcode, { color: colors.textSecondary }]}>{outcome.kind === 'unknown' ? outcome.barcode : outcome.title}</Text>
              <View style={[styles.feedbackActions, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>{outcome.kind === 'unknown' && onAddUnknown && <AppButton label={copy.scanner.addProduct} icon="plus" onPress={() => onAddUnknown(outcome.barcode)} style={styles.action} />}<AppButton label={mode === 'product-search' ? copy.scanner.rescan : copy.scanner.continueScanning} icon="camera" variant="secondary" onPress={continueScanning} style={styles.action} /></View>
            </>}
          </View>}
          {mode === 'cashier' && <View style={[styles.cartStatus, { backgroundColor: colors.surfaceElevated, paddingBottom: Math.max(insets.bottom, spacing.xs), flexDirection: rtl ? 'row-reverse' : 'row' }]}><View style={styles.cartCopy}><Text style={[typography.bodyMedium, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.scanner.cartItems(cartItemCount ?? '0')}</Text><MonetaryValue value={cartTotal} language={language} currencyLabel={copy.common.syp} inline style={[styles.cartMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} /></View><AppButton label={copy.common.done} icon="check" onPress={close} /></View>}
        </SafeAreaView>
      </View> : <SafeAreaView style={styles.statePage}>
        <View style={[styles.stateCard, { backgroundColor: colors.surface }]}><Feather name={cameraError ? 'camera-off' : 'camera'} size={34} color={cameraError ? colors.danger : colors.primary} /><Text style={[typography.titleLarge, { color: colors.textPrimary, textAlign: 'center' }]}>{cameraError ? copy.scanner.cameraFailed : denied ? copy.scanner.unavailable : copy.scanner.permissionTitle}</Text><Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>{cameraError ? copy.scanner.cameraFailedDescription : denied ? copy.scanner.deniedDescription : copy.scanner.permissionDescription}</Text>
          {cameraError ? <AppButton label={copy.common.retry} icon="refresh-cw" onPress={() => { setCameraError(false); setCameraKey(value => value + 1); }} style={styles.fullAction} /> : denied ? <AppButton label={copy.scanner.openSettings} icon="settings" onPress={() => void Linking.openSettings()} style={styles.fullAction} /> : <AppButton label={copy.scanner.allowCamera} icon="camera" onPress={() => void requestPermission()} style={styles.fullAction} />}
          <AppButton label={copy.common.cancel} variant="ghost" onPress={close} style={styles.fullAction} />
        </View>
      </SafeAreaView>}
    </View>
  </Modal>;
}

function ScannerControl({ icon, label, active, onPress }: { icon: keyof typeof Feather.glyphMap; label: string; active: boolean; onPress: () => void }) {
  const { colors } = useAppTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.control, { backgroundColor: active ? colors.scannerControlActive : colors.scannerControl }, pressed && styles.pressed]}><Feather name={icon} size={22} color={colors.scannerForeground} /></Pressable>;
}

const styles = StyleSheet.create({
  page: { flex: 1 }, topShade: { flex: 1 }, middleRow: { height: 220, flexDirection: 'row' }, sideShade: { flex: 1 }, scanFrame: { width: '78%', maxWidth: 360, borderWidth: 2, borderRadius: radius.lg }, bottomShade: { flex: 1.15 },
  controls: { position: 'absolute', top: spacing.sm, left: spacing.md, right: spacing.md, justifyContent: 'space-between' }, control: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' }, pressed: { opacity: 0.76, transform: [{ scale: 0.96 }] },
  instruction: { position: 'absolute', top: '67%', left: spacing.lg, right: spacing.lg }, feedback: { position: 'absolute', left: spacing.md, right: spacing.md, padding: spacing.md, borderRadius: radius.lg, alignItems: 'center', gap: spacing.xxs }, feedbackTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, maxWidth: '100%' }, feedbackName: { minWidth: 0, flexShrink: 1 }, barcode: { writingDirection: 'ltr', textAlign: 'center' }, feedbackActions: { width: '100%', gap: spacing.xs, marginTop: spacing.xs }, action: { flex: 1 },
  cartStatus: { position: 'absolute', left: 0, right: 0, bottom: 0, minHeight: 96, paddingHorizontal: spacing.md, paddingTop: spacing.sm, alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }, cartCopy: { minWidth: 0, flex: 1 }, cartMoney: { justifyContent: 'flex-start' },
  statePage: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg }, stateCard: { width: '100%', maxWidth: 440, padding: spacing.lg, borderRadius: radius.lg, alignItems: 'center', gap: spacing.sm }, fullAction: { width: '100%' },
});
