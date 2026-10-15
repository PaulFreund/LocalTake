import { LocalStore } from "./store.js";

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
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("localtake-preferences", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction(
        "handles",
        write ? "readwrite" : "readonly",
      );
      const request = write
        ? transaction.objectStore("handles").put(write, "recordings")
        : transaction.objectStore("handles").get("recordings");
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(write ?? request.result ?? null);
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error("Speicherauswahl konnte nicht gemerkt werden."),
        );
      transaction.onerror = () => reject(transaction.error);
    });
    return normalizeStorageSelection(value);
  } finally {
    db.close();
  }
}

export async function storagePermission(
  selection: StorageSelection,
): Promise<PermissionState> {
  // OPFS has no native folder permission prompt. Some Chromium derivatives
  // provide OPFS handles but do not implement queryPermission at all.
  return selection.kind === "folder"
    ? selection.root.queryPermission({ mode: "readwrite" })
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
