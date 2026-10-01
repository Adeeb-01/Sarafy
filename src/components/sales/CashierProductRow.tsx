import { memo, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { AppButton, MonetaryValue, QuantityStepper, Skeleton } from '@/components/ui';
import { resolveProductImageUri } from '@/media/productImageStorage';
import { Product, Settings } from '@/types';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { formatNumber, formatProductUsd } from '@/utils/formatters';
import { activeSalePriceSyp } from '@/utils/productPricing';
import { uiText } from '@/i18n';

export const CASHIER_PRODUCT_ROW_HEIGHT = 84;
export const CASHIER_PRODUCT_ROW_GAP = spacing.xs;
const THUMBNAIL_SIZE = 52;

type Props = {
  product: Product;
  settings: Settings;
  quantity: number;
  onAdd: (product: Product) => void;
  onQuantityChange: (productId: number, quantity: number) => void;
  onQuantityDelta: (productId: number, delta: number) => void;
};

export const CashierProductRow = memo(function CashierProductRow({ product, settings, quantity, onAdd, onQuantityChange, onQuantityDelta }: Props) {
  const { colors } = useAppTheme();
  const rtl = settings.language === 'ar';
  const copy = uiText(settings.language);
  const resolvedImage = resolveProductImageUri(product.image_uri);
  const [imageLoading, setImageLoading] = useState(Boolean(resolvedImage));
  const [imageFailed, setImageFailed] = useState(false);
  const priceSyp = activeSalePriceSyp(product, settings);
  const native = product.sale_price_currency === 'SYP' ? `${formatNumber(product.sale_price_syp ?? 0, settings.language)} ${copy.common.syp}` : formatProductUsd(product.price_usd, settings.language);

  useEffect(() => {
    setImageLoading(Boolean(resolvedImage));
    setImageFailed(false);
  }, [resolvedImage]);

  return <View style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }]}>
    <View style={[styles.thumbnail, { backgroundColor: colors.surfaceSecondary }]}>
      {resolvedImage && !imageFailed ? <Image source={resolvedImage} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} onLoadStart={() => setImageLoading(true)} onLoad={() => setImageLoading(false)} onError={() => { setImageLoading(false); setImageFailed(true); }} /> : <Feather name={imageFailed ? 'image' : 'package'} size={21} color={imageFailed ? colors.danger : colors.textMuted} />}
      {imageLoading && <Skeleton width="100%" height={THUMBNAIL_SIZE} radius={radius.md} style={StyleSheet.absoluteFill} />}
    </View>
    <View style={styles.copy}>
      <Text numberOfLines={1} style={[typography.bodyMedium, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{product.name}</Text>
      <MonetaryValue value={priceSyp} language={settings.language} currencyLabel={copy.common.syp} inline style={[styles.syp, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={styles.sypValue} />
      <Text numberOfLines={1} style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left', writingDirection: 'ltr' }]}>{native}</Text>
    </View>
    <Animated.View key={quantity > 0 ? 'quantity' : 'add'} entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)}>
      {quantity > 0
        ? <QuantityStepper value={quantity} min={0} max={999} compact label={copy.sales.quantity(product.name)} decreaseLabel={copy.sales.decrease(product.name)} increaseLabel={copy.sales.increase(product.name)} onChange={value => onQuantityChange(product.id, value)} onDecrement={() => onQuantityDelta(product.id, -1)} onIncrement={() => onQuantityDelta(product.id, 1)} />
        : <AppButton label={copy.common.add} icon="plus" onPress={() => onAdd(product)} accessibilityHint={copy.sales.addToCart(product.name)} style={styles.addButton} />}
    </Animated.View>
  </View>;
});

const styles = StyleSheet.create({
  row: { height: CASHIER_PRODUCT_ROW_HEIGHT, paddingHorizontal: spacing.xs, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, alignItems: 'center', gap: spacing.xs },
  thumbnail: { width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, flexShrink: 0, borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  copy: { minWidth: 0, flex: 1, gap: 0 }, syp: { justifyContent: 'flex-start' }, sypValue: { ...typography.numericEmphasis },
  addButton: { minWidth: 72, paddingHorizontal: spacing.xs },
});
