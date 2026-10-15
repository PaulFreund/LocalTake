import type { StudioRuntime } from "./runtime.js";
import type { Remote } from "../live/mesh.js";
import { PROTOCOL_VERSION } from "../../../../packages/protocol/src/index.js";
import {
  compactDiagnostic,
  diagnosticSecretKey,
  redactDiagnosticText,
} from "../../../../packages/protocol/src/telemetry.js";

type BuildInfo = {
  version: string;
  revision: string | null;
  builtAt: string;
  mode: string;
};
declare const __LOCALTAKE_BUILD__: BuildInfo;
export const diagnosticBuild = () =>
  typeof __LOCALTAKE_BUILD__ === "undefined" ? null : __LOCALTAKE_BUILD__;

export type DiagnosticEvent = {
  at: string;
  elapsedMs: number;
  scope: string;
  event: string;
  detail?: unknown;
};

// Reports may be shared for support. Keep addresses and timing, never access secrets.
export function redactDiagnostics(value: unknown): unknown {
  if (typeof value === "string") return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map(redactDiagnostics);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        diagnosticSecretKey.test(key) ? "[redacted]" : redactDiagnostics(item),
      ]),
    );
  return value;
}

export class DiagnosticLog extends EventTarget {
  readonly startedAt = new Date().toISOString();
  readonly entries: DiagnosticEvent[] = [];
  dropped = 0;
  constructor(readonly limit = 300) {
    super();
  }
  record(scope: string, event: string, detail?: unknown) {
    const entry = {
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now()),
      scope,
      event,
      detail: compactDiagnostic(detail),
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
      this.dropped++;
    }
    this.dispatchEvent(new CustomEvent("entry", { detail: entry }));
  }
}

function bounded<T>(operation: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), 1500);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function trackInfo(track: MediaStreamTrack | null) {
  return track
    ? {
        id: track.id,
        kind: track.kind,
        label: track.label,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
        settings: track.getSettings(),
        constraints: track.getConstraints(),
      }
    : null;
}

function channelInfo(channel: RTCDataChannel | null) {
  return channel
    ? {
        label: channel.label,
        id: channel.id,
        readyState: channel.readyState,
        bufferedAmount: channel.bufferedAmount,
        ordered: channel.ordered,
        maxPacketLifeTime: channel.maxPacketLifeTime,
        maxRetransmits: channel.maxRetransmits,
      }
    : null;
}

type Stats = Record<string, unknown> & { id: string; type: string };

export function selectedIcePair(stats: Stats[]) {
  const selectedId = stats.find(
    (stat) => stat.type === "transport" && stat.selectedCandidatePairId,
  )?.selectedCandidatePairId;
  const pair = selectedId
    ? stats.find((stat) => stat.id === selectedId)
    : stats.find(
        (stat) =>
          stat.type === "candidate-pair" &&
          stat.state === "succeeded" &&
          stat.nominated,
      );
  if (!pair) return null;
  const local = stats.find((stat) => stat.id === pair.localCandidateId) ?? null;
  const remote =
    stats.find((stat) => stat.id === pair.remoteCandidateId) ?? null;
  return {
    route:
      local?.candidateType === "relay" || remote?.candidateType === "relay"
        ? "TURN"
        : local && remote
          ? "direct"
          : "unknown",
    pair,
    local,
    remote,
  };
}

export function connectionDiagnosis(remote: Remote) {
  const pc = remote.pc;
  if (pc.connectionState === "connected") return "Verbunden";
  if (pc.connectionState === "closed") return "Verbindung geschlossen";
  if (!pc.localDescription && !pc.remoteDescription)
    return "Noch kein Angebot ausgetauscht";
  if (!pc.remoteDescription) return "Antwort der Gegenstelle fehlt";
  if (!pc.localDescription) return "Lokale Antwort fehlt";
  if (pc.iceConnectionState === "failed")
    return "ICE fehlgeschlagen: keine funktionierende Netzwerkroute";
  if (pc.iceConnectionState === "checking")
    return "ICE prüft Netzwerkverbindungen";
  return "Verbindungsaufbau noch nicht abgeschlossen";
}

async function remoteReport(remote: Remote, participantId?: string) {
  let statsError: string | null = null;
  const stats = await bounded(
    remote.pc.getStats().then(
      (report) => {
        const entries: Stats[] = [];
        report.forEach((stat) => entries.push({ ...stat }));
        return entries;
      },
      (error) => {
        statsError = error instanceof Error ? error.message : String(error);
        return [] as Stats[];
      },
    ),
    null,
  );
  const pc = remote.pc;
  return {
    id: remote.id,
    name: remote.peer.name,
    connectionId: remote.peer.connectionId,
    linkId: remote.linkId,
    offerer: participantId ? participantId < remote.id : null,
    diagnosis: connectionDiagnosis(remote),
    connection: pc.connectionState,
    ice: pc.iceConnectionState,
    gathering: pc.iceGatheringState,
    signaling: pc.signalingState,
    issue: remote.connectionIssue ?? null,
    makingOffer: remote.makingOffer,
    ignoringOffer: remote.ignoreOffer,
    settingAnswer: remote.settingAnswer,
    queuedCandidates: remote.candidates.length,
    selectedPair: selectedIcePair(stats ?? []),
    channels: {
      control: channelInfo(remote.control),
      files: channelInfo(remote.files),
    },
    transceivers: pc.getTransceivers().map((slot) => ({
      mid: slot.mid,
      direction: slot.direction,
      currentDirection: slot.currentDirection,
      sender: trackInfo(slot.sender.track),
      receiver: trackInfo(slot.receiver.track),
    })),
    descriptions: {
      local: pc.localDescription?.toJSON() ?? null,
      remote: pc.remoteDescription?.toJSON() ?? null,
      pendingLocal: pc.pendingLocalDescription?.toJSON() ?? null,
      pendingRemote: pc.pendingRemoteDescription?.toJSON() ?? null,
    },
    liveStats: { ...remote.stats },
    rtcStats: stats ?? [],
    statsError:
      statsError ??
      (stats === null ? "Statistikabfrage zeitlich abgebrochen" : null),
  };
}

async function permission(name: "camera" | "microphone") {
  if (!navigator.permissions) return "unavailable";
  try {
    return await bounded(
      navigator.permissions
        .query({ name: name as PermissionName })
        .then((result) => result.state),
      "unavailable",
    );
  } catch {
    return "unavailable";
  }
}

export async function collectDiagnostics(studio: StudioRuntime) {
  const remotes = [...studio.mesh.remotes.values()];
  const [peers, cameraPermission, microphonePermission, storageEstimate] =
    await Promise.all([
      Promise.all(
        remotes.map((remote) =>
          remoteReport(remote, studio.room.credentials?.participantId),
        ),
      ),
      permission("camera"),
      permission("microphone"),
      navigator.storage?.estimate
        ? bounded(navigator.storage.estimate(), null)
        : null,
    ]);
  const network = (
    navigator as Navigator & {
      connection?: {
        effectiveType?: string;
        type?: string;
        rtt?: number;
        downlink?: number;
        saveData?: boolean;
      };
    }
  ).connection;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pageStartedAt: studio.diagnostics.startedAt,
    app: {
      build:
        typeof __LOCALTAKE_BUILD__ === "undefined" ? null : __LOCALTAKE_BUILD__,
      protocolVersion: PROTOCOL_VERSION,
      origin: location.origin,
      path: location.pathname,
    },
    browser: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: [...navigator.languages],
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      online: navigator.onLine,
      secureContext: window.isSecureContext,
      visibility: document.visibilityState,
      hardwareConcurrency: navigator.hardwareConcurrency,
      network: network
        ? {
            effectiveType: network.effectiveType,
            type: network.type,
            rtt: network.rtt,
            downlink: network.downlink,
            saveData: network.saveData,
          }
        : null,
      features: {
        webRTC: typeof RTCPeerConnection === "function",
        mediaDevices: !!navigator.mediaDevices,
        videoEncoder: typeof VideoEncoder === "function",
        audioEncoder: typeof AudioEncoder === "function",
        folderPicker: studio.folderSupported,
        browserStorage: studio.browserStorageSupported,
      },
      permissions: {
        camera: cameraPermission,
        microphone: microphonePermission,
      },
    },
    signaling: studio.room.diagnosticState(),
    telemetry: studio.telemetry?.status() ?? null,
    room: {
      id: studio.room.credentials?.roomId ?? null,
      participantId: studio.room.credentials?.participantId ?? null,
      role:
        studio.room.state?.peers.find(
          (peer) => peer.id === studio.room.credentials?.participantId,
        )?.role ?? null,
      peers: studio.room.state?.peers ?? [],
      clock: studio.room.clock.snapshot(),
    },
    iceServers: studio.mesh.diagnosticIceServers(),
    iceTransportPolicy: studio.mesh.diagnosticIceTransportPolicy(),
    peers,
    capture: {
      micMuted: studio.capture.micMuted,
      camMuted: studio.capture.camMuted,
      livePaused: studio.mesh.paused,
      selectedCamera: studio.capture.selectedCamera,
      quality: studio.quality,
      audioContext: studio.capture.context
        ? {
            state: studio.capture.context.state,
            sampleRate: studio.capture.context.sampleRate,
            baseLatency: studio.capture.context.baseLatency,
            outputLatency: studio.capture.context.outputLatency,
          }
        : null,
      sources: studio.capture.sources.map((source) => ({
        id: source.id,
        label: source.label,
        kind: source.kind,
        synthetic: source.synthetic ?? false,
        track: trackInfo(source.track),
      })),
      sourceErrors: { ...studio.sourceErrors },
    },
    recording: {
      active: !!studio.recording,
      pendingStart: studio.pendingStart,
      probing: studio.probing,
      readinessError: studio.readinessError,
      status: studio.recording?.status ?? studio.lastRecording?.status ?? null,
    },
    storage: {
      kind: studio.storageKind,
      connected: !!studio.store,
      restoring: studio.storageRestoring,
      choosing: studio.storageChoosing,
      browserStorage: studio.browserStorage,
      estimate: storageEstimate,
      archiveError: studio.archiveError,
    },
    currentError: studio.error || null,
    events: [...studio.diagnostics.entries],
    droppedEvents: studio.diagnostics.dropped,
  };
  // One final pass also covers free-form browser and server error messages.
  return redactDiagnostics(report) as typeof report;
}

export type DiagnosticReport = Awaited<ReturnType<typeof collectDiagnostics>>;
