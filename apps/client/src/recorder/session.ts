import pcmWorkletUrl from "./pcm-worklet.js?url";
import {
  profiles,
  type CaptureManager,
  type CaptureSource,
  type Quality,
} from "../capture/manager.js";
import { LocalStore, holdOriginals } from "../storage/store.js";
import { SessionClock } from "../core/clock.js";
import type {
  RecordingMeta,
  RecordingStatus,
  SourceStatus,
  TrackMeta,
} from "../../../../packages/protocol/src/index.js";
import type { Init, RecorderPerformance } from "./worker.js";

type Runner = {
  sourceId: string;
  worker: Worker;
  stop: (reason?: string) => void;
  finished: Promise<SourceStatus>;
  ready: Promise<void>;
  cleanup: () => void;
};
export class RecordingSession extends EventTarget {
  status: RecordingStatus;
  meta: RecordingMeta;
  readonly performance = new Map<string, RecorderPerformance>();
  private runners: Runner[] = [];
  private releaseLock: (() => void) | null = null;
  private releaseOriginals: (() => void) | null = null;
  private stopping: Promise<void> | null = null;
  private issues: string[] = [];
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private startedAtMs = performance.now();
  private lastClockAt = 0;
  private reportedErrors = new Set<string>();
  private metadataJobs = new Set<Promise<unknown>>();
  get elapsedSeconds() {
    return (performance.now() - this.startedAtMs) / 1000;
  }
  private ended = (event: Event) => {
    const source = (event as CustomEvent<CaptureSource>).detail;
    if (this.meta.trackIds.includes(source.id)) {
      void this.event("device-ended", { trackId: source.id });
      this.runners
        .find((r) => r.sourceId === source.id)
        ?.stop("Gerät wurde getrennt. Gesicherte Segmente bleiben erhalten.");
    }
  };
  constructor(
    readonly store: LocalStore,
    readonly capture: CaptureManager,
    readonly clock: SessionClock,
    readonly sources: CaptureSource[],
    recordingId: string,
    participantId: string,
    participantName: string,
    readonly quality: Quality,
    context?: Pick<
      RecordingMeta,
      "roomId" | "sessionName" | "sessionStartedAt" | "purpose"
    >,
  ) {
    super();
    this.meta = {
      formatVersion: 1,
      recordingId,
      participantId,
      participantName,
      createdAt: new Date().toISOString(),
      appVersion: "0.1.0",
      trackIds: sources.map((s) => s.id),
      ...context,
    };
    this.status = { recordingId, state: "recording", sources: [] };
  }
  private publish() {
    this.dispatchEvent(new Event("change"));
  }
  async start() {
    this.startedAtMs = performance.now();
    if (!this.sources.length)
      throw new Error("Keine Aufnahmequellen ausgewählt.");
    await new Promise<void>((resolve, reject) => {
      void navigator.locks
        .request(
          `localtake-recorder-${this.meta.participantId}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              reject(
                new Error(
                  "Ein anderer Tab zeichnet bereits für diesen Teilnehmer auf.",
                ),
              );
              return;
            }
            await new Promise<void>((release) => {
              this.releaseLock = release;
              resolve();
            });
          },
        )
        .catch(reject);
    });
    try {
      this.releaseOriginals = await holdOriginals(this.meta);
      await this.store.initialize(this.meta);
      const context = await this.capture.audioContext();
      await context.audioWorklet.addModule(pcmWorkletUrl);
      if (this.sources.some((source) => source.kind === "audio"))
        await prepareAudioClock(context);
      for (const source of this.sources) {
        if (source.track.readyState !== "live")
          throw new Error(`${source.label}: Gerät nicht verfügbar.`);
        this.runners.push(this.createRunner(source, context));
      }
      this.capture.addEventListener("ended", this.ended);
      await Promise.all(this.runners.map((r) => r.ready));
      const failed = this.status.sources.find((s) => s.error);
      if (failed) throw new Error(`${failed.label}: ${failed.error}`);
      this.statusTimer = setInterval(() => {
        this.publish();
        if (performance.now() - this.lastClockAt >= 10_000) {
          this.lastClockAt = performance.now();
          void this.writeMetadata(
            this.store.clock(this.meta, this.clock.snapshot()),
          );
        }
      }, 500);
      this.publish();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  private createRunner(source: CaptureSource, context: AudioContext): Runner {
    const settings = source.track.getSettings();
    const channels =
      source.kind === "audio"
        ? Math.max(1, Math.min(32, settings.channelCount || 1))
        : undefined;
    const track: TrackMeta = {
      formatVersion: 1,
      trackId: source.id,
      epochId: crypto.randomUUID(),
      label: source.label,
      kind: source.kind,
      codec: source.kind === "audio" ? "pcm-f32" : "avc",
      width: settings.width,
      height: settings.height,
      frameRate:
        settings.frameRate || (source.kind === "audio" ? undefined : 30),
      bitrate:
        source.kind === "audio" ? undefined : profiles[this.quality].bitrate,
      sampleRate: source.kind === "audio" ? context.sampleRate : undefined,
      channels,
      localStartMs: performance.now(),
      clock: this.clock.snapshot(),
      settings: {
        ...Object.fromEntries(
          Object.entries(settings).filter(([, value]) =>
            ["string", "number", "boolean"].includes(typeof value),
          ),
        ),
        synthetic: Boolean(source.synthetic),
        encoderAccelerationPreference:
          source.encoderPreference || "prefer-hardware",
        timing:
          source.kind === "audio"
            ? "AudioContext clock with monotonic render-frame correction; input hardware latency uncalibrated"
            : "first-frame arrival estimate; capture latency uncalibrated",
      },
    };
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    let node: AudioWorkletNode | undefined,
      input: MediaStreamAudioSourceNode | undefined,
      silent: GainNode | undefined,
      channel: MessageChannel | undefined,
      processor: MediaStreamTrackProcessor | undefined;
    let resolveFinished: (status: SourceStatus) => void;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolveReady: () => void;
    let rejectReady: (error: Error) => void;
    let ready = false;
    const prepared = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void prepared.catch(() => undefined);
    readyTimeout = setTimeout(
      () =>
        rejectReady(
          new Error(
            `${source.label}: Aufnahmequelle antwortet beim Start nicht.`,
          ),
        ),
      35_000,
    );
    const markReady = () => {
      ready = true;
      clearTimeout(readyTimeout);
      resolveReady();
    };
    let done = false,
      stopRequested = false,
      forcedError: string | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(readyTimeout);
      input?.disconnect();
      node?.disconnect();
      silent?.disconnect();
      node?.port.close();
      channel?.port1.close();
      channel?.port2.close();
      processor = undefined;
      worker.terminate();
    };
    const finished = new Promise<SourceStatus>((resolve) => {
      resolveFinished = resolve;
    });
    const update = (status: SourceStatus) => {
      const index = this.status.sources.findIndex(
        (s) => s.trackId === status.trackId,
      );
      if (index < 0) this.status.sources.push(status);
      else this.status.sources[index] = status;
      if (status.error && !this.reportedErrors.has(status.trackId)) {
        this.reportedErrors.add(status.trackId);
        this.dispatchEvent(
          new CustomEvent("error", {
            detail: `${status.label}: ${status.error}`,
          }),
        );
      }
      this.publish();
    };
    worker.onmessage = ({
      data,
    }: MessageEvent<{
      type: string;
      status: SourceStatus;
      metrics?: RecorderPerformance;
    }>) => {
      if (done) return;
      if (data.type === "performance") {
        if (data.metrics) this.performance.set(source.id, data.metrics);
        return;
      }
      if (data.type === "ready") {
        markReady();
        return;
      }
      if (data.type === "capture-ready") {
        if (stopRequested) {
          worker.postMessage({ type: "stop" });
          return;
        }
        try {
          processor = new MediaStreamTrackProcessor({
            track: source.track,
            maxBufferSize: 3,
          });
          worker.postMessage(
            { type: "capture", readable: processor.readable },
            [processor.readable],
          );
          markReady();
        } catch (error) {
          rejectReady(
            error instanceof Error ? error : new Error(String(error)),
          );
          forcedError = String(error);
          worker.postMessage({ type: "stop" });
        }
        return;
      }
      if (forcedError) {
        data.status.error = forcedError;
        data.status.state = data.status.segments ? "partial" : "failed";
      }
      update(data.status);
      if (data.type === "finished") {
        if (!ready)
          rejectReady(
            new Error(
              `${source.label}: ${data.status.error || "Quelle konnte nicht gestartet werden."}`,
            ),
          );
        done = true;
        clearTimeout(timeout);
        resolveFinished(data.status);
      }
    };
    worker.onerror = (event) => {
      rejectReady(
        new Error(
          `${source.label}: ${event.message || "Recorder-Worker beendet."}`,
        ),
      );
      const current = this.status.sources.find((s) => s.trackId === source.id);
      const failed: SourceStatus = {
        trackId: source.id,
        label: source.label,
        kind: source.kind,
        savedSeconds: 0,
        capturedSeconds: 0,
        bytes: 0,
        segments: 0,
        ...current,
        state: current?.segments ? "partial" : "failed",
        error: event.message || "Recorder-Worker beendet.",
      };
      done = true;
      clearTimeout(timeout);
      update(failed);
      resolveFinished(failed);
    };
    const message: Init = {
      type: "init",
      root: this.store.root,
      area: this.store.area,
      recording: this.meta,
      track,
      mainTimeOrigin: performance.timeOrigin,
    };
    const transfers: Transferable[] = [];
    try {
      if (source.kind === "audio") {
        channel = new MessageChannel();
        node = new AudioWorkletNode(context, "localtake-pcm", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: channels,
          channelCountMode: "explicit",
          processorOptions: { channels },
        });
        input = context.createMediaStreamSource(source.stream);
        silent = context.createGain();
        silent.gain.value = 0;
        input.connect(node);
        node.connect(silent);
        silent.connect(context.destination);
        message.port = channel.port1;
        message.audioAnchor = {
          contextTime: context.currentTime,
          localMs: performance.now(),
        };
        transfers.push(channel.port1);
        worker.postMessage(message, transfers);
        node.port.postMessage({ type: "connect", port: channel.port2 }, [
          channel.port2,
        ]);
      } else {
        worker.postMessage(message);
      }
    } catch (error) {
      // This runner has not entered the session's cleanup list yet.
      cleanup();
      throw error;
    }
    return {
      sourceId: source.id,
      worker,
      finished,
      ready: prepared,
      stop: (reason) => {
        if (done || stopRequested) return;
        stopRequested = true;
        forcedError = reason;
        if (node) node.port.postMessage({ type: "stop" });
        else worker.postMessage({ type: "stop" });
        timeout = setTimeout(() => {
          done = true;
          const current = this.status.sources.find(
            (s) => s.trackId === source.id,
          );
          const failed: SourceStatus = {
            trackId: source.id,
            label: source.label,
            kind: source.kind,
            savedSeconds: 0,
            capturedSeconds: 0,
            bytes: 0,
            segments: 0,
            ...current,
            state: "partial",
            error:
              "Abschlusszeit überschritten. Bestand über Wiederherstellung prüfen.",
          };
          update(failed);
          cleanup();
          resolveFinished(failed);
        }, 30_000);
      },
      cleanup,
    };
  }
  async event(type: string, fields: Record<string, unknown> = {}) {
    if (this.stopping) return;
    await this.writeMetadata(
      this.store.event(this.meta, {
        type,
        localMs: performance.now(),
        ...fields,
      }),
    );
  }
  private writeMetadata(operation: Promise<unknown>) {
    const job = operation.catch((error) => this.metadataError(error));
    this.metadataJobs.add(job);
    void job.then(() => this.metadataJobs.delete(job));
    return job;
  }
  private metadataError(error: unknown) {
    if (this.issues.length < 1000)
      this.issues.push(`Metadaten: ${String(error).slice(0, 480)}`);
    this.dispatchEvent(new CustomEvent("error", { detail: String(error) }));
  }
  stop(): Promise<void> {
    return (this.stopping ??= this.finalize());
  }
  private async finalize() {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.capture.removeEventListener("ended", this.ended);
    this.status.state = "finalizing";
    this.publish();
    this.runners.forEach((r) => r.stop());
    const sources = await Promise.all(this.runners.map((r) => r.finished));
    await Promise.all([...this.metadataJobs]);
    this.status.sources = sources;
    this.status.state =
      !this.issues.length &&
      sources.length === this.sources.length &&
      sources.every((s) => s.state === "saved")
        ? "saved"
        : "partial";
    try {
      await this.store.finish(this.meta, {
        formatVersion: 1,
        recordingId: this.meta.recordingId,
        participantId: this.meta.participantId,
        finishedAt: new Date().toISOString(),
        sources,
        issues: this.issues,
      });
    } catch (error) {
      this.status.state = "partial";
      this.dispatchEvent(new CustomEvent("error", { detail: String(error) }));
    } finally {
      this.runners.forEach((r) => r.cleanup());
      this.releaseLock?.();
      this.releaseOriginals?.();
      this.publish();
    }
  }
}

// Chromium can switch audio render clocks when its first worklet starts.
// Establish a continuous clock before attaching any actual recording sources.
async function prepareAudioClock(context: AudioContext) {
  const node = new AudioWorkletNode(context, "localtake-pcm", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { channels: 1, warmup: true },
  });
  let silent: GainNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    silent = context.createGain();
    silent.gain.value = 0;
    await new Promise<void>((resolve, reject) => {
      node.port.onmessage = ({ data }) => {
        if (data.type === "ready") resolve();
      };
      node.onprocessorerror = () =>
        reject(new Error("Audio-Vorbereitung fehlgeschlagen."));
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "Die Audiozeitbasis ist nicht bereit. Geräte prüfen und Probe erneut starten.",
            ),
          ),
        3000,
      );
      node.connect(silent!);
      silent!.connect(context.destination);
    });
  } finally {
    clearTimeout(timer);
    node.port.close();
    node.disconnect();
    silent?.disconnect();
  }
}
