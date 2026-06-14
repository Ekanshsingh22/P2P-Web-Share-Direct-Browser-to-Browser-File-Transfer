const DB_NAME = 'P2PWebShareDB';
const DB_VERSION = 1;

export function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      reject(`Database error: ${event.target.error}`);
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Store for file metadata: key is roomId
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'roomId' });
      }
      
      // Store for file chunks: key is roomId_chunkIndex
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks');
      }
    };
  });
}

export async function saveMeta(roomId, meta) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['meta'], 'readwrite');
    const store = transaction.objectStore('meta');
    const request = store.put({ roomId, ...meta });

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

export async function getMeta(roomId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['meta'], 'readonly');
    const store = transaction.objectStore('meta');
    const request = store.get(roomId);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function saveChunk(roomId, chunkIndex, chunkData) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chunks'], 'readwrite');
    const store = transaction.objectStore('chunks');
    const key = `${roomId}_${chunkIndex}`;
    
    // Save chunk data as ArrayBuffer/Blob
    const request = store.put(chunkData, key);

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

export async function getChunk(roomId, chunkIndex) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chunks'], 'readonly');
    const store = transaction.objectStore('chunks');
    const key = `${roomId}_${chunkIndex}`;
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function clearRoom(roomId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['meta', 'chunks'], 'readwrite');
    
    // Clear meta
    transaction.objectStore('meta').delete(roomId);
    
    // Clear chunks (we can scan keys matching roomId_ prefix and delete them)
    const chunkStore = transaction.objectStore('chunks');
    const keyRange = IDBKeyRange.bound(`${roomId}_0`, `${roomId}_\uFFFF`);
    const request = chunkStore.openCursor(keyRange);
    
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error);
  });
}
