import { memo, useEffect, useState } from 'react';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { Product, Settings } from '@/types';
import { activeSalePriceSyp } from '@/utils/productPricing';
import { formatNumber, formatProductUsd } from '@/utils/formatters';
import { MonetaryValue, Skeleton } from '@/components/ui';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { resolveProductImageUri } from '@/media/productImageStorage';
import { uiText } from '@/i18n';

export const ProductCard = memo(function ProductCard({ product, settings }: { product: Product; settings: Settings }) {
  const { colors } = useAppTheme(); const rtl = settings.language === 'ar';
  const copy = uiText(settings.language); const resolvedImage = resolveProductImageUri(product.image_uri);
  const [imageLoading, setImageLoading] = useState(Boolean(resolvedImage)); const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => { setImageLoading(Boolean(resolvedImage)); setImageFailed(false); }, [resolvedImage]);
  const syp = activeSalePriceSyp(product, settings);
  const native = product.sale_price_currency === 'SYP' ? `${formatNumber(product.sale_price_syp ?? 0, settings.language)} ${copy.common.syp}` : formatProductUsd(product.price_usd, settings.language);
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={[styles.imageWrap, { backgroundColor: colors.surfaceSecondary }]}>
      {resolvedImage && !imageFailed ? <Image source={resolvedImage} accessibilityLabel={product.name} style={styles.image} contentFit="cover" transition={120} onLoadStart={() => setImageLoading(true)} onLoad={() => setImageLoading(false)} onError={() => { setImageLoading(false); setImageFailed(true); }} /> : <Feather name={imageFailed ? 'image' : 'package'} size={28} color={imageFailed ? colors.danger : colors.primary} />}
      {imageLoading && <Skeleton width="100%" height={112} radius={0} style={StyleSheet.absoluteFill} />}
      <View style={[styles.tag, { backgroundColor: colors.surfaceElevated }, rtl ? { right: spacing.xs } : { left: spacing.xs }]}><Text numberOfLines={1} style={[typography.caption, { color: colors.textSecondary }]}>{product.category}</Text></View>
    </View>
    <View style={styles.body}>
      <Text numberOfLines={2} style={[typography.bodyMedium, styles.name, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{product.name}</Text>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85} style={[typography.caption, styles.usd, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{native}</Text>
      <Animated.View key={syp} entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)} style={[styles.priceBand, { backgroundColor: colors.surfaceSecondary }]}><MonetaryValue value={syp} language={settings.language} currencyLabel={copy.common.syp} /></Animated.View>
    </View>
  </View>;
});

const styles = StyleSheet.create({
  card: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  imageWrap: { height: 112, alignItems: 'center', justifyContent: 'center' }, image: { width: '100%', height: '100%' },
  tag: { position: 'absolute', top: spacing.xs, maxWidth: '76%', paddingHorizontal: spacing.xs, paddingVertical: 2, borderRadius: radius.sm },
  body: { padding: spacing.xs, gap: spacing.xxs }, name: { minHeight: 42 },
  usd: { fontVariant: ['tabular-nums'], writingDirection: 'ltr' },
  priceBand: { minHeight: 50, paddingHorizontal: spacing.xxs, borderRadius: radius.sm, justifyContent: 'center', overflow: 'hidden' },
});
