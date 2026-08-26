import * as FileSystem from 'expo-file-system/legacy';

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

function extensionOf(uri: string) {
  const clean = uri.split(/[?#]/)[0] ?? '';
  const match = clean.match(/\.([a-zA-Z0-9]{2,5})$/);
  const extension = match?.[1]?.toLowerCase();
  return extension && ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(extension) ? extension : 'jpg';
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
  await validateProductImage(sourceUri);
  await ensureDirectory();
  const extension = extensionOf(sourceUri);
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const relative = `media/products/product-${productUuid}-${nonce}.${extension}`;
  const destination = `${FileSystem.documentDirectory}sarafy/${relative}`;
  const temporary = `${destination}.tmp`;
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: temporary });
    await validateProductImage(temporary);
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
