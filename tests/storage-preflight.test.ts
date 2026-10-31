import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { LocalStore } from "../apps/client/src/storage/store.js";
import { MemoryDirectory, MemoryFile } from "./helpers/memory-files.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await setImmediate();
  expect(check()).toBe(true);
}

describe("bounded native folder check", () => {
  it("shows write, close, read and cleanup steps and preserves existing data", async () => {
    const root = new MemoryDirectory();
    const original = await root.getDirectoryHandle("local", { create: true });
    const progress: string[] = [];
    await new LocalStore(
      root as unknown as FileSystemDirectoryHandle,
    ).preflight((stage) => progress.push(stage));
    expect(progress).toContain("Schreibstream öffnen");
    expect(progress).toContain("Prüfdatei schließen");
    expect(progress).toContain("Prüfdatei zurücklesen");
    expect(progress.at(-1)).toBe("Prüfdateien entfernen");
    expect((await root.getDirectoryHandle("temp")).entries.size).toBe(0);
    expect(await root.getDirectoryHandle("local")).toBe(original);
  });

  it("times out a stalled permission query without creating files after a late grant", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let grant!: (value: PermissionState) => void;
    const root = Object.assign(new MemoryDirectory(), {
      queryPermission: () =>
        new Promise<PermissionState>((resolve) => {
          grant = resolve;
        }),
    });
    const create = vi.spyOn(root, "getDirectoryHandle");
    const operation = new LocalStore(
      root as unknown as FileSystemDirectoryHandle,
    ).preflight();
    const failure = expect(operation).rejects.toThrow(
      /Schreibfreigabe prüfen.*15 Sekunden/,
    );
    await vi.advanceTimersByTimeAsync(15_001);
    await failure;
    grant("granted");
    await setImmediate();
    expect(create).not.toHaveBeenCalled();
  });

  it("releases a stalled close for retry and a late completion cannot continue the old check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = new MemoryDirectory();
    let finishClose!: () => Promise<void>;
    const realCreate = MemoryFile.prototype.createWritable;
    const writes = vi
      .spyOn(MemoryFile.prototype, "createWritable")
      .mockImplementationOnce(async function (this: MemoryFile) {
        const stream = await realCreate.call(this);
        const close = stream.close.bind(stream);
        stream.close = () =>
          new Promise<void>((resolve, reject) => {
            finishClose = () => close().then(resolve, reject);
          });
        return stream;
      });
    const progress: string[] = [];
    const store = new LocalStore(root as unknown as FileSystemDirectoryHandle);
    const operation = store.preflight((stage) => progress.push(stage));
    const failure = expect(operation).rejects.toThrow(
      /Prüfdatei schließen.*15 Sekunden/,
    );
    await until(() => Boolean(finishClose));
    await vi.advanceTimersByTimeAsync(15_001);
    await failure;
    const afterTimeout = progress.slice();
    // A new check has its own UUID, so it can succeed while the old native
    // call is still pending. Neither operation touches actual recordings.
    await store.preflight();
    expect(writes).toHaveBeenCalledTimes(3);
    await finishClose();
    await until(
      () =>
        root.entries.get("temp") instanceof MemoryDirectory &&
        (root.entries.get("temp") as MemoryDirectory).entries.size === 0,
    );
    expect(progress).toEqual(afterTimeout);
    expect(writes).toHaveBeenCalledTimes(3);
  });

  it("times out cleanup separately from successful writing and reading", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(MemoryDirectory.prototype, "removeEntry").mockImplementation(
      () => new Promise(() => {}),
    );
    const progress: string[] = [];
    const operation = new LocalStore(
      new MemoryDirectory() as unknown as FileSystemDirectoryHandle,
    ).preflight((stage) => progress.push(stage));
    const failure = expect(operation).rejects.toThrow(
      /Prüfdateien entfernen.*15 Sekunden/,
    );
    await until(() => progress.at(-1) === "Prüfdateien entfernen");
    await vi.advanceTimersByTimeAsync(15_001);
    await failure;
  });
});
