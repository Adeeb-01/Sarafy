import { Paths } from 'expo-file-system';
import { Platform } from 'react-native';

const STORAGE_MARGIN_BYTES = 1024 * 1024;

export function assertAvailableDiskSpace(requiredBytes: number) {
  if (Platform.OS === 'web' || !Number.isFinite(requiredBytes) || requiredBytes < 0) return;
  const available = Paths.availableDiskSpace;
  if (Number.isFinite(available) && available >= 0 && available < requiredBytes + STORAGE_MARGIN_BYTES) {
    throw new Error('INSUFFICIENT_STORAGE');
  }
}
