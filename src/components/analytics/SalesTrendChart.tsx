import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { MonetaryValue } from '@/components/ui';
import type { Language } from '@/types';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import type { AnalyticsPeriod } from '@/utils/salesAnalytics';
import { formatCompactAxisValue, formatTrendAxisDate, formatTrendTooltipDate, trendAccessibilitySummary } from '@/utils/analyticsUiState';
import { haptics } from '@/utils/haptics';
import { uiText } from '@/i18n';

const MULTI_CHART_HEIGHT = 220;
const SINGLE_CHART_HEIGHT = 168;
const MULTI_PLOT_HEIGHT = 146;
const SINGLE_PLOT_HEIGHT = 88;
const PLOT_TOP = 12;
const Y_AXIS_WIDTH = 76;
const POINT_INSET = 10;
const X_LABEL_WIDTH = 64;
const TOOLTIP_WIDTH = 154;
const TOOLTIP_HEIGHT = 60;

type Point = { date: Date; value: number };
type ChartPoint = Point & { x: number; y: number };

export const SalesTrendChart = memo(function SalesTrendChart({ points, period, language }: { points: Point[]; period: AnalyticsPeriod; language: Language }) {
  const { colors } = useAppTheme();
  const rtl = language === 'ar';
  const copy = uiText(language);
  const singlePoint = points.length === 1;
  const chartHeight = singlePoint ? SINGLE_CHART_HEIGHT : MULTI_CHART_HEIGHT;
  const plotHeight = singlePoint ? SINGLE_PLOT_HEIGHT : MULTI_PLOT_HEIGHT;
  const xAxisTop = PLOT_TOP + plotHeight + spacing.xs;
  const [width, setWidth] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(singlePoint ? 0 : null);
  const lastHapticIndex = useRef(singlePoint ? 0 : -1);
  const plotLeft = Y_AXIS_WIDTH + POINT_INSET;
  const plotRight = Math.max(plotLeft + 1, width - POINT_INSET);
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const maximum = useMemo(() => Math.max(0, ...points.map(point => Number.isFinite(point.value) ? point.value : 0)), [points]);
  const scaleMaximum = Math.max(1, maximum);
  const chartPoints = useMemo<ChartPoint[]>(() => points.map((point, index) => {
    const physicalIndex = rtl ? points.length - 1 - index : index;
    const x = singlePoint ? plotLeft + plotWidth / 2 : plotLeft + physicalIndex * plotWidth / (points.length - 1);
    const y = singlePoint ? PLOT_TOP + plotHeight / 2 : PLOT_TOP + plotHeight - Math.max(0, point.value) / scaleMaximum * plotHeight;
    return { ...point, x, y };
  }), [plotHeight, plotLeft, plotWidth, points, rtl, scaleMaximum, singlePoint]);
  const areaLinePath = useMemo(() => chartPoints.length > 1 ? chartPoints.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ') : '', [chartPoints]);
  const areaPath = useMemo(() => {
    const first = chartPoints[0]; const last = chartPoints.at(-1);
    return first && last && chartPoints.length > 1 ? `${areaLinePath} L ${last.x} ${PLOT_TOP + plotHeight} L ${first.x} ${PLOT_TOP + plotHeight} Z` : '';
  }, [areaLinePath, chartPoints, plotHeight]);
  const selected = selectedIndex === null ? null : chartPoints[selectedIndex];
  const tooltipLeft = selected
    ? selected.x >= width / 2
      ? Math.max(spacing.xxs, selected.x - TOOLTIP_WIDTH - spacing.sm)
      : Math.min(width - TOOLTIP_WIDTH - spacing.xxs, selected.x + spacing.sm)
    : spacing.xxs;
  const tooltipTop = selected ? Math.max(spacing.xxs, Math.min(xAxisTop - TOOLTIP_HEIGHT - spacing.xxs, selected.y - TOOLTIP_HEIGHT / 2)) : spacing.xxs;
  const labelIndices = useMemo(() => points.length <= 2 ? points.map((_, index) => index) : [0, Math.floor((points.length - 1) / 2), points.length - 1], [points]);
  const guides = useMemo(() => {
    if (singlePoint && points[0]) return [
      { key: 'value', y: PLOT_TOP + plotHeight / 2, value: points[0].value, showLabel: true },
      { key: 'zero', y: PLOT_TOP + plotHeight, value: 0, showLabel: points[0].value !== 0 },
    ];
    return [0, 0.5, 1].map(ratio => ({ key: String(ratio), y: PLOT_TOP + plotHeight * ratio, value: maximum * (1 - ratio), showLabel: true }));
  }, [maximum, plotHeight, points, singlePoint]);

  useEffect(() => {
    const initialIndex = points.length === 1 ? 0 : null;
    lastHapticIndex.current = initialIndex ?? -1;
    setSelectedIndex(initialIndex);
  }, [period, points]);

  const selectFromTouch = useCallback((event: GestureResponderEvent) => {
    if (!points.length) return;
    const physical = points.length === 1 ? 0 : Math.round(Math.max(0, Math.min(plotWidth, event.nativeEvent.locationX)) / plotWidth * (points.length - 1));
    const index = rtl ? points.length - 1 - physical : physical;
    if (index !== lastHapticIndex.current) {
      lastHapticIndex.current = index;
      haptics.selection();
      setSelectedIndex(index);
    }
  }, [plotWidth, points.length, rtl]);

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  return <View onLayout={onLayout} accessible accessibilityRole="image" accessibilityLabel={trendAccessibilitySummary(points, period, language)} style={[styles.host, { height: chartHeight }]}>
    {width > 0 && <>
      <Svg width={width} height={chartHeight} pointerEvents="none">
        {guides.map((guide, index) => <Line key={guide.key} x1={plotLeft} x2={plotRight} y1={guide.y} y2={guide.y} stroke={colors.border} strokeWidth={StyleSheet.hairlineWidth} opacity={index === guides.length - 1 ? 0.38 : 0.68} />)}
        {areaPath ? <Path d={areaPath} fill={colors.primarySoft} opacity={0.22} /> : null}
        {chartPoints.slice(1).map((point, offset) => {
          const previous = chartPoints[offset];
          if (!previous) return null;
          const baselineSegment = previous.value === 0 && point.value === 0;
          return <Line key={`segment-${offset}`} x1={previous.x} y1={previous.y} x2={point.x} y2={point.y} stroke={baselineSegment ? colors.border : colors.primary} strokeWidth={baselineSegment ? 1 : 2.5} strokeLinecap="round" opacity={baselineSegment ? 0.72 : 1} />;
        })}
        {singlePoint && chartPoints[0] && <><Circle cx={chartPoints[0].x} cy={chartPoints[0].y} r={10} fill={colors.primarySoft} /><Circle cx={chartPoints[0].x} cy={chartPoints[0].y} r={5} fill={colors.primary} /></>}
        {selected && !singlePoint && <><Line x1={selected.x} x2={selected.x} y1={PLOT_TOP} y2={PLOT_TOP + plotHeight} stroke={colors.primary} strokeWidth={StyleSheet.hairlineWidth} strokeDasharray="3 4" opacity={0.8} /><Circle cx={selected.x} cy={selected.y} r={6} fill={colors.surface} stroke={colors.primary} strokeWidth={3} /></>}
      </Svg>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {guides.map(guide => guide.showLabel ? <Text key={`y-${guide.key}`} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} maxFontSizeMultiplier={1.2} style={[typography.caption, styles.yLabel, { top: guide.y - 10, color: colors.textMuted, writingDirection: rtl ? 'rtl' : 'ltr' }]}>{formatCompactAxisValue(guide.value, language)}</Text> : null)}
        {labelIndices.map(index => {
          const point = chartPoints[index];
          if (!point) return null;
          const left = Math.max(0, Math.min(width - X_LABEL_WIDTH, point.x - X_LABEL_WIDTH / 2));
          return <Text key={`x-${index}`} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} maxFontSizeMultiplier={1.2} style={[typography.caption, styles.xLabel, { left, top: xAxisTop, color: colors.textMuted, writingDirection: rtl ? 'rtl' : 'ltr' }]}>{formatTrendAxisDate(point.date, period, language)}</Text>;
        })}
      </View>
      <View accessible={false} onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderGrant={selectFromTouch} onResponderMove={selectFromTouch} style={[styles.touchLayer, { left: plotLeft, right: POINT_INSET, top: PLOT_TOP, height: plotHeight }]} />
      {selected && <View pointerEvents="none" style={[styles.tooltip, { left: tooltipLeft, top: tooltipTop, backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}><Text numberOfLines={1} style={[typography.caption, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left', writingDirection: rtl ? 'rtl' : 'ltr' }]}>{formatTrendTooltipDate(selected.date, language)}</Text><MonetaryValue value={selected.value} language={language} currencyLabel={copy.common.syp} inline style={[styles.tooltipMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={styles.tooltipMoneyText} /></View>}
    </>}
  </View>;
});

const styles = StyleSheet.create({
  host: { position: 'relative' },
  yLabel: { position: 'absolute', left: 0, width: Y_AXIS_WIDTH - spacing.xxs, height: 22, textAlign: 'right' },
  xLabel: { position: 'absolute', width: X_LABEL_WIDTH, height: 24, textAlign: 'center' },
  touchLayer: { position: 'absolute', minHeight: 44 },
  tooltip: { position: 'absolute', width: TOOLTIP_WIDTH, minHeight: TOOLTIP_HEIGHT, paddingHorizontal: spacing.xs, paddingVertical: spacing.xxs, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, justifyContent: 'center' },
  tooltipMoney: { justifyContent: 'flex-start' },
  tooltipMoneyText: { ...typography.numericSmall },
});
