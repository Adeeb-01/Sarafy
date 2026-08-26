import { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { MonetaryValue, Skeleton, StatusChip } from '@/components/ui';
import { resolveProductImageUri } from '@/media/productImageStorage';
import { Product, Settings } from '@/types';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { formatUsd } from '@/utils/formatters';
import { calculateSypPrice } from '@/utils/priceCalculator';
import { haptics } from '@/utils/haptics';
import { uiText } from '@/i18n';

export const PRODUCT_ROW_HEIGHT = 88;
export const PRODUCT_ROW_GAP = spacing.xs;
const PRODUCT_THUMBNAIL_SIZE = 56;

type Props = {
  product: Product;
  settings: Settings;
  onEdit: (product: Product) => void;
  onActions: (product: Product) => void;
};

export const ProductListRow = memo(function ProductListRow({ product, settings, onEdit, onActions }: Props) {
  const { colors } = useAppTheme();
  const rtl = settings.language === 'ar';
  const copy = uiText(settings.language);
  const [loadingImage, setLoadingImage] = useState(Boolean(product.image_uri));
  const [imageFailed, setImageFailed] = useState(false);
  const resolvedImage = resolveProductImageUri(product.image_uri);
  const convertedPrice = calculateSypPrice({
    priceUsd: product.price_usd,
    exchangeRate: settings.exchangeRate,
    isRoundingEnabled: settings.isRoundingEnabled,
    roundingTarget: settings.roundingTarget,
  });
  const moneyFontSize = convertedPrice >= 1_000_000_000 ? 11 : convertedPrice >= 10_000_000 ? 12 : convertedPrice >= 1_000_000 ? 13 : convertedPrice >= 100_000 ? 14 : 16;

  useEffect(() => {
    setLoadingImage(Boolean(resolvedImage));
    setImageFailed(false);
  }, [resolvedImage]);

  const openEdit = () => { haptics.selection(); onEdit(product); };
  const openActions = () => { haptics.tap(); onActions(product); };

  return <View style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${product.name}, ${formatUsd(product.price_usd, settings.language)}`} accessibilityHint={copy.products.openEditHint} onPress={openEdit} style={({ pressed }) => [styles.main, { flexDirection: rtl ? 'row-reverse' : 'row' }, pressed && styles.pressed]}>
      <View style={[styles.thumbnail, { backgroundColor: colors.surfaceSecondary }]}>
        {resolvedImage && !imageFailed ? <Image source={resolvedImage} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} onLoadStart={() => setLoadingImage(true)} onLoad={() => setLoadingImage(false)} onError={() => { setLoadingImage(false); setImageFailed(true); }} /> : <Feather name={imageFailed ? 'image' : 'package'} size={22} color={imageFailed ? colors.danger : colors.textMuted} />}
        {loadingImage && <Skeleton width="100%" height={PRODUCT_THUMBNAIL_SIZE} radius={radius.md} style={StyleSheet.absoluteFill} />}
      </View>
      <View style={styles.copy}>
        <View style={[styles.nameLine, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
          <Text numberOfLines={1} style={[typography.bodyMedium, styles.name, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{product.name}</Text>
          {product.is_active === 0 && <StatusChip label={copy.products.inactive} tone="warning" />}
        </View>
        <View style={[styles.metaLine, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Text numberOfLines={1} style={[typography.caption, styles.metaCategory, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{product.category}</Text>{product.barcode ? <Text numberOfLines={1} style={[typography.caption, styles.barcode, { color: colors.textMuted }]}>· {product.barcode}</Text> : null}</View>
        <View style={[styles.usdLine, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
          <Text numberOfLines={1} style={[typography.caption, styles.usdPart, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{copy.products.sale} {formatUsd(product.price_usd, settings.language)}</Text>
          {product.cost_usd > 0 && <><Text style={[typography.caption, { color: colors.textMuted }]}>•</Text><Text numberOfLines={1} style={[typography.caption, styles.usdPart, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.products.cost} {formatUsd(product.cost_usd, settings.language)}</Text></>}
        </View>
      </View>
      <MonetaryValue value={convertedPrice} language={settings.language} currencyLabel={copy.common.syp} style={styles.money} textStyle={{ fontSize: moneyFontSize, lineHeight: moneyFontSize + 6 }} />
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={copy.products.actionsLabel(product.name)} onPress={openActions} hitSlop={4} style={styles.action}>{({ pressed }) => <View style={[styles.actionVisual, { backgroundColor: colors.surfaceSecondary }, pressed && styles.actionPressed]}><Feather name="more-vertical" size={18} color={colors.textSecondary} /></View>}</Pressable>
  </View>;
});

const styles = StyleSheet.create({
  row: { height: PRODUCT_ROW_HEIGHT, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', overflow: 'hidden' },
  main: { minWidth: 0, flex: 1, height: '100%', alignItems: 'center', padding: spacing.xs, gap: spacing.xs },
  thumbnail: { width: PRODUCT_THUMBNAIL_SIZE, height: PRODUCT_THUMBNAIL_SIZE, flexShrink: 0, borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  copy: { minWidth: 0, flex: 1, gap: 0 }, nameLine: { minWidth: 0, alignItems: 'center', gap: spacing.xxs }, name: { minWidth: 0, flexShrink: 1 }, metaLine: { minWidth: 0, alignItems: 'center', gap: spacing.xxs }, metaCategory: { minWidth: 0, flexShrink: 1 }, barcode: { maxWidth: '46%', flexShrink: 1, writingDirection: 'ltr' },
  usdLine: { minWidth: 0, alignItems: 'center', gap: spacing.xxs }, usdPart: { minWidth: 0, flexShrink: 1 },
  money: { width: 100, flexShrink: 0 },
  action: { width: 44, height: 44, marginHorizontal: spacing.xxs, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }, actionVisual: { width: 30, height: 30, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.76 }, actionPressed: { opacity: 0.72, transform: [{ scale: 0.94 }] },
});
