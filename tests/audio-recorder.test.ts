import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { exportRecording } from "../apps/client/src/export/exporter.js";
import { LocalStore } from "../apps/client/src/storage/store.js";
import { MemoryDirectory, MemoryFile } from "./helpers/memory-files.js";
import type {
  RecordingMeta,
  SourceStatus,
  TrackMeta,
} from "../packages/protocol/src/index.js";

afterEach(() => vi.unstubAllGlobals());

async function record(clocks: number[]) {
  vi.resetModules();
  const root = new MemoryDirectory();
  const handle = root as unknown as FileSystemDirectoryHandle;
  const store = new LocalStore(handle);
  const trackId = crypto.randomUUID();
  const recording: RecordingMeta = {
    formatVersion: 1,
    recordingId: crypto.randomUUID(),
    participantId: crypto.randomUUID(),
    participantName: "Test",
    createdAt: new Date().toISOString(),
    appVersion: "test",
    trackIds: [trackId],
  };
  const track: TrackMeta = {
    formatVersion: 1,
    trackId,
    epochId: crypto.randomUUID(),
    label: "Mic",
    kind: "audio",
    codec: "pcm-f32",
    sampleRate: 48_000,
    channels: 2,
    localStartMs: 1000,
    clock: {
      id: crypto.randomUUID(),
      epoch: "test",
      localMs: 1000,
      offsetMs: 0,
      drift: 1,
      uncertaintyMs: 2,
      samples: 1,
    },
    settings: {},
  };
  await store.initialize(recording);
  let resolveFinished: (status: SourceStatus) => void;
  const finished = new Promise<SourceStatus>((resolve) => {
    resolveFinished = resolve;
  });
  const host = {
    onmessage: null as any,
    postMessage(message: any) {
      if (message.type === "finished") resolveFinished(message.status);
    },
  };
  vi.stubGlobal("self", host);
  await import("../apps/client/src/recorder/worker.js");
  let Processor: any;
  const scope = {
    sampleRate: 48_000,
    currentFrame: clocks[0],
    AudioWorkletProcessor: class {
      port: any = {};
    },
    registerProcessor(_: string, ctor: any) {
      Processor = ctor;
    },
  };
  runInNewContext(
    readFileSync("apps/client/src/recorder/pcm-worklet.js", "utf8"),
    scope,
  );
  // Exercise real transferred buffers, including the worker's recycle path.
  const send = (port: any, message: any, transfer: Transferable[] = []) =>
    port.onmessage({ data: structuredClone(message, { transfer }) });
  const workletPort: any = {
    start() {},
    postMessage: (message: any, transfer: Transferable[]) =>
      send(workerPort, message, transfer),
  };
  const workerPort: any = {
    start() {},
    postMessage: (message: any, transfer: Transferable[]) =>
      send(workletPort, message, transfer),
  };
  host.onmessage({
    data: {
      type: "init",
      root: handle,
      recording,
      track,
      mainTimeOrigin: performance.timeOrigin,
      audioAnchor: { contextTime: clocks[0] / 48_000, localMs: 1000 },
      port: workerPort,
    },
  });
  const processor = new Processor({ processorOptions: { channels: 2 } });
  processor.port.onmessage({ data: { type: "connect", port: workletPort } });
  const expected: number[] = [];
  for (const [index, clock] of clocks.entries()) {
    scope.currentFrame = clock;
    const left = Float32Array.from(
      { length: 128 },
      (_, frame) => (index * 128 + frame) / 1024 - 0.5,
    );
    const right = Float32Array.from(left, (sample) => -sample);
    processor.process([[left, right]], [[new Float32Array(128)]]);
    for (let frame = 0; frame < 128; frame++)
      expected.push(left[frame], right[frame]);
  }
  processor.port.onmessage({ data: { type: "stop" } });
  const status = await finished;
  await store.finish(recording, {
    formatVersion: 1,
    recordingId: recording.recordingId,
    participantId: recording.participantId,
    finishedAt: new Date().toISOString(),
    sources: [status],
    issues: [],
  });
  const inventory = await store.scan(
    recording.recordingId,
    recording.participantId,
  );
  const participant = await store.participant(
    recording.recordingId,
    recording.participantId,
  );
  const events: any[] = [];
  for await (const file of (
    await participant.getDirectoryHandle("events")
  ).values())
    if (file instanceof MemoryFile)
      events.push(JSON.parse(await (await file.getFile()).text()));
  const folder = await exportRecording(
    store,
    inventory,
    handle,
    () => {},
    "output",
  );
  const wavs: File[] = [];
  for await (const entry of folder.values())
    if (entry.kind === "file" && entry.name.endsWith(".wav"))
      wavs.push(await entry.getFile());
  wavs.sort((a, b) => a.name.localeCompare(b.name));
  const exportedPcm: number[] = [];
  for (const wav of wavs)
    exportedPcm.push(...new Float32Array(await wav.arrayBuffer(), 56));
  return { status, inventory, events, wavs, exportedPcm, expected };
}

it("writes and exports all PCM across a stale clock tick without an audio gap warning", async () => {
  const result = await record([480_000, 480_128, 480_128, 480_384]);
  expect(result.status.state).toBe("saved");
  expect(result.status.warning).toBeUndefined();
  expect(result.inventory.complete).toBe(true);
  expect(result.inventory.warnings ?? []).toEqual([]);
  expect(result.inventory.tracks[0].localStartMs).toBe(1000);
  expect(
    result.inventory.segments.map((s) => [s.sampleStart, s.sampleCount]),
  ).toEqual([[0, 512]]);
  expect(result.wavs).toHaveLength(1);
  expect(result.exportedPcm).toEqual(result.expected);
  expect(result.events).toEqual([
    expect.objectContaining({
      type: "audio-timing",
      gaps: 0,
      overlaps: 0,
      clockCorrections: 1,
      maxClockLagFrames: 128,
      unrecoveredClockLagFrames: 0,
      firstCorrectedSample: 256,
      lastCorrectedSample: 256,
    }),
  ]);
});

it("preserves a real forward gap in receipts, warning, and separate exported WAVs", async () => {
  const result = await record([480_000, 480_128, 480_768]);
  expect(result.status.state).toBe("saved");
  expect(result.status.warning).toContain("1 Audio-Zeitlücken");
  expect(
    result.inventory.segments.map((s) => [s.sampleStart, s.sampleCount]),
  ).toEqual([
    [0, 256],
    [768, 128],
  ]);
  expect(result.wavs).toHaveLength(2);
  expect(result.exportedPcm).toEqual(result.expected);
  expect(result.events[0]).toMatchObject({
    gaps: 1,
    overlaps: 0,
    clockCorrections: 0,
  });
});

it("warns about synchronization if a delayed clock has not recovered when stopped", async () => {
  const result = await record([480_000, 480_000]);
  expect(result.exportedPcm).toEqual(result.expected);
  expect(result.status.warning).toContain("um 128 Samples verzögert");
  expect(result.status.warning).not.toContain("Audio-Zeitlücken");
  expect(result.events[0]).toMatchObject({
    gaps: 0,
    overlaps: 0,
    clockCorrections: 1,
    unrecoveredClockLagFrames: 128,
  });
});
