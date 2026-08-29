import { File, FileMode, Paths } from 'expo-file-system';
import { Product } from '@/types';
import { isStoredProductImagePath, validateProductImageContent } from '@/media/productImageStorage';
import { assertAvailableDiskSpace } from '@/utils/storageSafety';

const MAGIC = 'SARAFY2\n';
const LENGTH_WIDTH = 12;
const CHUNK_SIZE = 256 * 1024;

interface ArchiveImage {
  relativePath: string;
  size: number;
  checksum: string;
}

interface ArchiveHeader {
  backupJson: string;
  backupChecksum: string;
  images: ArchiveImage[];
}

function updateChecksum(checksum: number, bytes: Uint8Array) {
  let value = checksum;
  for (const byte of bytes) value = Math.imul(value ^ byte, 0x01000193);
  return value >>> 0;
}

function checksumBytes(bytes: Uint8Array) {
  return updateChecksum(0x811c9dc5, bytes).toString(16).padStart(8, '0');
}

function checksumFile(uri: string, size: number) {
  const sourceFile = new File(uri);
  if (!sourceFile.exists || sourceFile.size !== size) throw new Error('BACKUP_IMAGE_NOT_READABLE');
  const source = sourceFile.open(FileMode.ReadOnly);
  let checksum = 0x811c9dc5;
  try {
    let remaining = size;
    while (remaining > 0) {
      const bytes = source.readBytes(Math.min(CHUNK_SIZE, remaining));
      if (!bytes.length) throw new Error('UNEXPECTED_IMAGE_EOF');
      checksum = updateChecksum(checksum, bytes);
      remaining -= bytes.length;
    }
  } finally { source.close(); }
  return checksum.toString(16).padStart(8, '0');
}

export async function writeSarafyArchive<T>(
  destination: File,
  backup: T,
  products: Product[],
): Promise<number> {
  const images: ArchiveImage[] = [];
  const seenPaths = new Set<string>();
  for (const product of products) {
    const path = product.image_uri;
    if (!isStoredProductImagePath(path) || seenPaths.has(path)) continue;
    seenPaths.add(path);
    const sourceFile = new File(Paths.document, 'sarafy', path);
    if (sourceFile.exists && sourceFile.size > 0) {
      images.push({ relativePath: path, size: sourceFile.size, checksum: checksumFile(sourceFile.uri, sourceFile.size) });
    }
  }
  const backupJson = JSON.stringify(backup);
  const backupChecksum = checksumBytes(new TextEncoder().encode(backupJson));
  const headerBytes = new TextEncoder().encode(JSON.stringify({ backupJson, backupChecksum, images } satisfies ArchiveHeader));
  if (headerBytes.length > 999_999_999_999) throw new Error('BACKUP_METADATA_TOO_LARGE');
  assertAvailableDiskSpace(MAGIC.length + LENGTH_WIDTH + headerBytes.length + images.reduce((sum, image) => sum + image.size, 0));
  if (!destination.exists) throw new Error('BACKUP_TEMP_FILE_NOT_CREATED');
  const output = destination.open(FileMode.Truncate);
  try {
    output.writeBytes(new TextEncoder().encode(`${MAGIC}${String(headerBytes.length).padStart(LENGTH_WIDTH, '0')}`));
    output.writeBytes(headerBytes);
    for (const image of images) {
      const imageFile = new File(Paths.document, 'sarafy', image.relativePath);
      if (!imageFile.exists || imageFile.size !== image.size) throw new Error('BACKUP_IMAGE_NOT_READABLE');
      const source = imageFile.open(FileMode.ReadOnly);
      try {
        let remaining = image.size;
        while (remaining > 0) {
          const bytes = source.readBytes(Math.min(CHUNK_SIZE, remaining));
          if (!bytes.length) throw new Error('UNEXPECTED_IMAGE_EOF');
          output.writeBytes(bytes);
          remaining -= bytes.length;
        }
      } finally { source.close(); }
    }
  } catch (error) {
    output.close();
    throw error;
  }
  output.close();
  return images.length;
}

export async function readSarafyArchive<T>(
  sourceUri: string,
  extractImages = false,
  allowedImagePaths?: ReadonlySet<string>,
): Promise<{ backup: T; extractedImages: number }> {
  const sourceFile = new File(sourceUri);
  const source = sourceFile.open(FileMode.ReadOnly);
  try {
    const prefix = new TextDecoder().decode(source.readBytes(MAGIC.length + LENGTH_WIDTH));
    if (!prefix.startsWith(MAGIC)) throw new Error('NOT_SARAFY_ARCHIVE');
    const headerLength = Number(prefix.slice(MAGIC.length));
    if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || headerLength > 50 * 1024 * 1024) {
      throw new Error('INVALID_ARCHIVE_HEADER');
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(source.readBytes(headerLength)));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { images?: unknown }).images)) {
      throw new Error('INVALID_ARCHIVE_HEADER');
    }
    const candidate = parsed as Partial<ArchiveHeader> & { backup?: T };
    const isLegacyHeader = typeof candidate.backupJson !== 'string';
    let backup: T;
    if (isLegacyHeader) {
      if (!candidate.backup) throw new Error('INVALID_ARCHIVE_HEADER');
      backup = candidate.backup;
    } else {
      if (typeof candidate.backupChecksum !== 'string' ||
          checksumBytes(new TextEncoder().encode(candidate.backupJson as string)) !== candidate.backupChecksum) {
        throw new Error('BACKUP_CHECKSUM_MISMATCH');
      }
      backup = JSON.parse(candidate.backupJson as string) as T;
    }
    const images = candidate.images as ArchiveImage[];
    const seenPaths = new Set<string>();
    let expectedSize = MAGIC.length + LENGTH_WIDTH + headerLength;
    for (const image of images) {
      if (!isStoredProductImagePath(image.relativePath) || seenPaths.has(image.relativePath) ||
          !Number.isSafeInteger(image.size) || image.size < 0 || image.size > 15 * 1024 * 1024 ||
          (!isLegacyHeader && !/^[0-9a-f]{8}$/.test(image.checksum))) {
        throw new Error('UNSAFE_ARCHIVE_ENTRY');
      }
      seenPaths.add(image.relativePath);
      expectedSize += image.size;
    }
    if (sourceFile.size !== expectedSize) throw new Error('ARCHIVE_SIZE_MISMATCH');
    if (!extractImages) return { backup, extractedImages: 0 };
    assertAvailableDiskSpace(images.reduce((sum, image) =>
      allowedImagePaths && !allowedImagePaths.has(image.relativePath) ? sum : sum + image.size, 0));
    let extractedImages = 0;
    const replaced: Array<{ final: File; previous: File | null }> = [];
    try {
      for (const image of images) {
        if (allowedImagePaths && !allowedImagePaths.has(image.relativePath)) {
          let remaining = image.size;
          let checksum = 0x811c9dc5;
          while (remaining > 0) {
            const bytes = source.readBytes(Math.min(CHUNK_SIZE, remaining));
            if (!bytes.length) throw new Error('UNEXPECTED_ARCHIVE_EOF');
            checksum = updateChecksum(checksum, bytes);
            remaining -= bytes.length;
          }
          if (!isLegacyHeader && checksum.toString(16).padStart(8, '0') !== image.checksum) throw new Error('IMAGE_CHECKSUM_MISMATCH');
          continue;
        }
        const destinationUri = new File(Paths.document, 'sarafy', image.relativePath).uri;
        const temporary = new File(`${destinationUri}.importing`);
        temporary.create({ overwrite: true, intermediates: true });
        try {
          const output = temporary.open(FileMode.Truncate);
          try {
            let remaining = image.size;
            let checksum = 0x811c9dc5;
            while (remaining > 0) {
              const bytes = source.readBytes(Math.min(CHUNK_SIZE, remaining));
              if (!bytes.length) throw new Error('UNEXPECTED_ARCHIVE_EOF');
              output.writeBytes(bytes);
              checksum = updateChecksum(checksum, bytes);
              remaining -= bytes.length;
            }
            if (!isLegacyHeader && checksum.toString(16).padStart(8, '0') !== image.checksum) throw new Error('IMAGE_CHECKSUM_MISMATCH');
          } finally { output.close(); }
          validateProductImageContent(temporary.uri);
        } catch (error) {
          if (temporary.exists) temporary.delete();
          throw error;
        }
        const final = new File(destinationUri);
        const previous = final.exists ? new File(`${destinationUri}.previous`) : null;
        if (previous) {
          if (previous.exists) previous.delete();
          final.move(previous);
        }
        temporary.move(final);
        replaced.push({ final, previous });
        extractedImages += 1;
      }
      for (const item of replaced) if (item.previous?.exists) item.previous.delete();
    } catch (error) {
      for (const item of [...replaced].reverse()) {
        if (item.final.exists) item.final.delete();
        if (item.previous?.exists) item.previous.move(item.final);
      }
      throw error;
    }
    return { backup, extractedImages };
  } finally { source.close(); }
}
