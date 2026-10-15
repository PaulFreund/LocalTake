import { describe, expect, it, vi } from "vitest";
import {
  browserStorageStatus,
  normalizeStorageSelection,
  openBrowserStorage,
  storagePermission,
} from "../apps/client/src/storage/selection.js";
import { writeImmutable } from "../apps/client/src/storage/store.js";
import { MemoryDirectory } from "./helpers/memory-files.js";

describe("local storage selection", () => {
  it("reopens the same browser directory without any native folder API and retains originals", async () => {
    const opfs = new MemoryDirectory("opfs");
    const storage = {
      getDirectory: async () => opfs as unknown as FileSystemDirectoryHandle,
    };
    const first = await openBrowserStorage(storage);
    await writeImmutable(
      first.root,
      "original.mp4",
      new Uint8Array([1, 3, 7]).buffer,
    );
    const reopened = await openBrowserStorage(storage);
    expect(reopened.root).toBe(first.root);
    expect(
      await storagePermission({ kind: "browser", root: reopened.root }),
    ).toBe("granted");
    expect(
      new Uint8Array(
        await (
          await (await reopened.root.getFileHandle("original.mp4")).getFile()
        ).arrayBuffer(),
      ),
    ).toEqual(new Uint8Array([1, 3, 7]));
    // The write test at recording depth leaves nothing behind.
    const archive = await reopened.root.getDirectoryHandle("temp");
    expect(await Array.fromAsync(archive.values())).toEqual([]);
  });

  it("rejects browser storage when the preflight file cannot be closed", async () => {
    const opfs = new MemoryDirectory("opfs");
    const root = await opfs.getDirectoryHandle("localtake-recordings", {
      create: true,
    });
    const failing = (dir: MemoryDirectory): MemoryDirectory => {
      dir.failCloseFor = ".json";
      const get = dir.getDirectoryHandle.bind(dir);
      dir.getDirectoryHandle = async (name, options) =>
        failing(await get(name, options));
      return dir;
    };
    failing(await root.getDirectoryHandle("temp", { create: true }));
    await expect(
      openBrowserStorage({
        getDirectory: async () => opfs as unknown as FileSystemDirectoryHandle,
      }),
    ).rejects.toThrow("Disk failure at close");
  });

  it("migrates old handles and keeps diagnostic roots separate from native folder permissions", async () => {
    const folder = Object.assign(new MemoryDirectory("Downloads"), {
      queryPermission: vi.fn(async () => "prompt" as const),
    });
    const selection = normalizeStorageSelection(folder)!;
    expect(selection.kind).toBe("folder");
    expect(await storagePermission(selection)).toBe("prompt");
    expect(folder.queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
    const diagnostic = normalizeStorageSelection(
      new MemoryDirectory("diagnostic-previous"),
    )!;
    expect(diagnostic.kind).toBe("diagnostic");
    expect(await storagePermission(diagnostic)).toBe("granted");
    expect(
      normalizeStorageSelection({
        kind: "browser",
        root: new MemoryDirectory(),
      })?.kind,
    ).toBe("browser");
    expect(normalizeStorageSelection({ kind: "browser", root: {} })).toBeNull();
  });

  it("reports refused persistence without claiming recordings are protected", async () => {
    const storage = {
      persist: vi.fn(async () => false),
      persisted: vi.fn(async () => true),
      estimate: async () => ({ quota: 900, usage: 100 }),
    };
    expect(
      await browserStorageStatus(storage as unknown as StorageManager, true),
    ).toEqual({ persistent: false, quota: 900, usage: 100 });
    expect(storage.persisted).not.toHaveBeenCalled();
    expect(
      await browserStorageStatus(storage as unknown as StorageManager),
    ).toEqual({ persistent: true, quota: 900, usage: 100 });
    expect(storage.persist).toHaveBeenCalledTimes(1);
  });

  it("marks unavailable persistence and quota as unknown rather than inventing free space", async () => {
    const storage = {
      persist: async () => {
        throw new Error("Unavailable");
      },
      estimate: async () => {
        throw new Error("Unavailable");
      },
    };
    expect(
      await browserStorageStatus(storage as unknown as StorageManager, true),
    ).toEqual({ persistent: null, quota: null, usage: null });
  });
});
