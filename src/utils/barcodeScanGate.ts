export const BARCODE_SCAN_COOLDOWN_MS = 800;

export type BarcodeScanGate = {
  begin: (value: string, now?: number) => string | null;
  complete: (barcode: string, now?: number) => void;
  reset: () => void;
};

export function createBarcodeScanGate(cooldownMs = BARCODE_SCAN_COOLDOWN_MS): BarcodeScanGate {
  let processing = false;
  let lastObservedBarcode: string | null = null;
  let lastObservedAt = Number.NEGATIVE_INFINITY;

  return {
    begin(value, now = Date.now()) {
      const barcode = value.trim() || null;
      if (!barcode) return null;
      if (processing) {
        if (barcode === lastObservedBarcode) lastObservedAt = now;
        return null;
      }
      if (barcode === lastObservedBarcode && now - lastObservedAt < cooldownMs) {
        lastObservedAt = now;
        return null;
      }
      lastObservedBarcode = barcode;
      lastObservedAt = now;
      processing = true;
      return barcode;
    },
    complete() {
      processing = false;
    },
    reset() {
      processing = false;
      lastObservedBarcode = null;
      lastObservedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
