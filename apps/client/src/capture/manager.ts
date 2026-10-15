import type { Quality } from "../../../../packages/protocol/src/index.js";

export type { Quality };
export type CaptureSource = {
  encoderPreference?: "prefer-hardware" | "prefer-software";
  slotId?: string;
  changing?: boolean;
  id: string;
  label: string;
  kind: "video" | "audio" | "screen";
  track: MediaStreamTrack;
  stream: MediaStream;
  settings: MediaTrackSettings;
  synthetic?: boolean;
  cleanup?: () => void;
};
export const profiles: Record<
  Quality,
  { width: number; height: number; frameRate: number; bitrate: number }
> = {
  "720": { width: 1280, height: 720, frameRate: 30, bitrate: 8_000_000 },
  "1080": { width: 1920, height: 1080, frameRate: 30, bitrate: 20_000_000 },
  "2160": { width: 3840, height: 2160, frameRate: 30, bitrate: 50_000_000 },
};
export class CaptureManager extends EventTarget {
  sources: CaptureSource[] = [];
  context: AudioContext | null = null;
  private mix: MediaStreamAudioDestinationNode | null = null;
  private mixInputs = new Map<string, MediaStreamAudioSourceNode>();
  private monitor = new Map<
    string,
    { node: MediaStreamAudioSourceNode; analyser: AnalyserNode }
  >();
  micMuted = false;
  camMuted = false;
  selectedCamera: string | null = null;
  async audioContext() {
    this.context ??= new AudioContext({
      sampleRate: 48_000,
      latencyHint: "interactive",
    });
    if (this.context.state === "suspended") await this.context.resume();
    return this.context;
  }
  async devices() {
    return navigator.mediaDevices.enumerateDevices();
  }
  // Without a saved choice, recover from an unavailable system default (for
  // example an installed virtual camera whose producer is not running).
  // An explicit choice must never silently become another device.
  async addDefault(
    kind: "video" | "audio",
    quality: Quality,
    preferredDeviceId = "",
  ): Promise<CaptureSource> {
    if (preferredDeviceId) return this.add(kind, preferredDeviceId, quality);
    const deviceKind = kind === "video" ? "videoinput" : "audioinput";
    const devices = await this.devices();
    const first =
      kind === "video"
        ? devices.find((device) => device.kind === deviceKind)?.deviceId || ""
        : "";
    let failure: unknown;
    try {
      return await this.add(kind, first, quality);
    } catch (error) {
      if (!deviceStartError(error)) throw error;
      failure = error;
    }
    // Labels and IDs may only become available after the first permission
    // request. Re-enumerate once, and try each other concrete input at most once.
    const tried = new Set([first, "", "default", "communications"]);
    for (const device of await this.devices()) {
      if (device.kind !== deviceKind || tried.has(device.deviceId)) continue;
      tried.add(device.deviceId);
      try {
        return await this.add(kind, device.deviceId, quality);
      } catch (error) {
        if (!deviceStartError(error)) throw error;
        failure = error;
      }
    }
    throw failure;
  }
  async add(
    kind: "video" | "audio",
    deviceId: string,
    quality: Quality,
  ): Promise<CaptureSource> {
    if (this.sources.length >= 16)
      throw new Error("Maximal 16 Quellen pro Teilnehmer.");
    if (
      deviceId &&
      this.sources.some(
        (s) => s.settings.deviceId === deviceId && s.kind === kind,
      )
    )
      throw new Error("Dieses Gerät ist bereits ausgewählt.");
    return this.register(await this.open(kind, deviceId, quality));
  }
  // Switches a camera or microphone in place, keeping its position in the list.
  // The previous device is released first: many systems cannot open two cameras.
  async switch(id: string, deviceId: string, quality: Quality) {
    const previous = this.sources.find((s) => s.id === id);
    if (!previous || previous.kind === "screen")
      throw new Error("Quelle nicht gefunden.");
    if (previous.changing) throw new Error("Gerät wird bereits gewechselt.");
    const kind = previous.kind;
    if (deviceId === previous.settings.deviceId) return previous;
    if (
      this.sources.some(
        (s) =>
          s.id !== id && s.kind === kind && s.settings.deviceId === deviceId,
      )
    )
      throw new Error("Dieses Gerät ist bereits ausgewählt.");
    const live = this.selectedCamera === id;
    previous.changing = true;
    this.detach(previous, true);
    this.dispatchEvent(new Event("change"));
    let source: CaptureSource;
    try {
      source = await this.open(kind, deviceId, quality, previous.id);
    } catch (error) {
      // Restore the previous device so a failed switch does not lose the source.
      if (!previous.synthetic && this.sources.includes(previous))
        await this.open(
          kind,
          previous.settings.deviceId || "",
          quality,
          previous.id,
        )
          .then((restored) => this.replace(previous, restored, live))
          .catch(() => this.detach(previous));
      else if (this.sources.includes(previous)) this.detach(previous);
      this.dispatchEvent(new CustomEvent("ended", { detail: previous }));
      this.dispatchEvent(new Event("change"));
      throw error;
    }
    this.dispatchEvent(new CustomEvent("ended", { detail: previous }));
    return this.replace(previous, source, live);
  }
  private async replace(
    previous: CaptureSource,
    source: CaptureSource,
    live: boolean,
  ) {
    const index = this.sources.indexOf(previous);
    if (index < 0) {
      source.track.stop();
      source.cleanup?.();
      throw new Error("Quelle wurde während des Wechsels entfernt.");
    }
    source.slotId = previous.slotId || previous.id;
    this.sources.splice(index, 1);
    return this.register(source, index, live);
  }
  // Applies a new recording profile to the open cameras without reopening them.
  async applyQuality(quality: Quality) {
    const profile = profiles[quality];
    const failures: string[] = [];
    for (const source of this.sources) {
      if (source.kind !== "video" || source.synthetic) continue;
      try {
        await source.track.applyConstraints({
          width: { ideal: profile.width },
          height: { ideal: profile.height },
          aspectRatio: { ideal: profile.width / profile.height },
          frameRate: { ideal: profile.frameRate },
          resizeMode: "none",
        } as MediaTrackConstraints);
      } catch (error) {
        failures.push(
          `${source.label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      source.settings = source.track.getSettings();
    }
    this.dispatchEvent(new Event("change"));
    if (failures.length)
      throw new Error(`Videoprofil nicht übernommen: ${failures.join(" · ")}`);
  }
  private async open(
    kind: "video" | "audio",
    deviceId: string,
    quality: Quality,
    replacingId?: string,
  ): Promise<CaptureSource> {
    const profile = profiles[quality];
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === "video"
        ? {
            video: {
              deviceId: deviceId ? { exact: deviceId } : undefined,
              width: { ideal: profile.width },
              height: { ideal: profile.height },
              aspectRatio: { ideal: profile.width / profile.height },
              frameRate: { ideal: profile.frameRate },
              resizeMode: "none",
            },
            audio: false,
          }
        : {
            video: false,
            audio: {
              deviceId: deviceId ? { exact: deviceId } : undefined,
              sampleRate: { ideal: 48_000 },
              channelCount: { ideal: 2 },
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          },
    );
    const track = stream.getTracks()[0];
    const actualDeviceId = track.getSettings().deviceId;
    if (
      actualDeviceId &&
      this.sources.some(
        (s) =>
          s.id !== replacingId &&
          s.kind === kind &&
          s.settings.deviceId === actualDeviceId,
      )
    ) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("Dieses Gerät ist bereits ausgewählt.");
    }
    return {
      id: crypto.randomUUID(),
      label:
        track.label.slice(0, 120) || (kind === "video" ? "Kamera" : "Mikrofon"),
      kind,
      track,
      stream,
      settings: track.getSettings(),
    };
  }
  async screen() {
    const existing = this.sources.find((s) => s.kind === "screen");
    if (existing) {
      this.remove(existing.id);
      return null;
    }
    if (this.sources.length >= 16)
      throw new Error("Maximal 16 Quellen pro Teilnehmer.");
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    return this.register({
      id: crypto.randomUUID(),
      label: "Bildschirmfreigabe",
      kind: "screen",
      track,
      stream,
      settings: track.getSettings(),
    });
  }
  private async register(
    source: CaptureSource,
    index = this.sources.length,
    live = false,
  ) {
    source.track.enabled =
      source.kind === "audio"
        ? !this.micMuted
        : source.kind === "screen" || !this.camMuted;
    this.sources.splice(index, 0, source);
    if (source.kind === "video" && (live || !this.selectedCamera))
      this.selectedCamera = source.id;
    source.track.addEventListener("ended", () =>
      this.dispatchEvent(new CustomEvent("ended", { detail: source })),
    );
    if (source.kind === "audio") {
      const context = await this.audioContext();
      this.mix ??= context.createMediaStreamDestination();
      const node = context.createMediaStreamSource(source.stream);
      // Average the live mix to avoid clipping multiple microphones; originals remain unscaled.
      this.mixInputs.set(source.id, node);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      node.connect(analyser);
      this.monitor.set(source.id, { node, analyser });
      this.rebuildMix();
    }
    this.dispatchEvent(new Event("change"));
    return source;
  }
  private mixGain: GainNode | null = null;
  private rebuildMix() {
    if (!this.context || !this.mix) return;
    this.mixGain?.disconnect();
    this.mixGain = this.context.createGain();
    this.mixGain.gain.value = 1 / Math.max(1, this.mixInputs.size);
    this.mixGain.connect(this.mix);
    for (const [id, node] of this.mixInputs) {
      node.disconnect();
      node.connect(this.mixGain);
      const analyser = this.monitor.get(id)?.analyser;
      if (analyser) node.connect(analyser);
    }
  }
  get audioTrack() {
    return this.mixInputs.size
      ? (this.mix?.stream.getAudioTracks()[0] ?? null)
      : null;
  }
  get cameraTrack() {
    return (
      this.sources.find(
        (s) => s.id === this.selectedCamera && s.track.readyState === "live",
      )?.track ?? null
    );
  }
  get screenTrack() {
    return (
      this.sources.find(
        (s) => s.kind === "screen" && s.track.readyState === "live",
      )?.track ?? null
    );
  }
  levels() {
    const values: Record<string, number> = {};
    for (const [id, { analyser }] of this.monitor) {
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      values[id] = Math.sqrt(data.reduce((n, v) => n + v * v, 0) / data.length);
    }
    return values;
  }
  mute(kind: "audio" | "video", muted: boolean) {
    if (kind === "audio") this.micMuted = muted;
    else this.camMuted = muted;
    for (const source of this.sources)
      if (source.kind === kind) source.track.enabled = !muted;
    this.dispatchEvent(new Event("change"));
  }
  remove(id: string) {
    const source = this.sources.find((s) => s.id === id);
    if (!source) return;
    this.detach(source);
    this.dispatchEvent(new CustomEvent("ended", { detail: source }));
    this.dispatchEvent(new Event("change"));
  }
  private detach(source: CaptureSource, keepSlot = false) {
    source.track.stop();
    source.cleanup?.();
    this.mixInputs.get(source.id)?.disconnect();
    this.mixInputs.delete(source.id);
    this.monitor.delete(source.id);
    if (!keepSlot)
      this.sources = this.sources.filter((s) => s.id !== source.id);
    this.rebuildMix();
    if (!keepSlot && this.selectedCamera === source.id)
      this.selectedCamera =
        this.sources.find((s) => s.kind === "video")?.id ?? null;
  }
  async synthetic() {
    const context = await this.audioContext();
    for (let i = 0; i < 2; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d")!;
      let frame = 0;
      const draw = () => {
        ctx.fillStyle = i ? "#174840" : "#242351";
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#b9ff8a";
        ctx.fillRect((frame * 5) % 600, 250, 40, 40);
        ctx.fillStyle = "#ffffff";
        ctx.font = "28px monospace";
        ctx.fillText(`TEST CAMERA ${i + 1}`, 35, 60);
        ctx.fillText(`FRAME ${frame++}`, 35, 110);
        ctx.fillText(new Date().toISOString().slice(11, 23), 35, 160);
      };
      draw();
      const timer = setInterval(draw, 1000 / 30),
        stream = canvas.captureStream(30),
        track = stream.getVideoTracks()[0];
      await this.register({
        id: crypto.randomUUID(),
        label: `Testkamera ${i + 1} · synthetisch`,
        kind: "video",
        track,
        stream,
        settings: track.getSettings(),
        synthetic: true,
        cleanup: () => clearInterval(timer),
      });
      const destination = context.createMediaStreamDestination(),
        oscillator = context.createOscillator(),
        gain = context.createGain();
      oscillator.frequency.value = i ? 660 : 440;
      gain.gain.value = 0.08;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      const audio = destination.stream.getAudioTracks()[0];
      await this.register({
        id: crypto.randomUUID(),
        label: `Testmikrofon ${i + 1} · ${oscillator.frequency.value} Hz`,
        kind: "audio",
        track: audio,
        stream: destination.stream,
        settings: audio.getSettings(),
        synthetic: true,
        cleanup: () => {
          oscillator.stop();
          gain.disconnect();
        },
      });
    }
  }
}

function deviceStartError(error: unknown) {
  const name = (error as DOMException)?.name;
  return name === "NotReadableError" || name === "AbortError";
}
