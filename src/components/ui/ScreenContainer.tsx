import { PropsWithChildren } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { spacing, useAppTheme } from '@/theme';

export function ScreenContainer({ children, scroll = false, padded = false, keyboard = false }: PropsWithChildren<{ scroll?: boolean; padded?: boolean; keyboard?: boolean }>) {
  const { colors } = useAppTheme();
  const body = scroll ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.scroll, padded && styles.padded]}>{children}</ScrollView> : <View style={[styles.content, padded && styles.padded]}>{children}</View>;
  const wrapped = keyboard ? <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.content}>{body}</KeyboardAvoidingView> : body;
  return <SafeAreaView edges={['top']} style={[styles.safe, { backgroundColor: colors.background }]}>{wrapped}</SafeAreaView>;
}

const styles = StyleSheet.create({ safe: { flex: 1 }, content: { flex: 1 }, scroll: { flexGrow: 1 }, padded: { paddingHorizontal: spacing.md } });
