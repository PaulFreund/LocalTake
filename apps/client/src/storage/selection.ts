import { LocalStore } from "./store.js";
import { storageDeadline } from "./deadline.js";

// Temporarily require native folders for production recordings. Preserve OPFS
// data and the implementation so this option can be deliberately re-enabled.
export const BROWSER_STORAGE_ENABLED = false;

export type StorageKind = "folder" | "browser" | "diagnostic";
export interface StorageSelection {
  kind: StorageKind;
  root: FileSystemDirectoryHandle;
}
export interface BrowserStorageStatus {
  persistent: boolean | null;
  quota: number | null;
  usage: number | null;
}

// Older versions stored only a handle. Preserve it without treating an OPFS
// diagnostic handle as a native folder that needs requestPermission().
export function normalizeStorageSelection(
  value: unknown,
): StorageSelection | null {
  if (!value || typeof value !== "object") return null;
  if ("kind" in value && value.kind === "directory") {
    const root = value as FileSystemDirectoryHandle;
    return {
      kind: root.name.startsWith("diagnostic-") ? "diagnostic" : "folder",
      root,
    };
  }
  if (
    "kind" in value &&
    ["folder", "browser", "diagnostic"].includes(String(value.kind)) &&
    "root" in value &&
    value.root &&
    typeof value.root === "object" &&
    "kind" in value.root &&
    value.root.kind === "directory"
  )
    return value as StorageSelection;
  return null;
}

export async function savedStorage(
  write?: StorageSelection,
): Promise<StorageSelection | null> {
  return storageDeadline(
    async (signal) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("localtake-preferences", 1);
        let settled = false;
        const failed = (error: unknown) => {
          settled = true;
          signal.removeEventListener("abort", aborted);
          reject(error);
        };
        const aborted = () => failed(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        request.onupgradeneeded = () => {
          if (settled) {
            request.transaction?.abort();
            return;
          }
          request.result.createObjectStore("handles");
        };
        request.onsuccess = () => {
          if (settled) {
            request.result.close();
            return;
          }
          settled = true;
          signal.removeEventListener("abort", aborted);
          resolve(request.result);
        };
        request.onerror = () => failed(request.error);
        request.onblocked = () =>
          failed(
            new Error(
              "Ein anderer Tab blockiert die gespeicherte Ordnerwahl. Andere LocalTake-Tabs schließen und erneut versuchen.",
            ),
          );
      });
      try {
        signal.throwIfAborted();
        const value = await new Promise<unknown>((resolve, reject) => {
          const transaction = db.transaction(
            "handles",
            write ? "readwrite" : "readonly",
          );
          const request = write
            ? transaction.objectStore("handles").put(write, "recordings")
            : transaction.objectStore("handles").get("recordings");
          const finish = (error?: unknown) => {
            signal.removeEventListener("abort", aborted);
            if (error) reject(error);
            else resolve(write ?? request.result ?? null);
          };
          const aborted = () => {
            try {
              transaction.abort();
            } catch {
              /* already completed */
            }
            finish(signal.reason);
          };
          signal.addEventListener("abort", aborted, { once: true });
          request.onerror = () => finish(request.error);
          transaction.oncomplete = () => finish();
          transaction.onabort = () =>
            finish(
              transaction.error ??
                new Error("Speicherauswahl konnte nicht gemerkt werden."),
            );
          transaction.onerror = () => finish(transaction.error);
        });
        return normalizeStorageSelection(value);
      } finally {
        db.close();
      }
    },
    write
      ? "Ordnerwahl für den nächsten Besuch merken"
      : "Gespeicherte Ordnerwahl öffnen",
    3000,
  );
}

export async function storagePermission(
  selection: StorageSelection,
): Promise<PermissionState> {
  // OPFS has no native folder permission prompt. Some Chromium derivatives
  // provide OPFS handles but do not implement queryPermission at all.
  return selection.kind === "folder"
    ? storageDeadline(
        () => selection.root.queryPermission({ mode: "readwrite" }),
        "Gespeicherte Ordnerfreigabe prüfen",
        3000,
      )
    : "granted";
}

export async function openBrowserStorage(
  storage: Pick<StorageManager, "getDirectory"> = navigator.storage,
): Promise<LocalStore> {
  const root = await (
    await storage.getDirectory()
  ).getDirectoryHandle("localtake-recordings", { create: true });
  const store = new LocalStore(root);
  await store.preflight();
  return store;
}

export async function browserStorageStatus(
  storage: StorageManager = navigator.storage,
  requestPersistence = false,
): Promise<BrowserStorageStatus> {
  const persistent = await (async () => {
    try {
      return requestPersistence
        ? await storage.persist()
        : await storage.persisted();
    } catch {
      return null;
    }
  })();
  let estimate: StorageEstimate = {};
  try {
    estimate = await storage.estimate();
  } catch {
    // Quota reporting is optional, not a substitute for a successful write.
  }
  const size = (value?: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  return {
    persistent,
    quota: size(estimate.quota),
    usage: size(estimate.usage),
  };
}
