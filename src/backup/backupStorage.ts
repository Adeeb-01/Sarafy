import { Directory, File, FileMode, Paths } from 'expo-file-system';

export function getBackupDirectory(): Directory {
  return new Directory(Paths.document, 'sarafy', 'backups');
}

export function ensureBackupDirectory(): Directory {
  const backupDirectory = getBackupDirectory();
  backupDirectory.create({
    intermediates: true,
    idempotent: true,
  });
  return backupDirectory;
}

export function assertReadableNonEmptyFile(file: File, errorCode: string): void {
  if (!file.exists || file.size <= 0) throw new Error(errorCode);

  const handle = file.open(FileMode.ReadOnly);
  try {
    if (!handle.readBytes(1).length) throw new Error(errorCode);
  } finally {
    handle.close();
  }
}

export function cleanupStaleBackupFiles(): void {
  const backupDirectory = ensureBackupDirectory();
  for (const entry of backupDirectory.list()) {
    if (entry instanceof File && entry.name.endsWith('.sarafy.writing')) {
      entry.delete();
    }
  }
}
