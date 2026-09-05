import { useCallback, useEffect, useState } from 'react';
import { InteractionManager, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { Feather } from '@expo/vector-icons';
import { Cairo_400Regular, Cairo_600SemiBold, Cairo_700Bold, Cairo_900Black, useFonts } from '@expo-google-fonts/cairo';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { MainCatalogScreen } from '@/screens/MainCatalogScreen';
import { ProductManagementScreen } from '@/screens/ProductManagementScreen';
import { SettingsAndBackupScreen } from '@/screens/SettingsAndBackupScreen';
import { SalesScreen } from '@/screens/SalesScreen';
import { InventoryScreen } from '@/screens/InventoryScreen';
import { useAppStore } from '@/store/useAppStore';
import { configureDefaultTypography } from '@/theme/typography';
import { layout, spacing, ThemeProvider, typography, useAppTheme } from '@/theme';
import { ErrorState, SnackbarProvider } from '@/components/ui';
import { t, uiText } from '@/i18n';
import { cleanupStaleBackupFiles } from '@/backup/backupStorage';
import { haptics } from '@/utils/haptics';

type Tab = 'catalog' | 'sales' | 'manage' | 'inventory' | 'settings';
configureDefaultTypography();

const nativeSplashHold = SplashScreen.preventAutoHideAsync().catch(error => {
  if (__DEV__) console.error('[NativeSplashPreventAutoHideFailed]', error);
});
let nativeSplashReleased = false;
let postStartupMaintenanceScheduled = false;

async function releaseNativeSplash() {
  if (nativeSplashReleased) return;
  nativeSplashReleased = true;
  await nativeSplashHold;
  try { await SplashScreen.hideAsync(); }
  catch (error) { if (__DEV__) console.error('[NativeSplashHideFailed]', error); }
}

function schedulePostStartupMaintenance() {
  if (postStartupMaintenanceScheduled) return;
  postStartupMaintenanceScheduled = true;
  InteractionManager.runAfterInteractions(() => {
    try { cleanupStaleBackupFiles(); }
    catch (error) { if (__DEV__) console.error('[BackupStartupCleanupFailed]', error); }
  });
}

export default function App() {
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [retainStartupError, setRetainStartupError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retry = useCallback(() => {
    if (retrying) return;
    setRetrying(true);
    setBootstrapAttempt(attempt => attempt + 1);
  }, [retrying]);
  const startupFailed = useCallback(() => { setRetainStartupError(true); setRetrying(false); }, []);
  const startupReady = useCallback(() => { setRetainStartupError(false); setRetrying(false); }, []);

  return <SafeAreaProvider><ThemeProvider><AppContent key={bootstrapAttempt} retainStartupError={retainStartupError} retrying={retrying} onStartupFailure={startupFailed} onStartupReady={startupReady} onRetry={retry} /></ThemeProvider></SafeAreaProvider>;
}

function AppContent({ retainStartupError, retrying, onStartupFailure, onStartupReady, onRetry }: { retainStartupError: boolean; retrying: boolean; onStartupFailure: () => void; onStartupReady: () => void; onRetry: () => void }) {
  const { colors, isDark } = useAppTheme();
  const { initialize, isReady, language } = useAppStore();
  const [tab, setTab] = useState<Tab>('catalog');
  const [bottomNavigationHeight, setBottomNavigationHeight] = useState(0);
  const [initializationError, setInitializationError] = useState<unknown>(null);
  const [fontsLoaded, fontError] = useFonts({ Cairo_400Regular, Cairo_600SemiBold, Cairo_700Bold, Cairo_900Black });
  useEffect(() => {
    setInitializationError(null);
    void initialize().catch(error => { if (__DEV__) console.error('[AppInitializationFailed]', error); setInitializationError(error); });
  }, [initialize]);

  useEffect(() => {
    if (fontError && __DEV__) console.error('[FontInitializationFailed]', fontError);
  }, [fontError]);

  const startupError = fontError ?? initializationError;
  const startupReady = fontsLoaded && isReady && !startupError;
  useEffect(() => { if (startupError) onStartupFailure(); }, [onStartupFailure, startupError]);
  useEffect(() => { if (startupReady) onStartupReady(); }, [onStartupReady, startupReady]);
  const onMainLayout = useCallback(() => {
    void releaseNativeSplash().then(schedulePostStartupMaintenance);
  }, []);

  if (!startupReady && !startupError && !retainStartupError) return null;
  if (!startupReady) {
    const copy = uiText(language);
    return <View onLayout={() => void releaseNativeSplash()} style={[styles.startupError, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <ErrorState title={copy.app.startErrorTitle} description={copy.app.startErrorDescription} retryLabel={copy.common.retry} onRetry={onRetry} retrying={retrying} />
    </View>;
  }

  const rtl = language === 'ar';
  const tabs: { key: Tab; icon: keyof typeof Feather.glyphMap }[] = [
    { key: 'catalog', icon: 'grid' }, { key: 'sales', icon: 'trending-up' }, { key: 'manage', icon: 'package' }, { key: 'inventory', icon: 'archive' }, { key: 'settings', icon: 'settings' },
  ];
  return <SnackbarProvider bottomInset={bottomNavigationHeight}><View onLayout={onMainLayout} style={[styles.app, { backgroundColor: colors.background }]}> 
    <StatusBar style={isDark ? 'light' : 'dark'} />
    <Animated.View key={tab} entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)} style={[styles.screen, tab !== 'manage' && tab !== 'sales' && { paddingBottom: bottomNavigationHeight }]}>
      {tab === 'catalog' && <MainCatalogScreen onManageProducts={() => setTab('manage')} />}{tab === 'sales' && <SalesScreen bottomNavigationInset={bottomNavigationHeight} />}{tab === 'manage' && <ProductManagementScreen bottomNavigationInset={bottomNavigationHeight} />}{tab === 'inventory' && <InventoryScreen bottomNavigationInset={bottomNavigationHeight} />}{tab === 'settings' && <SettingsAndBackupScreen />}
    </Animated.View>
    <SafeAreaView edges={['bottom']} onLayout={event => setBottomNavigationHeight(event.nativeEvent.layout.height)} style={[styles.navSafe, { backgroundColor: colors.navBackground, borderTopColor: colors.border }]}> 
      <View accessibilityRole="tablist" style={[styles.nav, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
        {tabs.map(item => { const active = tab === item.key; return <Pressable key={item.key} accessibilityRole="tab" accessibilityLabel={t(language, item.key)} accessibilityState={{ selected: active }} onPress={() => { if (!active) haptics.selection(); setTab(item.key); }} style={({ pressed }) => [styles.navItem, pressed && styles.pressed]}>
          <View style={[styles.activeMark, { backgroundColor: active ? colors.primary : 'transparent' }]} />
          <View style={styles.navIcon}><Feather name={item.icon} size={20} color={active ? colors.primary : colors.textMuted} /></View>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} maxFontSizeMultiplier={1.2} style={[typography.caption, styles.navLabel, { color: active ? colors.primary : colors.textMuted }]}>{t(language, item.key)}</Text>
        </Pressable>; })}
      </View>
    </SafeAreaView>
  </View></SnackbarProvider>;
}

const styles = StyleSheet.create({
  app: { flex: 1 }, screen: { flex: 1 }, startupError: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  navSafe: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: StyleSheet.hairlineWidth }, nav: { minHeight: layout.bottomNavigationHeight, paddingHorizontal: spacing.xs, alignItems: 'center', justifyContent: 'space-around' },
  navItem: { flex: 1, minHeight: 54, alignItems: 'center', justifyContent: 'center', gap: 0 }, activeMark: { width: 18, height: 2, borderRadius: 1, marginBottom: 2 }, navIcon: { width: 38, height: 25, alignItems: 'center', justifyContent: 'center' },
  navLabel: { width: '100%', textAlign: 'center' },
  pressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
});
