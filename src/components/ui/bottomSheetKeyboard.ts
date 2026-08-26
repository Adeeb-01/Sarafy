export type ViewportBounds = { y: number; height: number };
export type KeyboardBounds = { screenY: number; height: number };

export function calculateKeyboardInset(
  viewport: ViewportBounds,
  keyboard: KeyboardBounds | null,
) {
  if (!keyboard || keyboard.height <= 0) return 0;
  const overlap = viewport.y + viewport.height - keyboard.screenY;
  return Math.min(keyboard.height, Math.max(0, overlap));
}

export function calculateKeyboardAwareMaxHeight({
  viewportHeight,
  keyboardInset,
  safeAreaTop,
  safeAreaBottom,
  normalMaxHeightRatio = 0.88,
}: {
  viewportHeight: number;
  keyboardInset: number;
  safeAreaTop: number;
  safeAreaBottom: number;
  normalMaxHeightRatio?: number;
}) {
  const normalMaximum = viewportHeight * normalMaxHeightRatio;
  const availableHeight = viewportHeight - keyboardInset - safeAreaTop - safeAreaBottom;
  return Math.max(0, Math.min(normalMaximum, availableHeight));
}
