import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { LocalStore } from "../storage/store.js";
import { encodeWav } from "./wav.js";
import { preparedVideoEncoder, within } from "./encoder.js";
import type {
  RecordingMeta,
  SourceStatus,
  TrackMeta,
} from "../../../../packages/protocol/src/index.js";

export type Init = {
  type: "init";
  root: FileSystemDirectoryHandle;
  area?: "local" | "temp";
  recording: RecordingMeta;
  track: TrackMeta;
  mainTimeOrigin: number;
  readable?: ReadableStream<VideoFrame>;
  port?: MessagePort;
  audioAnchor?: { contextTime: number; localMs: number };
};
export type RecorderPerformance = {
  queuedBytes: number;
  peakQueuedBytes: number;
  savedBehindSeconds: number;
};
type WorkerHost = {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};
const host = self as unknown as WorkerHost;
let running = true,
  stopping = false,
  reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
let store: LocalStore,
  init: Init,
  status: SourceStatus,
  chain = Promise.resolve(),
  failure: string | null = null;
let sequence = 0,
  queuedBytes = 0,
  peakQueuedBytes = 0,
  savedThroughSeconds = 0,
  initialized: Promise<void> | null = null;
let connectStream: ((stream: ReadableStream<VideoFrame>) => void) | undefined;
const localNow = () =>
  performance.timeOrigin + performance.now() - init.mainTimeOrigin;
let lastPerformanceAt = -Infinity;
const notify = () => {
  host.postMessage({ type: "progress", status: { ...status } });
  if (performance.now() - lastPerformanceAt >= 10_000 || failure) {
    lastPerformanceAt = performance.now();
    const metrics: RecorderPerformance = {
      queuedBytes,
      peakQueuedBytes,
      savedBehindSeconds: Math.max(
        0,
        status.capturedSeconds - status.savedSeconds,
      ),
    };
    host.postMessage({ type: "performance", metrics });
  }
};
const diagnostic = (stage: string) => {
  if (import.meta.env.DEV)
    host.postMessage({ type: "diagnostic", stage, status: { ...status } });
};
const fail = (error: unknown) => {
  if (!failure) {
    failure = (error instanceof Error ? error.message : String(error)).slice(
      0,
      300,
    );
    status.error = failure;
    status.state = "failed";
    notify();
  }
  running = false;
  void reader?.cancel().catch(() => undefined);
};
function enqueue(bytes: number, fn: () => Promise<void>) {
  queuedBytes += bytes;
  peakQueuedBytes = Math.max(peakQueuedBytes, queuedBytes);
  if (queuedBytes > 64 * 1024 * 1024) {
    fail(new Error("Schreibwarteschlange überschreitet 64 MiB."));
    return;
  }
  chain = chain
    .then(async () => {
      try {
        await fn();
      } finally {
        queuedBytes -= bytes;
      }
    })
    .catch(fail);
}
function ensureInitialized(localStartMs: number) {
  if (!initialized) {
    init.track.localStartMs = localStartMs;
    initialized = store
      .initializeTrack(init.recording, init.track)
      .then(() => diagnostic("track-initialized"));
  }
  return initialized;
}
async function committed(
  bytes: ArrayBuffer,
  startUs: number,
  durationUs: number,
  extra: {
    frameCount?: number;
    firstFrameIsKey?: boolean;
    sampleStart?: number;
    sampleCount?: number;
  },
) {
  const extension = init.track.kind === "audio" ? "wav" : "mp4";
  const start = Math.max(0, Math.round(startUs)),
    duration = Math.max(1, Math.round(durationUs));
  const fileName = `${String(sequence).padStart(6, "0")}_${String(start).padStart(12, "0")}us.${extension}`;
  const receipt = await store.commit(
    init.recording,
    init.track,
    {
      sequence,
      fileName,
      mediaStartUs: start,
      mediaDurationUs: duration,
      ...extra,
    },
    bytes,
  );
  sequence++;
  status.segments++;
  status.bytes += receipt.byteLength;
  status.savedSeconds += duration / 1e6;
  savedThroughSeconds = (start + duration) / 1e6;
  notify();
}
async function finished() {
  await chain;
  status.state = failure
    ? status.segments
      ? "partial"
      : "failed"
    : status.segments
      ? "saved"
      : "failed";
  if (!status.segments && !status.error)
    status.error = "Keine Medien empfangen.";
  host.postMessage({ type: "finished", status });
}
async function video() {
  const meta = init.track,
    fps = meta.frameRate || 30;
  const config: VideoEncoderConfig = {
    codec:
      meta.width! > 1920 || meta.height! > 1080 ? "avc1.420033" : "avc1.42002a",
    width: meta.width!,
    height: meta.height!,
    bitrate: meta.bitrate!,
    framerate: fps,
    latencyMode: "realtime",
    hardwareAcceleration: "prefer-hardware",
    avc: { format: "avc" },
  };
  let target: BufferTarget | null = null,
    output: Output | null = null,
    source: EncodedVideoPacketSource | null = null;
  let decoder: VideoDecoderConfig | undefined,
    segmentStart = 0,
    segmentEnd = 0,
    frameCount = 0;
  let pending: EncodedPacket | null = null;
  async function closeSegment() {
    if (!output || !source || !target || !frameCount) return;
    source.close();
    diagnostic("mux-finalizing");
    await output.finalize();
    diagnostic("mux-finalized");
    if (!target.buffer)
      throw new Error("MP4-Finalisierung lieferte keine Datei.");
    await committed(
      target.buffer,
      segmentStart * 1e6,
      (segmentEnd - segmentStart) * 1e6,
      { frameCount, firstFrameIsKey: true },
    );
    output = null;
    source = null;
    target = null;
    frameCount = 0;
  }
  async function writePacket(packet: EncodedPacket) {
    await initialized;
    if (
      packet.type === "key" &&
      frameCount &&
      packet.timestamp - segmentStart >= 1.9
    )
      await closeSegment();
    if (!output) {
      if (packet.type !== "key" || !decoder)
        throw new Error(
          "Segment beginnt nicht mit einem dekodierbaren Keyframe.",
        );
      segmentStart = packet.timestamp;
      target = new BufferTarget();
      source = new EncodedVideoPacketSource("avc");
      output = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target,
      });
      // Camera timestamps vary. frameRate would snap them to a grid and can
      // collapse two distinct captured frames onto the same MP4 timestamp.
      output.addVideoTrack(source);
      await output.start();
    }
    await source!.add(
      packet.clone({ timestamp: packet.timestamp - segmentStart }),
      { decoderConfig: decoder },
    );
    if (!frameCount) diagnostic("mux-first-packet");
    frameCount++;
    segmentEnd = packet.timestamp + packet.duration;
    if (segmentEnd - segmentStart > 4.1)
      throw new Error("Keyframe-/Segmentfrist überschritten.");
  }
  const prepared = await preparedVideoEncoder(
    config,
    (chunk, metadata) => {
      if (metadata?.decoderConfig) decoder = metadata.decoderConfig;
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      enqueue(chunk.byteLength, async () => {
        if (pending) {
          const duration = packet.timestamp - pending.timestamp;
          if (duration <= 0)
            throw new Error(
              `Nicht steigende Encoderzeit: ${pending.timestamp}s -> ${packet.timestamp}s.`,
            );
          await writePacket(pending.clone({ duration }));
        }
        pending = packet;
      });
    },
    fail,
    10_000,
    meta.settings.encoderAccelerationPreference === "prefer-software"
      ? "prefer-software"
      : "prefer-hardware",
  );
  const encoder = prepared.encoder;
  diagnostic("codec-ready");
  decoder = prepared.decoderConfig;
  status.warning = prepared.warning;
  init.track.settings.encoderAccelerationPreference =
    prepared.hardwareAcceleration;
  // Do not attach a camera while this worker is loading/initializing its codec.
  // Otherwise a stale buffered first frame creates an artificial start gap.
  const readable =
    init.readable ??
    (await new Promise<ReadableStream<VideoFrame>>((resolve) => {
      connectStream = resolve;
      host.postMessage({ type: "capture-ready" });
    }));
  reader = readable.getReader();
  diagnostic("reader-ready");
  let origin: number | null = null,
    nextKeyframe = 0,
    lastTimestamp: number | null = null,
    gaps = 0;
  try {
    while (running) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      try {
        if (
          frame.displayWidth !== meta.width ||
          frame.displayHeight !== meta.height
        )
          throw new Error(
            "Kameraformat hat sich während der Aufnahme geändert.",
          );
        if (origin === null) {
          diagnostic("first-frame");
          origin = frame.timestamp;
          void ensureInitialized(localNow()).catch(fail);
        }
        const timestamp = frame.timestamp - origin;
        // Some capture sources repeat their cached initial frame with the same timestamp.
        // A zero-duration duplicate is not a new media instant and must not enter the encoder twice.
        if (timestamp === lastTimestamp) continue;
        if (lastTimestamp !== null && timestamp < lastTimestamp)
          throw new Error("Die Zeitbasis der Kamera ist zurückgesprungen.");
        if (
          lastTimestamp !== null &&
          timestamp - lastTimestamp > Math.max(100_000, 2.5e6 / fps)
        )
          gaps++;
        lastTimestamp = timestamp;
        if (encoder.encodeQueueSize > Math.max(8, fps))
          throw new Error(
            "Videoencoder kann die Aufnahmequalität nicht halten.",
          );
        const normalized = new VideoFrame(frame, {
          timestamp,
          duration: Math.round(1e6 / fps),
        });
        const keyFrame = timestamp >= nextKeyframe;
        if (keyFrame) nextKeyframe = timestamp + 2_000_000;
        encoder.encode(normalized, { keyFrame });
        normalized.close();
        status.capturedSeconds = (timestamp + 1e6 / fps) / 1e6;
        if (status.capturedSeconds - savedThroughSeconds > 8)
          throw new Error(
            "Video kann seit acht Sekunden nicht gesichert werden. Speicherzugriff und Encoderlast prüfen.",
          );
      } finally {
        frame.close();
      }
    }
    if (!stopping && !failure)
      fail(new Error("Kamera hat keine weiteren Frames geliefert."));
  } catch (error) {
    fail(error);
  } finally {
    status.state = "finalizing";
    diagnostic("encoder-finalizing");
    notify();
    if (encoder.state === "configured")
      await within(
        encoder.flush(),
        3000,
        "Videoencoder antwortet beim Abschluss nicht. Bereits gesicherte Segmente bleiben erhalten.",
      ).catch(fail);
    if (encoder.state !== "closed") encoder.close();
    diagnostic("encoder-closed");
    await chain;
    diagnostic("writes-drained");
    if (pending)
      await writePacket(
        (pending as EncodedPacket).clone({ duration: 1 / fps }),
      ).catch(fail);
    await closeSegment().catch(fail);
    if (gaps) {
      await store
        .event(init.recording, {
          type: "video-gaps",
          localMs: localNow(),
          trackId: meta.trackId,
          gaps,
        })
        .catch(fail);
      status.warning =
        `${status.warning ? `${status.warning} ` : ""}${gaps} auffällige Frame-Zeitlücken; Originale und Zeitstempel erhalten.`.slice(
          0,
          300,
        );
    }
    await finished();
  }
}
function audio() {
  const port = init.port!;
  let firstFrame: number | null = null,
    expectedSample = 0,
    gaps = 0,
    overlaps = 0;
  port.onmessage = ({ data }) => {
    if (data.type === "error") {
      fail(new Error(data.message));
      void finished();
      return;
    }
    if (data.type === "end") {
      overlaps += data.overlapFrames || 0;
      const clockCorrections = data.clockCorrections || 0;
      const clockLagFrames = data.clockLagFrames || 0;
      if (gaps || overlaps || clockLagFrames) {
        const warnings: string[] = [];
        if (gaps || overlaps)
          warnings.push(
            `${gaps} Audio-Zeitlücken, ${overlaps} Samples bei überlappenden Zeitstempeln übersprungen; Zeitstempel erhalten.`,
          );
        if (clockLagFrames)
          warnings.push(
            `Audiozeitbasis beim Stopp um ${clockLagFrames} Samples verzögert; Synchronisation prüfen.`,
          );
        status.warning = warnings.join(" ");
      }
      if (gaps || overlaps || clockCorrections) {
        enqueue(0, () =>
          store.event(init.recording, {
            type: "audio-timing",
            localMs: localNow(),
            trackId: init.track.trackId,
            gaps,
            overlaps,
            clockCorrections,
            maxClockLagFrames: data.maxClockLagFrames || 0,
            unrecoveredClockLagFrames: clockLagFrames,
            firstCorrectedSample:
              firstFrame !== null && data.firstClockCorrectionFrame != null
                ? data.firstClockCorrectionFrame - firstFrame
                : undefined,
            lastCorrectedSample:
              firstFrame !== null && data.lastClockCorrectionFrame != null
                ? data.lastClockCorrectionFrame - firstFrame
                : undefined,
          }),
        );
      }
      status.state = "finalizing";
      notify();
      void finished();
      return;
    }
    if (data.type !== "pcm") return;
    if (failure) {
      port.postMessage({ type: "recycle", buffer: data.buffer }, [data.buffer]);
      return;
    }
    firstFrame ??= data.firstFrame;
    const rawStart = data.firstFrame - firstFrame!;
    const skip = Math.max(0, expectedSample - rawStart);
    overlaps += Math.min(skip, data.frames);
    if (skip >= data.frames) {
      port.postMessage({ type: "recycle", buffer: data.buffer }, [data.buffer]);
      return;
    }
    const sampleStart = rawStart + skip;
    const frames = data.frames - skip;
    if (sampleStart > expectedSample) gaps++;
    expectedSample = sampleStart + frames;
    const localStartMs =
      init.audioAnchor!.localMs +
      (firstFrame! / data.sampleRate - init.audioAnchor!.contextTime) * 1000;
    status.capturedSeconds = (sampleStart + frames) / data.sampleRate;
    enqueue(data.buffer.byteLength, async () => {
      try {
        await ensureInitialized(localStartMs);
        const pcm = new Float32Array(
          data.buffer,
          skip * data.channels * 4,
          frames * data.channels,
        );
        await committed(
          encodeWav(pcm, data.sampleRate, data.channels),
          (sampleStart / data.sampleRate) * 1e6,
          (frames / data.sampleRate) * 1e6,
          { sampleStart, sampleCount: frames },
        );
      } finally {
        port.postMessage({ type: "recycle", buffer: data.buffer }, [
          data.buffer,
        ]);
      }
    });
    if (status.capturedSeconds - savedThroughSeconds > 8)
      fail(
        new Error(
          "Audio kann seit acht Sekunden nicht gesichert werden. Speicherzugriff prüfen.",
        ),
      );
  };
  port.start();
  host.postMessage({ type: "ready" });
}
host.onmessage = ({
  data,
}: MessageEvent<
  | Init
  | { type: "stop" }
  | { type: "capture"; readable: ReadableStream<VideoFrame> }
>) => {
  if (data.type === "capture") {
    connectStream?.(data.readable);
    connectStream = undefined;
    return;
  }
  if (data.type === "stop") {
    diagnostic("stop-received");
    stopping = true;
    running = false;
    void reader?.cancel().catch(() => undefined);
    connectStream?.(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    );
    return;
  }
  init = data;
  store = new LocalStore(init.root, init.area);
  status = {
    trackId: init.track.trackId,
    label: init.track.label,
    kind: init.track.kind,
    state: "recording",
    savedSeconds: 0,
    capturedSeconds: 0,
    bytes: 0,
    segments: 0,
  };
  notify();
  if (init.track.kind === "audio") audio();
  else
    void video().catch(async (error) => {
      fail(error);
      await finished();
    });
};
