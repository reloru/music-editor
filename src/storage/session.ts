/**
 * Crash/eviction recovery.
 *
 * iOS Safari discards background tabs aggressively, and an editor that loses an
 * hour of trimming because the user answered a text message is not much use.
 * When the page goes to the background we stash the current buffer as a WAV
 * blob in IndexedDB, and offer it back on the next load.
 *
 * The snapshot is 16-bit to halve the write, and skipped entirely past a size
 * cap — spending two seconds writing 300 MB during `pagehide` is worse than
 * losing the snapshot, because the browser may kill the page mid-write anyway.
 */
import type { Pcm } from '../audio/pcm';
import { byteSize } from '../audio/pcm';
import { encodeWav } from '../audio/wav';

const DB_NAME = 'music-editor';
const DB_VERSION = 1;
const STORE = 'session';
const KEY = 'current';

/** Above this, a snapshot costs more than it is worth. ~6 min of 44.1k stereo. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export interface Snapshot {
  name: string;
  savedAt: number;
  blob: Blob;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

/** Returns false when the buffer was too large to be worth snapshotting. */
export async function saveSnapshot(pcm: Pcm, name: string): Promise<boolean> {
  if (byteSize(pcm) / 2 > MAX_SNAPSHOT_BYTES) return false;
  const blob = new Blob([encodeWav(pcm, 16)], { type: 'audio/wav' });
  const snapshot: Snapshot = { name, savedAt: Date.now(), blob };
  try {
    await withStore('readwrite', (store) => store.put(snapshot, KEY));
    return true;
  } catch {
    // Private browsing or a full quota: recovery is a bonus, never a blocker.
    return false;
  }
}

export async function loadSnapshot(): Promise<Snapshot | null> {
  try {
    const snapshot = await withStore<Snapshot | undefined>('readonly', (store) => store.get(KEY));
    return snapshot ?? null;
  } catch {
    return null;
  }
}

export async function clearSnapshot(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(KEY));
  } catch {
    // Nothing to do — the snapshot is best-effort in both directions.
  }
}
