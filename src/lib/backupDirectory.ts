const DB_NAME = 'zennotes-backup-directory';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'auto-backup-directory';
export const AUTO_BACKUP_FILENAME = 'zennotes_backup_latest.json';

export type BackupDirectoryHandle = FileSystemDirectoryHandle | string;
type BackupPermission = PermissionState | 'unsupported';
type DirectoryPickerWindow = Window & typeof globalThis & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
};
type PermissionAwareDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

const isDesktopApp = () => (
  typeof window !== 'undefined' && !!window.zennotesDesktop?.isDesktop
);

const getDirectoryPickerWindow = () => window as DirectoryPickerWindow;

const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);

  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME);
    }
  };

  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export const isDirectoryPickerSupported = () => (
  typeof window !== 'undefined' && typeof getDirectoryPickerWindow().showDirectoryPicker === 'function'
);

export const isBackupDirectorySupported = () => (
  isDesktopApp() || isDirectoryPickerSupported()
);

export const getStoredBackupDirectory = async (): Promise<BackupDirectoryHandle | null> => {
  if (isDesktopApp()) {
    return window.zennotesDesktop.backup.getStoredDirectory();
  }

  if (!isDirectoryPickerSupported()) return null;

  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(HANDLE_KEY);

    request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
};

export const storeBackupDirectory = async (handle: BackupDirectoryHandle) => {
  if (isDesktopApp()) {
    await window.zennotesDesktop.backup.storeDirectory(handle as string);
    return;
  }

  const db = await openDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put(handle, HANDLE_KEY);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
};

export const clearStoredBackupDirectory = async () => {
  if (isDesktopApp()) {
    await window.zennotesDesktop.backup.clearStoredDirectory();
    return;
  }

  const db = await openDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.delete(HANDLE_KEY);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
};

export const getBackupDirectoryPermission = async (
  handle: BackupDirectoryHandle,
  requestWrite = false,
): Promise<BackupPermission> => {
  if (typeof handle === 'string') {
    return 'granted';
  }

  const permissionHandle = handle as PermissionAwareDirectoryHandle;
  if (typeof permissionHandle.queryPermission !== 'function') return 'unsupported';

  const options = { mode: 'readwrite' as const };
  const current = await permissionHandle.queryPermission(options);

  if (current === 'granted' || !requestWrite || typeof permissionHandle.requestPermission !== 'function') {
    return current;
  }

  return permissionHandle.requestPermission(options);
};

export const selectBackupDirectory = async (): Promise<BackupDirectoryHandle | null> => {
  if (isDesktopApp()) {
    return window.zennotesDesktop.backup.selectDirectory();
  }

  if (!isDirectoryPickerSupported()) return null;
  return getDirectoryPickerWindow().showDirectoryPicker?.({ mode: 'readwrite' }) ?? null;
};

export const writeBackupSnapshot = async (
  handle: BackupDirectoryHandle,
  notes: unknown,
) => {
  if (typeof handle === 'string') {
    await window.zennotesDesktop.backup.writeSnapshot(handle, notes);
    return;
  }

  const fileHandle = await handle.getFileHandle(AUTO_BACKUP_FILENAME, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(notes, null, 2));
  await writable.close();
};
