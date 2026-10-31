import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate, setTimeout as waitForIO } from "node:timers/promises";
import {
  LocalStore,
  type StorageCheckProgress,
} from "../apps/client/src/storage/store.js";
import { MemoryDirectory, MemoryFile } from "./helpers/memory-files.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function until(check: () => boolean) {
  // Crypto/file promises use real I/O even when the storage deadlines are fake.
  // A fixed number of immediate turns can elapse before I/O runs under load.
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await waitForIO(1);
  expect(check()).toBe(true);
}

describe("bounded native folder check", () => {
  it("allows a responsive close after earlier folder work consumed the old total budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const root = new MemoryDirectory();
    const get = root.getDirectoryHandle.bind(root);
    vi.spyOn(root, "getDirectoryHandle").mockImplementationOnce(
      async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        return get(...args);
      },
    );
    const create = MemoryFile.prototype.createWritable;
    vi.spyOn(MemoryFile.prototype, "createWritable").mockImplementationOnce(
      async function (this: MemoryFile) {
        const stream = await create.call(this);
        const close = stream.close.bind(stream);
        stream.close = async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          await close();
        };
        return stream;
      },
    );
    const closes: StorageCheckProgress[] = [];
    let done = false;
    let failure: unknown;
    const operation = new LocalStore(
      root as unknown as FileSystemDirectoryHandle,
    )
      .preflight((stage, progress) => {
        if (stage === "Prüfdatei schließen" && progress.status === "finished")
          closes.push(progress);
      })
      .then(
        () => {
          done = true;
        },
        (error) => {
          done = true;
          failure = error;
        },
      );
    for (let i = 0; i < 40 && !done; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await setImmediate();
    }
    await operation;
    expect(failure).toBeUndefined();
    expect(closes[0]).toMatchObject({ stepMs: 5000 });
    expect(closes[0].totalMs).toBeGreaterThan(15_000);
    expect((await root.getDirectoryHandle("temp")).entries.size).toBe(0);
  });

  it("still bounds the whole check when many individually responsive operations add up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const get = MemoryDirectory.prototype.getDirectoryHandle;
    const calls = vi
      .spyOn(MemoryDirectory.prototype, "getDirectoryHandle")
      .mockImplementation(async function (this: MemoryDirectory, ...args) {
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        return get.call(this, ...args);
      });
    let done = false;
    let failure: unknown;
    const operation = new LocalStore(
      new MemoryDirectory() as unknown as FileSystemDirectoryHandle,
    )
      .preflight()
      .then(
        () => {
          done = true;
        },
        (error) => {
          done = true;
          failure = error;
        },
      );
    for (let i = 0; i < 95 && !done; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await setImmediate();
    }
    await operation;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /Gesamte Schreibprüfung.*90 Sekunden/,
    );
    const stoppedAt = calls.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    await setImmediate();
    expect(calls).toHaveBeenCalledTimes(stoppedAt);
  });

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

  it("accepts verified writes with a warning when cleanup times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const remove = vi
      .spyOn(MemoryDirectory.prototype, "removeEntry")
      .mockImplementation(() => new Promise(() => {}));
    const progress: string[] = [];
    const store = new LocalStore(
      new MemoryDirectory() as unknown as FileSystemDirectoryHandle,
    );
    let verifiedCloses = 0;
    const paths: (1 | 2 | undefined)[] = [];
    const operation = store.preflight((stage, detail) => {
      progress.push(stage);
      if (stage === "Prüfdatei schließen" && detail.status === "finished") {
        verifiedCloses++;
        paths.push(detail.check);
      }
    });
    await until(() => progress.at(-1) === "Prüfdateien entfernen");
    await vi.advanceTimersByTimeAsync(15_001);
    await operation;
    expect(verifiedCloses).toBe(2);
    expect(paths).toEqual([1, 2]);
    expect(store.cleanupError).toMatch(/StorageTimeoutError.*15 Sekunden/);
    expect(store.cleanupWarning).toContain("manuell aufräumen");
    // Subsequent checks still verify writes, but do not queue another hung
    // delete. The temporary media store shares the selected handle's state.
    const next = new LocalStore(store.root, "temp");
    await next.preflight();
    expect(next.cleanupError).toBe(store.cleanupError);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("does not require delete permission after both write/read probes succeed", async () => {
    const root = new MemoryDirectory();
    const original = await root.getDirectoryHandle("local", { create: true });
    vi.spyOn(MemoryDirectory.prototype, "removeEntry").mockRejectedValue(
      new DOMException("Deletion denied", "NotAllowedError"),
    );
    const store = new LocalStore(root as unknown as FileSystemDirectoryHandle);
    await store.preflight();
    expect(store.cleanupError).toContain("NotAllowedError: Deletion denied");
    expect(await root.getDirectoryHandle("local")).toBe(original);
  });

  it("preserves the write failure if best-effort cleanup also fails", async () => {
    vi.spyOn(MemoryFile.prototype, "createWritable").mockRejectedValueOnce(
      new DOMException("Writing denied", "NotAllowedError"),
    );
    vi.spyOn(MemoryDirectory.prototype, "removeEntry").mockRejectedValue(
      new Error("Cleanup failed too"),
    );
    const store = new LocalStore(
      new MemoryDirectory() as unknown as FileSystemDirectoryHandle,
    );
    await expect(store.preflight()).rejects.toThrow(
      /Schreibstream öffnen.*Writing denied/,
    );
    await until(() => Boolean(store.cleanupError));
    expect(store.cleanupError).toContain("Cleanup failed too");
  });

  it("rejects corrupt readback immediately even when cleanup never responds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(MemoryFile.prototype, "getFile").mockResolvedValueOnce(
      new File(["corrupt"], "probe.json"),
    );
    vi.spyOn(MemoryDirectory.prototype, "removeEntry").mockImplementation(
      () => new Promise(() => {}),
    );
    const store = new LocalStore(
      new MemoryDirectory() as unknown as FileSystemDirectoryHandle,
    );
    const progress: string[] = [];
    await expect(
      store.preflight((stage) => progress.push(stage)),
    ).rejects.toThrow(/Größe der zurückgelesenen Prüfdatei/);
    const afterFailure = progress.slice();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(store.cleanupError).toContain("StorageTimeoutError");
    expect(progress).toEqual(afterFailure);
  });
});
