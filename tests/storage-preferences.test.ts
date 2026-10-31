import { afterEach, describe, expect, it, vi } from "vitest";
import { savedStorage } from "../apps/client/src/storage/selection.js";
import { MemoryDirectory } from "./helpers/memory-files.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("optional remembered storage", () => {
  it("bounds a stalled open and closes a database that opens after timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const request = {} as IDBOpenDBRequest;
    vi.stubGlobal("indexedDB", { open: () => request });
    const operation = savedStorage();
    const failure = expect(operation).rejects.toThrow(
      /Gespeicherte Ordnerwahl öffnen.*3 Sekunden/,
    );
    await vi.advanceTimersByTimeAsync(3001);
    await failure;
    const close = vi.fn();
    Object.assign(request, { result: { close } });
    request.onsuccess!.call(request, new Event("success"));
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "aborts a stalled preference transaction (write=%s)",
    async (write) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const dataRequest = {};
      const abort = vi.fn();
      const transaction = {
        abort,
        objectStore: () => ({ get: () => dataRequest, put: () => dataRequest }),
      };
      const close = vi.fn();
      const request = {
        result: { transaction: () => transaction, close },
      } as unknown as IDBOpenDBRequest;
      vi.stubGlobal("indexedDB", {
        open: () => {
          queueMicrotask(() =>
            request.onsuccess!.call(request, new Event("success")),
          );
          return request;
        },
      });
      const activated = vi.fn();
      const selection = {
        kind: "folder" as const,
        root: new MemoryDirectory() as unknown as FileSystemDirectoryHandle,
      };
      const operation = savedStorage(write ? selection : undefined).then(
        activated,
      );
      const failure = expect(operation).rejects.toThrow(/3 Sekunden/);
      await vi.advanceTimersByTimeAsync(3001);
      await failure;
      expect(abort).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(activated).not.toHaveBeenCalled();
    },
  );

  it("reports a blocked database without waiting indefinitely", async () => {
    const request = {} as IDBOpenDBRequest;
    vi.stubGlobal("indexedDB", {
      open: () => {
        queueMicrotask(() =>
          request.onblocked!.call(
            request,
            new Event("blocked") as IDBVersionChangeEvent,
          ),
        );
        return request;
      },
    });
    await expect(savedStorage()).rejects.toThrow(/anderer Tab blockiert/);
  });
});
