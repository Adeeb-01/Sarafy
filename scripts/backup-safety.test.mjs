import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const storage = await readFile(new URL('../src/backup/backupStorage.ts', import.meta.url), 'utf8');
const manager = await readFile(new URL('../src/backup/backupManager.ts', import.meta.url), 'utf8');
const archive = await readFile(new URL('../src/backup/backupArchive.ts', import.meta.url), 'utf8');
const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');

function occursInOrder(source, fragments) {
  let cursor = -1;
  for (const fragment of fragments) {
    cursor = source.indexOf(fragment, cursor + 1);
    assert.notEqual(cursor, -1, `Missing or out-of-order fragment: ${fragment}`);
  }
}

test('fresh install creates sarafy/backups with modern idempotent API', () => {
  assert.match(storage, /new Directory\(Paths\.document, 'sarafy', 'backups'\)/);
  assert.match(storage, /intermediates:\s*true/);
  assert.match(storage, /idempotent:\s*true/);
  occursInOrder(manager, ['ensureBackupDirectory()', 'temporaryFile.create()', 'writeSarafyArchive(temporaryFile']);
});

test('a deleted backups directory is recreated on every backup attempt', () => {
  assert.match(manager, /async function writeBackup[\s\S]*?ensureBackupDirectory\(\)/);
  assert.match(manager, /function rotatePreImportBackups[\s\S]*?ensureBackupDirectory\(\)\.list\(\)/);
});

test('consecutive backups use unique names and refuse overwrite', () => {
  assert.match(manager, /Math\.random\(\) \* 1_000_000/);
  assert.match(manager, /if \(finalFile\.exists \|\| temporaryFile\.exists\) throw new Error\('BACKUP_NAME_COLLISION'\)/);
  assert.doesNotMatch(manager, /finalFile\.delete\(\)[\s\S]*?temporaryFile\.move/);
});

test('partial writes stay hidden and stale writing files are cleaned at startup', () => {
  occursInOrder(manager, [
    'temporaryFile.create()',
    'writeSarafyArchive(temporaryFile',
    "readSarafyArchive<SarafyBackup>(temporaryFile.uri",
    'temporaryFile.move(finalFile)',
    "readSarafyArchive<SarafyBackup>(finalFile.uri",
  ]);
  assert.match(storage, /endsWith\('\.sarafy\.writing'\)/);
  assert.match(app, /cleanupStaleBackupFiles\(\)/);
  assert.doesNotMatch(archive, /new File\(`\$\{destinationUri\}\.writing`\)/);
});

test('sharing checks the final file before expo-sharing', () => {
  occursInOrder(manager, [
    'export async function shareBackup',
    "assertReadableNonEmptyFile(finalFile, 'BACKUP_FINAL_FILE_NOT_SHAREABLE')",
    'Sharing.shareAsync(finalFile.uri',
  ]);
});

test('pre-import, full restore, undo, and rotation use the same writer and directory', () => {
  assert.match(manager, /createPreImportBackup[\s\S]*?writeBackup\('pre-import'/);
  assert.match(manager, /createPreImportBackup[\s\S]*?rotatePreImportBackups\(\)/);
  assert.equal((manager.match(/new Directory\(Paths\.document, 'sarafy', 'backups'/g) ?? []).length, 0);
  assert.doesNotMatch(archive, /sarafy\/backups/);
});
