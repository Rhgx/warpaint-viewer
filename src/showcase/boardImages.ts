// Images imported onto the board, kept apart from the autosave because localStorage is too small for them.

const DATABASE_NAME = 'warpaint-viewer-board-images';
const STORE_NAME = 'images';
/** Large enough for a board-wide image in the widest export. */
const MAX_IMAGE_SIZE = 2048;

export const IMAGE_FILE_TYPES = 'image/png,image/jpeg,image/webp';

let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the board image store'));
  });
  return database;
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('board image store failed'));
  });
}

export async function saveBoardImage(assetId: string, blob: Blob): Promise<void> {
  const transaction = (await openDatabase()).transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put(blob, assetId);
  await finished(transaction);
}

export async function readBoardImage(assetId: string): Promise<Blob | null> {
  const request = (await openDatabase()).transaction(STORE_NAME).objectStore(STORE_NAME).get(assetId);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error('could not read a board image'));
  });
}

/** Undo can bring back removed images within a session, so this only runs on the board's next start. */
export async function pruneBoardImages(keep: ReadonlySet<string>): Promise<void> {
  const transaction = (await openDatabase()).transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const request = store.getAllKeys();
  request.onsuccess = () => {
    for (const key of request.result) {
      if (typeof key !== 'string' || !keep.has(key)) store.delete(key);
    }
  };
  await finished(transaction);
}

/** Checks a file really decodes, and shrinks one too large to be worth keeping. Rejects when it is not an image. */
export async function prepareBoardImage(file: Blob): Promise<{ blob: Blob; aspect: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = bitmap;
    const aspect = width / height;
    if (Math.max(width, height) <= MAX_IMAGE_SIZE) return { blob: file, aspect };
    const scale = MAX_IMAGE_SIZE / Math.max(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('could not shrink the image');
    return { blob, aspect };
  } finally {
    bitmap.close();
  }
}
