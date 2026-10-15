import { afterEach, expect, it, vi } from "vitest";
import { RecordingSession } from "../apps/client/src/recorder/session.js";
import type {
  CaptureManager,
  CaptureSource,
} from "../apps/client/src/capture/manager.js";
import type { LocalStore } from "../apps/client/src/storage/store.js";
import type { SessionClock } from "../apps/client/src/core/clock.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("releases every worker and the recording lock when a later source cannot initialize", async () => {
  const workers: FakeWorker[] = [];
  let locked = false;
  class FakeWorker {
    onmessage?: (event: any) => void;
    track: any;
    terminated = false;
    stopped = false;
    constructor() {
      workers.push(this);
    }
    postMessage(message: any) {
      if (message.type === "init") {
        if (workers.length === 2)
          throw new DOMException("Handle cannot be cloned", "DataCloneError");
        this.track = message.track;
      }
      if (message.type === "stop") {
        this.stopped = true;
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              type: "finished",
              status: {
                trackId: this.track.trackId,
                label: this.track.label,
                kind: "video",
                state: "failed",
                savedSeconds: 0,
                capturedSeconds: 0,
                bytes: 0,
                segments: 0,
              },
            },
          }),
        );
      }
    }
    terminate() {
      this.terminated = true;
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("navigator", {
    locks: {
      async request(
        _name: string,
        _options: unknown,
        callback: (lock: object) => Promise<void>,
      ) {
        locked = true;
        try {
          await callback({});
        } finally {
          locked = false;
        }
      },
    },
  });
  const store = {
    root: {},
    initialize: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
  } as unknown as LocalStore;
  const capture = Object.assign(new EventTarget(), {
    audioContext: async () => ({ audioWorklet: { addModule: async () => {} } }),
  }) as unknown as CaptureManager;
  const clock = { snapshot: () => ({}) } as unknown as SessionClock;
  const sources = [0, 1].map((index) => ({
    id: crypto.randomUUID(),
    label: `Camera ${index}`,
    kind: "video",
    track: {
      readyState: "live",
      getSettings: () => ({ width: 640, height: 360, frameRate: 30 }),
    },
  })) as unknown as CaptureSource[];
  const session = new RecordingSession(
    store,
    capture,
    clock,
    sources,
    crypto.randomUUID(),
    crypto.randomUUID(),
    "Test",
    "720",
  );
  await expect(session.start()).rejects.toThrow("Handle cannot be cloned");
  expect(workers).toHaveLength(2);
  expect(workers[0].stopped).toBe(true);
  expect(workers.every((worker) => worker.terminated)).toBe(true);
  expect(locked).toBe(false);
  expect(session.status.state).toBe("partial");
  expect(store.finish).toHaveBeenCalledOnce();
});

it("terminates a timed-out recorder before scanning and ignores late success messages", async () => {
  vi.useFakeTimers();
  let worker: FakeWorker;
  class FakeWorker {
    onmessage?: (event: any) => void;
    terminated = false;
    constructor() {
      worker = this;
    }
    postMessage(message: any) {
      if (message.type === "init")
        queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
    }
    terminate() {
      this.terminated = true;
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _: string,
        _options: unknown,
        callback: (lock: object) => Promise<void>,
      ) => callback({}),
    },
  });
  const store = {
    root: {},
    initialize: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
  } as unknown as LocalStore;
  const capture = Object.assign(new EventTarget(), {
    audioContext: async () => ({ audioWorklet: { addModule: async () => {} } }),
  }) as unknown as CaptureManager;
  const source = {
    id: crypto.randomUUID(),
    label: "Camera",
    kind: "video",
    track: {
      readyState: "live",
      getSettings: () => ({ width: 640, height: 360 }),
    },
  } as unknown as CaptureSource;
  const session = new RecordingSession(
    store,
    capture,
    { snapshot: () => ({}) } as unknown as SessionClock,
    [source],
    crypto.randomUUID(),
    crypto.randomUUID(),
    "Test",
    "720",
  );
  await session.start();
  const stopped = session.stop();
  await vi.advanceTimersByTimeAsync(30_000);
  await stopped;
  expect(worker!.terminated).toBe(true);
  expect(session.status.state).toBe("partial");
  worker!.onmessage?.({
    data: {
      type: "finished",
      status: { trackId: source.id, state: "saved", bytes: 1000 },
    },
  });
  expect(session.status.sources[0].state).toBe("partial");
  expect(session.status.sources[0].error).toContain(
    "Abschlusszeit überschritten",
  );
  expect(store.finish).toHaveBeenCalledOnce();
});

it("waits for pending session metadata before writing the completion used by automatic uploads", async () => {
  let release: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = {
    event: vi.fn(() => pending),
    finish: vi.fn(async () => {}),
  } as unknown as LocalStore;
  const session = new RecordingSession(
    store,
    new EventTarget() as CaptureManager,
    { snapshot: () => ({}) } as unknown as SessionClock,
    [],
    crypto.randomUUID(),
    crypto.randomUUID(),
    "Test",
    "720",
  );
  const event = session.event("mic-mute", { muted: true });
  const stopped = session.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(store.finish).not.toHaveBeenCalled();
  release!();
  await Promise.all([event, stopped]);
  expect(store.finish).toHaveBeenCalledOnce();
  await session.event("camera-mute", { muted: true });
  expect(store.event).toHaveBeenCalledOnce();
});
