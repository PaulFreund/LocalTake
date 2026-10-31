import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { RecordingSession } from "../apps/client/src/recorder/session.js";
import type {
  CaptureManager,
  CaptureSource,
} from "../apps/client/src/capture/manager.js";
import type { LocalStore } from "../apps/client/src/storage/store.js";
import type { SessionClock } from "../apps/client/src/core/clock.js";

beforeEach(() =>
  vi.stubGlobal(
    "MediaStreamTrackProcessor",
    class {
      readable = new ReadableStream();
    },
  ),
);

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

async function finalizationFixture(activate = true) {
  vi.useFakeTimers();
  let worker!: FakeWorker;
  class FakeWorker {
    onmessage?: (event: any) => void;
    terminated = false;
    messages: string[] = [];
    constructor() {
      worker = this;
    }
    postMessage(message: any) {
      this.messages.push(message.type);
      if (message.type === "init")
        queueMicrotask(() => this.emit({ type: "ready" }));
      if (message.type === "capture")
        this.emit({ type: "media-start", localStartMs: performance.now() });
    }
    emit(data: unknown) {
      this.onmessage?.({ data });
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
    label: "Slow camera",
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
  if (activate) await session.start();
  else await session.prepare();
  const status = (segments: number, state = "finalizing") => ({
    trackId: source.id,
    label: source.label,
    kind: "video",
    state,
    savedSeconds: segments * 2,
    capturedSeconds: 6,
    bytes: segments * 1000,
    segments,
  });
  return { worker, store, session, source, status };
}

it.each(["io", "segments"])(
  "allows slow but progressing %s to finish after the old 30-second cutoff",
  async (mode) => {
    const f = await finalizationFixture();
    const stopped = f.session.stop();
    for (let step = 1; step <= 3; step++) {
      await vi.advanceTimersByTimeAsync(20_000);
      if (mode === "io")
        f.worker.emit({
          type: "performance",
          metrics: {
            queuedBytes: 1000,
            peakQueuedBytes: 1000,
            savedBehindSeconds: 6,
            ioStage: `segment-${step}: Schließen`,
            ioStartedAtMs: performance.now(),
          },
        });
      else f.worker.emit({ type: "progress", status: f.status(step) });
      expect(f.worker.terminated).toBe(false);
      expect(f.store.finish).not.toHaveBeenCalled();
    }
    f.worker.emit({ type: "finished", status: f.status(3, "saved") });
    await stopped;
    expect(f.session.status.state).toBe("saved");
    expect(f.worker.terminated).toBe(true);
    expect(f.store.finish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("does not let unchanged worker heartbeats extend a stalled native write", async () => {
  const f = await finalizationFixture();
  const metrics = {
    queuedBytes: 1000,
    peakQueuedBytes: 1000,
    savedBehindSeconds: 6,
    ioStage: "original.mp4: Schließen",
    ioStartedAtMs: performance.now(),
  };
  f.worker.emit({ type: "performance", metrics });
  const stopped = f.session.stop();
  for (let step = 0; step < 3; step++) {
    await vi.advanceTimersByTimeAsync(10_000);
    f.worker.emit({ type: "performance", metrics: { ...metrics } });
    f.worker.emit({ type: "progress", status: f.status(0) });
  }
  await stopped;
  expect(f.worker.terminated).toBe(true);
  expect(f.session.status.state).toBe("partial");
  expect(f.session.status.sources[0].error).toContain(
    "Abschlusszeit überschritten",
  );
  const frozen = f.session.performance.get(f.source.id)!;
  expect(frozen.ioEndedAtMs).toBeDefined();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(f.session.performance.get(f.source.id)).toEqual(frozen);
  expect(f.store.finish).toHaveBeenCalledOnce();
});

it("prepares once and captures only after activation, without repeating storage initialization", async () => {
  const f = await finalizationFixture(false);
  expect(f.worker.messages).toEqual(["init"]);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.worker.messages).toEqual(["init"]);
  await f.session.start();
  expect(f.worker.messages).toEqual(["init", "capture"]);
  expect(f.store.initialize).toHaveBeenCalledOnce();
  const stopped = f.session.stop();
  f.worker.emit({
    type: "finished",
    status: { ...f.status(1, "saved"), capturedSeconds: 2 },
  });
  await stopped;
  expect(f.session.status.state).toBe("saved");
});
it("cancels a prepared recorder without ever attaching a capture stream", async () => {
  const f = await finalizationFixture(false);
  const stopped = f.session.stop();
  f.worker.emit({
    type: "finished",
    status: { ...f.status(0, "failed"), capturedSeconds: 0 },
  });
  await stopped;
  await expect(f.session.start()).rejects.toMatchObject({ name: "AbortError" });
  expect(f.worker.messages).not.toContain("capture");
  expect(f.worker.terminated).toBe(true);
  expect(f.session.status.state).toBe("partial");
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["late-start", "early-end"])(
  "persists a %s as partial even when the worker certifies its existing bytes",
  async (problem) => {
    const f = await finalizationFixture();
    const started = performance.now();
    await vi.advanceTimersByTimeAsync(4000);
    if (problem === "late-start")
      f.worker.emit({ type: "media-start", localStartMs: started + 3900 });
    const stopped = f.session.stop();
    f.worker.emit({
      type: "finished",
      status: {
        ...f.status(1, "saved"),
        savedSeconds: problem === "late-start" ? 0.033333 : 1,
        capturedSeconds: problem === "late-start" ? 0.033333 : 1,
      },
    });
    await stopped;
    expect(f.session.status.state).toBe("partial");
    expect(f.session.status.sources[0].error).toContain(
      "Aufnahme unvollständig",
    );
    expect(f.store.finish).toHaveBeenCalledWith(
      f.session.meta,
      expect.objectContaining({
        timing: expect.objectContaining({
          startMs: started,
          stopMs: started + 4000,
        }),
        sources: [expect.objectContaining({ state: "partial" })],
        issues: [expect.stringContaining("Aufnahme unvollständig")],
      }),
    );
  },
);

it("enforces the two-minute overall limit even if I/O keeps changing", async () => {
  const f = await finalizationFixture();
  const stopped = f.session.stop();
  for (let step = 1; step <= 5; step++) {
    await vi.advanceTimersByTimeAsync(20_000);
    f.worker.emit({
      type: "performance",
      metrics: {
        queuedBytes: 1000,
        peakQueuedBytes: 1000,
        savedBehindSeconds: 6,
        ioStage: `retry-${step}: Schließen`,
        ioStartedAtMs: performance.now(),
      },
    });
    expect(f.worker.terminated).toBe(false);
  }
  await vi.advanceTimersByTimeAsync(20_000);
  await stopped;
  expect(f.worker.terminated).toBe(true);
  expect(f.session.status.state).toBe("partial");
  f.worker.emit({ type: "finished", status: f.status(3, "saved") });
  expect(f.session.status.state).toBe("partial");
  expect(f.store.finish).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
