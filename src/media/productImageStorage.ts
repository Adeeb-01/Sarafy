import * as FileSystem from 'expo-file-system/legacy';
import { File, FileMode } from 'expo-file-system';
import { assertAvailableDiskSpace } from '@/utils/storageSafety';

const ROOT = `${FileSystem.documentDirectory}sarafy/media/products/`;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const SAFE_RELATIVE = /^media\/products\/[a-zA-Z0-9._-]+$/;

export function isStoredProductImagePath(path: string | null): path is string {
  return typeof path === 'string' && SAFE_RELATIVE.test(path);
}

async function ensureDirectory() {
  const info = await FileSystem.getInfoAsync(ROOT);
  if (!info.exists) await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true });
}

export function validateProductImageContent(uri: string) {
  const file = new File(uri);
  const handle = file.open(FileMode.ReadOnly);
  let bytes: Uint8Array;
  try { bytes = handle.readBytes(16); }
  finally { handle.close(); }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
  const ascii = String.fromCharCode(...bytes);
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp';
  throw new Error('INVALID_IMAGE_CONTENT');
}

export function resolveProductImageUri(path: string | null): string | null {
  if (!path) return null;
  if (SAFE_RELATIVE.test(path)) return `${FileSystem.documentDirectory}sarafy/${path}`;
  return path.startsWith('file://') || path.startsWith('content://') ? path : null;
}

export async function validateProductImage(uri: string) {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.isDirectory) throw new Error('IMAGE_NOT_FOUND');
  if (('size' in info ? info.size : 0) > MAX_IMAGE_BYTES) throw new Error('IMAGE_TOO_LARGE');
  return info;
}

export async function saveProductImage(sourceUri: string, productUuid: string): Promise<string> {
  const source = await validateProductImage(sourceUri);
  assertAvailableDiskSpace('size' in source ? source.size : 0);
  await ensureDirectory();
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const basename = `product-${productUuid}-${nonce}`;
  const temporary = `${ROOT}${basename}.tmp`;
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: temporary });
    await validateProductImage(temporary);
    const extension = validateProductImageContent(temporary);
    const relative = `media/products/${basename}.${extension}`;
    const destination = `${FileSystem.documentDirectory}sarafy/${relative}`;
    await FileSystem.moveAsync({ from: temporary, to: destination });
    return relative;
  } catch (error) {
    await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteProductImage(relativePath: string | null) {
  if (!relativePath || !SAFE_RELATIVE.test(relativePath)) return;
  await FileSystem.deleteAsync(`${FileSystem.documentDirectory}sarafy/${relativePath}`, { idempotent: true });
}

export async function migrateLegacyProductImage(uri: string | null, productUuid: string) {
  if (!uri || SAFE_RELATIVE.test(uri)) return uri;
  if (!uri.startsWith('file://') && !uri.startsWith('content://')) return uri;
  try { return await saveProductImage(uri, productUuid); } catch { return uri; }
}

export interface ImageHealthReport {
  healthy: number;
  missing: string[];
  orphaned: string[];
  temporary: string[];
  bytesUsed: number;
}

export async function checkProductImages(referencedPaths: string[]): Promise<ImageHealthReport> {
  await ensureDirectory();
  const referenced = new Set(referencedPaths.filter(path => SAFE_RELATIVE.test(path)));
  const files = await FileSystem.readDirectoryAsync(ROOT);
  const missing: string[] = [];
  let healthy = 0;
  let bytesUsed = 0;
  for (const path of referenced) {
    const info = await FileSystem.getInfoAsync(`${FileSystem.documentDirectory}sarafy/${path}`);
    if (!info.exists) missing.push(path);
    else { healthy += 1; bytesUsed += 'size' in info ? info.size : 0; }
  }
  const relativeFiles = files.map(name => `media/products/${name}`);
  return {
    healthy,
    missing,
    orphaned: relativeFiles.filter(path => !referenced.has(path) && !path.endsWith('.tmp')),
    temporary: relativeFiles.filter(path => path.endsWith('.tmp')),
    bytesUsed,
  };
}

export async function cleanupUnusedProductImages(referencedPaths: string[]) {
  await ensureDirectory();
  const referenced = new Set(referencedPaths.filter(path => SAFE_RELATIVE.test(path)));
  const files = await FileSystem.readDirectoryAsync(ROOT);
  for (const name of files) {
    const relative = `media/products/${name}`;
    if (!referenced.has(relative) && !name.endsWith('.previous')) {
      await FileSystem.deleteAsync(`${ROOT}${name}`, { idempotent: true });
    }
  }
}

export async function cleanupTemporaryProductImages() {
  await ensureDirectory();
  const files = await FileSystem.readDirectoryAsync(ROOT);
  for (const name of files.filter(item => item.endsWith('.tmp') || item.endsWith('.importing'))) {
    await FileSystem.deleteAsync(`${ROOT}${name}`, { idempotent: true });
  }
  for (const name of files.filter(item => item.endsWith('.previous'))) {
    const previous = `${ROOT}${name}`;
    const final = `${ROOT}${name.slice(0, -'.previous'.length)}`;
    const finalInfo = await FileSystem.getInfoAsync(final);
    if (finalInfo.exists) await FileSystem.deleteAsync(previous, { idempotent: true });
    else await FileSystem.moveAsync({ from: previous, to: final });
  }
}
