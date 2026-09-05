import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { ActionSheet, AppButton, AppCard, ConfirmSheet, EmptyState, ListItem, ScreenContainer, SectionHeader, SegmentedControl, useSnackbar } from '@/components/ui';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { exportExcel, pickExcel } from '@/utils/excel';
import { t, uiText } from '@/i18n';
import { formatNumber } from '@/utils/formatters';
import { cleanupPickedBackup, collectPortableData, createManualBackup, listAutomaticBackups, pickSarafyBackup, readStoredBackup, restoreBackupImages, SarafyBackup, shareBackup } from '@/backup/backupManager';
import { analyzeImport } from '@/import/importAnalyzer';
import { defaultImportOptions, executeImport } from '@/import/jsonImporter';
import { ImportEntity, ImportMode, ImportPayload, ImportPreview } from '@/import/importTypes';
import { createDeterministicUuid } from '@/utils/uuid';
import { checkProductImages, cleanupTemporaryProductImages, cleanupUnusedProductImages } from '@/media/productImageStorage';
import { haptics } from '@/utils/haptics';

type PendingImport = { preview: ImportPreview; payload: ImportPayload; portableBackup?: SarafyBackup };
type InfoSheet = { title: string; description: string; empty?: boolean };
type Operation = 'backup' | 'import' | 'excelExport' | 'excelImport' | 'images' | 'backups' | 'undo';

export function SettingsAndBackupScreen() {
  const state = useAppStore(); const { colors } = useAppTheme(); const snackbar = useSnackbar();
  const [importMode, setImportMode] = useState<ImportMode>('safe_merge');
  const [selectedEntities, setSelectedEntities] = useState<ImportEntity[]>(['products', 'categories', 'product_images']);
  const [busy, setBusy] = useState(false); const [lastBackupId, setLastBackupId] = useState<string | null>(null);
  const [activeOperation, setActiveOperation] = useState<Operation | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null); const [confirmUndo, setConfirmUndo] = useState(false); const [info, setInfo] = useState<InfoSheet | null>(null);
  const operationRunning = useRef(false); const rtl = state.language === 'ar';
  const copy = uiText(state.language);
  const settings = { exchangeRate: state.exchangeRate, isRoundingEnabled: state.isRoundingEnabled, roundingTarget: state.roundingTarget, language: state.language };

  const showError = (error: unknown) => { if (__DEV__) console.error('[SafeImportBackup]', error); haptics.error(); snackbar.show({ text: t(state.language, 'error'), tone: 'error' }); };
  const runBusy = async (key: Operation, operation: () => Promise<void>) => { if (operationRunning.current) return; operationRunning.current = true; setActiveOperation(key); setBusy(true); try { await operation(); } finally { operationRunning.current = false; setActiveOperation(null); setBusy(false); } };

  const onExport = () => void runBusy('backup', async () => {
    let backupCreated = false;
    try { const uri = await createManualBackup(); backupCreated = true; await shareBackup(uri); haptics.success(); snackbar.show({ text: copy.settings.backupShared, tone: 'success' }); }
    catch (error) { if (__DEV__) console.error('[ManualBackupFailed]', error); haptics.error(); snackbar.show({ text: backupCreated ? copy.settings.backupShareFailed : copy.settings.backupFailed, tone: 'error' }); }
  });

  const previewAndImport = async (payload: ImportPayload, portableBackup?: SarafyBackup) => {
    const options = defaultImportOptions(importMode);
    if (importMode === 'selective') { options.entities = selectedEntities; options.importSettings = selectedEntities.includes('settings'); }
    const preview = await analyzeImport(payload, options); setPendingImport({ preview, payload, portableBackup }); haptics.warning();
  };

  const importNow = () => void runBusy('import', async () => { try { const backup = await pickSarafyBackup(); if (backup) await previewAndImport(backup.data, backup); } catch (error) { showError(error); } });

  const cancelPendingImport = () => { const backup = pendingImport?.portableBackup; setPendingImport(null); if (backup) void cleanupPickedBackup(backup).catch(() => undefined); };
  const confirmPendingImport = () => void runBusy('import', async () => {
    if (!pendingImport) return;
    const { preview, payload, portableBackup } = pendingImport;
    try {
      const result = await executeImport(preview); setLastBackupId(result.backupId ?? null); let imageRestoreFailed = false;
      if (portableBackup && preview.options.entities.includes('product_images')) { try { await restoreBackupImages(portableBackup); } catch { imageRestoreFailed = true; } }
      await state.reloadAll();
      if (preview.options.mode === 'full_restore') await cleanupUnusedProductImages(payload.products.map(product => product.image_uri ?? ''));
      setPendingImport(null); haptics.success();
      snackbar.show({ text: `${t(state.language, 'importSuccess')} — ${t(state.language, 'added')}: ${result.inserted}، ${t(state.language, 'updatedRecords')}: ${result.updated}${imageRestoreFailed ? ` · ${t(state.language, 'imagesRestoreFailed')}` : ''}`, tone: imageRestoreFailed ? 'info' : 'success', actionLabel: result.backupId ? t(state.language, 'undoImport') : undefined, onAction: result.backupId ? () => setConfirmUndo(true) : undefined, duration: 6500 });
    } catch (error) { await state.reloadAll().catch(() => undefined); showError(error); }
    finally { if (portableBackup) await cleanupPickedBackup(portableBackup).catch(() => undefined); await cleanupTemporaryProductImages().catch(() => undefined); }
  });

  const onExportExcel = () => void runBusy('excelExport', async () => { try { const [rateHistory, closedSessions, portable, inventory] = await Promise.all([state.getExchangeRateHistory(), state.getCashSessionsForExport(), collectPortableData(), state.queryInventory()]); await exportExcel(state.products, state.categories, settings, state.sales, state.expenses, state.expenseCategories, rateHistory, state.activeCashSession ? [state.activeCashSession, ...closedSessions] : closedSessions, portable.salePayments, inventory, portable.inventoryMovements); haptics.success(); snackbar.show({ text: copy.settings.excelExported, tone: 'success' }); } catch (error) { showError(error); } });
  const onImportExcel = () => void runBusy('excelImport', async () => { try { const data = await pickExcel(settings); if (!data) return; const now = new Date().toISOString(); await previewAndImport({ version: 4, exportedAt: now, products: data.products, categories: data.categories.map(name => ({ uuid: createDeterministicUuid(`category:${name.toLocaleLowerCase()}`), name, created_at: now, updated_at: now })), settings: data.settings, sales: [], expenses: [] }); } catch (error) { showError(error); } });
  const onImageHealth = () => void runBusy('images', async () => { try { const report = await checkProductImages(state.products.map(product => product.image_uri ?? '')); const hasIssues = report.missing.length > 0 || report.orphaned.length > 0; setInfo(hasIssues ? { title: t(state.language, 'imageHealth'), description: copy.settings.imageHealthSummary(formatNumber(report.healthy, state.language), formatNumber(report.missing.length, state.language), formatNumber(report.orphaned.length, state.language)) } : { title: copy.settings.noImageIssues, description: copy.settings.noImageIssuesDescription, empty: true }); } catch (error) { showError(error); } });
  const onListBackups = () => void runBusy('backups', async () => { try { const backups = await listAutomaticBackups(); setInfo(backups.length ? { title: t(state.language, 'automaticBackups'), description: backups.map(item => `${item.name} (${Math.ceil(item.size / 1024)} KB)`).join('\n') } : { title: t(state.language, 'automaticBackups'), description: copy.settings.noBackupsDescription, empty: true }); } catch (error) { showError(error); } });

  const undoLastImport = () => void runBusy('undo', async () => {
    if (!lastBackupId) return;
    try { const backup = await readStoredBackup(lastBackupId); const preview = await analyzeImport(backup.data, defaultImportOptions('full_restore')); await executeImport(preview); let imageRestoreFailed = false; try { await restoreBackupImages(backup); } catch { imageRestoreFailed = true; } await state.reloadAll(); setLastBackupId(null); setConfirmUndo(false); haptics.success(); snackbar.show({ text: imageRestoreFailed ? t(state.language, 'imagesRestoreFailed') : t(state.language, 'undoSuccess'), tone: imageRestoreFailed ? 'info' : 'success' }); }
    catch (error) { await state.reloadAll().catch(() => undefined); showError(error); }
  });

  const toggleEntity = (entity: ImportEntity) => { haptics.selection(); setSelectedEntities(current => { const next = current.includes(entity) ? current.filter(item => item !== entity) : [...current, entity]; if (entity === 'sales' && next.includes('sales')) { if (!next.includes('sale_items')) next.push('sale_items'); if (!next.includes('sale_payments')) next.push('sale_payments'); } if ((entity === 'sale_items' || entity === 'sale_payments') && !next.includes(entity)) return next.filter(item => item !== 'sales' && item !== 'sale_items' && item !== 'sale_payments'); if (entity === 'expenses' && next.includes('expenses') && !next.includes('expense_categories')) next.push('expense_categories'); if (entity === 'expense_categories' && !next.includes('expense_categories')) return next.filter(item => item !== 'expenses'); return next; }); };
  const summary = pendingImport?.preview.summary;

  return <ScreenContainer><ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <View style={styles.pageHeading}><Text style={[typography.titleLarge, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{t(state.language, 'settings')}</Text><Text style={[typography.body, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{copy.app.settingsSubtitle}</Text></View>

    <SettingsSection title={t(state.language, 'roundingTarget')} subtitle={copy.settings.roundingSubtitle} rtl={rtl}><SegmentedControl rtl={rtl} value={state.roundingTarget} onChange={value => void state.updateSetting('roundingTarget', value)} options={([5, 10, 500, 1000] as const).map(value => ({ value, label: `${formatNumber(value, state.language)} ${t(state.language, 'syp')}` }))} /></SettingsSection>
    <SettingsSection title={t(state.language, 'language')} rtl={rtl}><SegmentedControl rtl={rtl} value={state.language} onChange={value => void state.updateSetting('language', value)} options={[{ value: 'ar' as const, label: t(state.language, 'arabic') }, { value: 'en' as const, label: t(state.language, 'english') }]} /></SettingsSection>

    <SettingsSection title={t(state.language, 'backup')} subtitle={copy.settings.backupSubtitle} rtl={rtl}>
      <View style={styles.inner}><SegmentedControl rtl={rtl} value={importMode} onChange={setImportMode} options={(['safe_merge', 'selective', 'full_restore'] as const).map(value => ({ value, label: t(state.language, value) }))} />
        {importMode === 'selective' && <View style={styles.entityGrid}>{(['products', 'categories', 'settings', 'cash_sessions', 'sales', 'expense_categories', 'expenses', 'exchange_rate_history', 'product_images'] as const).map(entity => { const active = selectedEntities.includes(entity); return <Pressable key={entity} disabled={busy} accessibilityRole="checkbox" accessibilityState={{ checked: active, disabled: busy }} onPress={() => toggleEntity(entity)} style={[styles.entityRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Feather name={active ? 'check-square' : 'square'} size={20} color={active ? colors.primary : colors.textMuted} /><Text style={[typography.bodyMedium, { color: colors.textPrimary }]}>{t(state.language, entity)}</Text></Pressable>; })}</View>}
        <View style={[styles.safety, { backgroundColor: colors.successSoft, flexDirection: rtl ? 'row-reverse' : 'row' }]}><Feather name="shield" size={18} color={colors.success} /><Text style={[typography.caption, { flex: 1, color: colors.success, textAlign: rtl ? 'right' : 'left' }]}>{t(state.language, 'automaticBackupNote')}</Text></View>
      </View>
      <ListItem icon="upload" title={t(state.language, 'exportData')} description={copy.settings.backupDescription} rtl={rtl} onPress={onExport} disabled={busy} loading={activeOperation === 'backup'} />
      <ListItem icon="download" title={t(state.language, 'importData')} description={t(state.language, importMode)} rtl={rtl} onPress={importNow} tone={importMode === 'full_restore' ? 'danger' : 'default'} disabled={busy} loading={activeOperation === 'import'} />
      <ListItem icon="archive" title={t(state.language, 'automaticBackups')} rtl={rtl} onPress={onListBackups} disabled={busy} loading={activeOperation === 'backups'} />
      {lastBackupId && <ListItem icon="rotate-ccw" title={t(state.language, 'undoImport')} rtl={rtl} onPress={() => setConfirmUndo(true)} tone="danger" disabled={busy} loading={activeOperation === 'undo'} />}
    </SettingsSection>

    <SettingsSection title={t(state.language, 'excel')} rtl={rtl}><ListItem icon="file-text" title={t(state.language, 'exportExcel')} rtl={rtl} onPress={onExportExcel} disabled={busy} loading={activeOperation === 'excelExport'} /><ListItem icon="grid" title={t(state.language, 'importExcel')} description={copy.settings.excelImportDescription} rtl={rtl} onPress={onImportExcel} disabled={busy} loading={activeOperation === 'excelImport'} /></SettingsSection>
    <SettingsSection title={t(state.language, 'imageHealth')} rtl={rtl}><ListItem icon="image" title={t(state.language, 'checkImages')} rtl={rtl} onPress={onImageHealth} disabled={busy} loading={activeOperation === 'images'} /></SettingsSection>

    <View style={[styles.offline, { borderTopColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }]}><Feather name="wifi-off" size={14} color={colors.textMuted} /><Text style={[typography.caption, { flex: 1, color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{t(state.language, 'offlineNote')}</Text></View>
    <Text style={[typography.caption, { color: colors.textMuted, textAlign: 'center', writingDirection: rtl ? 'rtl' : 'ltr' }]}>{t(state.language, 'rightsReserved')}</Text>
  </ScrollView>

  <ConfirmSheet visible={!!pendingImport} onClose={cancelPendingImport} onConfirm={confirmPendingImport} title={t(state.language, 'importPreview')} description={importMode === 'full_restore' ? t(state.language, 'importWarning') : t(state.language, 'automaticBackupNote')} confirmLabel={t(state.language, 'executeImport')} cancelLabel={t(state.language, 'cancel')} tone={importMode === 'full_restore' ? 'danger' : 'warning'} loading={busy} rtl={rtl}>
    {summary && <View style={[styles.summary, { backgroundColor: colors.surfaceSecondary }]}>{[[t(state.language, 'newRecords'), summary.newRecords], [t(state.language, 'updatedRecords'), summary.updatedRecords], [t(state.language, 'unchangedRecords'), summary.unchangedRecords], [t(state.language, 'conflicts'), summary.conflicts], [t(state.language, 'invalidRecords'), summary.invalidRecords]].map(([label, value]) => <View key={String(label)} style={[styles.summaryRow, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Text style={[typography.caption, { color: colors.textSecondary }]}>{label}</Text><Text style={[typography.numericMedium, { color: colors.textPrimary }]}>{value}</Text></View>)}</View>}
  </ConfirmSheet>
  <ConfirmSheet visible={confirmUndo} onClose={() => setConfirmUndo(false)} onConfirm={undoLastImport} title={t(state.language, 'undoImport')} description={t(state.language, 'undoWarning')} confirmLabel={t(state.language, 'confirm')} cancelLabel={t(state.language, 'cancel')} tone="danger" loading={busy} rtl={rtl} />
  <ActionSheet visible={!!info} onClose={() => setInfo(null)} title={info?.title ?? ''} rtl={rtl}>{info?.empty ? <EmptyState icon="check-circle" title={info.title} description={info.description} compact /> : <Text style={[typography.body, styles.infoText, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{info?.description}</Text>}<AppButton label={copy.common.done} onPress={() => setInfo(null)} /></ActionSheet>
  </ScreenContainer>;
}

function SettingsSection({ title, subtitle, rtl, children }: { title: string; subtitle?: string; rtl: boolean; children: React.ReactNode }) {
  return <View style={styles.section}><SectionHeader title={title} subtitle={subtitle} rtl={rtl} /><AppCard>{children}</AppCard></View>;
}

const styles = StyleSheet.create({ page: { padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.lg }, pageHeading: { gap: 0 }, section: { gap: spacing.xxs }, inner: { padding: spacing.xs, gap: spacing.xs }, entityGrid: { gap: 0 }, entityRow: { minHeight: 44, alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.xxs }, safety: { padding: spacing.xs, borderRadius: radius.sm, alignItems: 'center', gap: spacing.xs }, offline: { minHeight: 38, paddingHorizontal: spacing.xxs, borderTopWidth: StyleSheet.hairlineWidth, alignItems: 'center', gap: spacing.xs }, summary: { alignSelf: 'stretch', borderRadius: radius.md, padding: spacing.xs, gap: 0, marginTop: spacing.xs }, summaryRow: { minHeight: 30, justifyContent: 'space-between', alignItems: 'center' }, infoText: { paddingVertical: spacing.md, lineHeight: 23 } });
