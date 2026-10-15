import { CaptureManager, type Quality } from "../capture/manager.js";
import { preferredDevice, rememberDevice } from "../capture/preferences.js";
import {
  LocalStore,
  retrying,
  type StoredInventory,
} from "../storage/store.js";
import { LOCAL_RETENTION_MS } from "../storage/layout.js";
import {
  BROWSER_STORAGE_ENABLED,
  savedStorage,
  storagePermission,
  openBrowserStorage,
  browserStorageStatus,
  type StorageKind,
  type BrowserStorageStatus,
} from "../storage/selection.js";
import { RecordingSession } from "../recorder/session.js";
import { RoomClient } from "../room/client.js";
import { LiveMesh } from "../live/mesh.js";
import { TransferManager } from "../transfer/manager.js";
import { AutomaticSync } from "../transfer/sync.js";
import { roomFromLink, savedRooms, sessionLink } from "../room/session-link.js";
import {
  buildSessions,
  hostUploadPending,
  type SessionView,
} from "./sessions.js";
import { DiagnosticLog, diagnosticBuild } from "./diagnostics.js";
import { TelemetryUploader } from "./telemetry.js";
import {
  qualitySchema,
  type Inventory,
  type RoomState,
  type ServerMessage,
  type SessionManifest,
} from "../../../../packages/protocol/src/index.js";

// Sources and storage are checked again after every change; a passing setup is
// re-verified rarely, because each check records a few seconds to disk.
const RECHECK_MS = 5 * 60_000;
// getUserMedia reports causes as bare DOMException names; say what to do.
const mediaError = (error: unknown) => {
  const name = (error as DOMException)?.name;
  const detail = error instanceof Error ? error.message : String(error);
  return name === "NotReadableError" || name === "AbortError"
    ? `Gerät ist belegt oder startet nicht (${detail}). Andere Programme oder Tabs schließen, die es verwenden, etwa OBS, die Herstellersoftware oder einen älteren LocalTake-Tab.`
    : name === "NotAllowedError"
      ? "Zugriff verweigert. Kamera und Mikrofon für diese Seite über das Symbol in der Adressleiste erlauben."
      : name === "NotFoundError"
        ? "Gerät nicht gefunden. Ist es angeschlossen?"
        : name === "OverconstrainedError"
          ? "Gerät unterstützt das gewählte Profil nicht."
          : detail;
};
const savedQuality = (): Quality => {
  try {
    return qualitySchema.parse(localStorage.getItem("localtake-quality"));
  } catch {
    return "1080";
  }
};

export class StudioRuntime extends EventTarget {
  revision = 0;
  readonly capture = new CaptureManager();
  readonly room = new RoomClient();
  readonly mesh = new LiveMesh(this.room, this.capture);
  readonly diagnostics = new DiagnosticLog();
  readonly telemetry: TelemetryUploader;
  readonly transfer = new TransferManager(
    this.mesh,
    (peerId) =>
      !this.recording &&
      !this.pendingStart &&
      !this.probing &&
      !this.groupRecording &&
      Boolean(this.mesh.remotes.get(peerId)?.peer.archiveReady) &&
      !["recording", "finalizing"].includes(
        this.mesh.remotes.get(peerId)?.peer.recording?.state || "",
      ),
    () => (this.mesh.paused ? 0 : 2_000_000),
  );
  readonly sync = new AutomaticSync(this.transfer, () => ({
    roomId: this.room.credentials?.roomId,
    selfId: this.room.credentials?.participantId,
    destinationId: this.archiveDestinationId,
    store: this.store,
    library: this.library,
    canWork:
      !this.recording &&
      !this.pendingStart &&
      !this.probing &&
      !this.groupRecording &&
      !this.busy &&
      !this.storageChoosing,
    destinationReady: Boolean(
      this.archiveDestination?.connected &&
      this.archiveDestination.archiveReady &&
      this.mesh.remotes.get(this.archiveDestination.id)?.files?.readyState ===
        "open",
    ),
  }));
  store: LocalStore | null = null;
  storageKind: StorageKind | null = null;
  // True until the remembered folder has been checked, so the folder dialog
  // does not flash open for a folder that is still granted.
  storageRestoring = true;
  storageChoosing = false;
  browserStorage: BrowserStorageStatus | null = null;
  readonly folderSupported = typeof window.showDirectoryPicker === "function";
  readonly browserStorageSupported =
    BROWSER_STORAGE_ENABLED &&
    typeof navigator.storage?.getDirectory === "function";
  directoryToReconnect: FileSystemDirectoryHandle | null = null;
  recording: RecordingSession | null = null;
  lastRecording: RecordingSession | null = null;
  library: StoredInventory[] = [];
  manifests: SessionManifest[] = [];
  devices: MediaDeviceInfo[] = [];
  sourceErrors: Partial<Record<"audio" | "video", string>> = {};
  openingDefaults = false;
  quality: Quality = savedQuality();
  name = localStorage.getItem("localtake-name") || "";
  roomName = "";
  ownerId = localStorage.getItem("localtake-owner") || crypto.randomUUID();
  armed = false;
  probePassed = false;
  probing = false;
  readinessError = "";
  lastProbeAt = 0;
  syncDialog = false;
  leaveRequested = false;
  archiveError = "";
  recordScreen = false;
  busy = "";
  notice = "";
  error = "";
  testStorage = false;
  testFolders: FileSystemDirectoryHandle[] = [];
  exported: { name: string; url: string; size: number }[] = [];
  pendingStart = false;
  chat: { id: string; name: string; text: string }[] = [];
  invite = new URLSearchParams(location.hash.slice(1)).get("invite") || "";
  private roomLinkPending = false;
  private restoringRoomLink: string | null = null;
  private startTimer?: ReturnType<typeof setTimeout>;
  private started = new Set<string>();
  private wakeLock: WakeLockSentinel | null = null;
  private initializing: Promise<void> | null = null;
  private stoppingLocal: Promise<void> | null = null;
  private storageRevision = 0;
  private checkRevision = 0;
  private nextCheckAt = 0;
  private probeOperation: Promise<void> | null = null;
  private cancelProbeDelay: (() => void) | null = null;
  private presenceSent = "";
  private uploadSent = "";
  private showedUpload = false;
  private syncRefreshing = false;
  private syncRefreshAgain = false;
  private exportPending = false;
  private archiveWriting = false;
  private maintenanceRunning = false;
  private lastHousekeepingAt = 0;
  private storageWritable = false;
  private lastPermissionCheck = 0;
  private lastSyncContext = "";
  private defaultSources: Promise<void> | null = null;
  private manifestWrites = Promise.resolve();
  private manifestKeys = new Map<string, string>();
  private sessionCache: { revision: number; value: SessionView[] } | null =
    null;
  constructor() {
    super();
    this.telemetry = new TelemetryUploader(
      this.diagnostics,
      () => ({
        credentials: this.room.credentials,
        enabled: this.room.telemetryEnabled,
      }),
      () => this.telemetrySample(),
    );
    this.room.addEventListener("change", () => this.telemetry.refresh());
    this.diagnostics.record("app", "started");
    for (const [scope, source] of [
      ["signaling", this.room],
      ["live", this.mesh],
    ] as const)
      source.addEventListener("diagnostic", (event) => {
        const detail = (event as CustomEvent).detail;
        this.diagnostics.record(scope, detail.event, detail.detail);
      });
    window.addEventListener("error", (event) =>
      this.diagnostics.record("browser", "error", {
        message: event.message,
        file: event.filename,
        line: event.lineno,
        column: event.colno,
      }),
    );
    window.addEventListener("unhandledrejection", (event) =>
      this.diagnostics.record("browser", "unhandledrejection", {
        message:
          event.reason instanceof Error
            ? event.reason.message
            : String(event.reason),
      }),
    );
    for (const name of ["online", "offline"])
      window.addEventListener(name, () =>
        this.diagnostics.record("browser", name),
      );
    window.addEventListener("hashchange", () => {
      this.invite =
        new URLSearchParams(location.hash.slice(1)).get("invite") || "";
      this.changed();
      void this.restoreLinkedRoom();
    });
    localStorage.setItem("localtake-owner", this.ownerId);
    for (const source of [
      this.capture,
      this.room,
      this.mesh,
      this.transfer,
      this.sync,
    ])
      source.addEventListener("change", () => this.changed());
    for (const source of [this.room, this.mesh])
      source.addEventListener("error", (e) =>
        this.report((e as CustomEvent).detail),
      );
    this.capture.addEventListener("change", () => this.publishPresence());
    this.capture.addEventListener("ended", () => {
      if (!this.recording) this.invalidate();
    });
    this.room.addEventListener("message", (event) => {
      void this.message((event as CustomEvent<ServerMessage>).detail).catch(
        (error) => this.report(error),
      );
    });
    this.transfer.addEventListener("received", () => {
      this.exportPending = true;
      void this.scan().catch((error) => this.report(error));
    });
    this.sync.addEventListener("retired", (event) => {
      const { recording, destinationId } = (event as CustomEvent).detail;
      const inventory = this.library.find(
        (i) =>
          i.recording.recordingId === recording.recordingId &&
          i.recording.participantId === recording.participantId,
      );
      if (inventory) inventory.transferredTo = destinationId;
      this.changed();
    });
    navigator.mediaDevices?.addEventListener("devicechange", () => {
      void this.devicesRefresh();
    });
    window.addEventListener("beforeunload", (event) => {
      if (this.recording || this.pendingStart || this.uploadPending) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    document.addEventListener("visibilitychange", () => {
      this.diagnostics.record("browser", "visibility", {
        state: document.visibilityState,
      });
      if (!document.hidden) {
        if (this.recording) void this.wake();
        else this.nextCheckAt = 0;
      }
    });
    void this.devicesRefresh();
    const storageRevision = this.storageRevision;
    void savedStorage()
      .then(async (selection) => {
        if (
          !selection ||
          (selection.kind === "diagnostic" && !import.meta.env.DEV)
        )
          return;
        if (this.store || this.storageRevision !== storageRevision) return;
        if (selection.kind === "browser" && !BROWSER_STORAGE_ENABLED) {
          this.notice =
            "Browserspeicher ist vorübergehend deaktiviert. Bitte einen Aufnahmeordner wählen. Vorhandene Browseraufnahmen bleiben erhalten.";
          this.changed();
          return;
        }
        const permission = await storagePermission(selection);
        if (this.store || this.storageRevision !== storageRevision) return;
        if (permission === "granted") {
          const store = new LocalStore(selection.root);
          await store.preflight();
          const status =
            selection.kind === "browser" ? await browserStorageStatus() : null;
          if (this.store || this.storageRevision !== storageRevision) return;
          this.selectStorage(store, selection.kind);
          this.browserStorage = status;
          this.changed();
          await this.scan();
        } else {
          // Requesting permission requires a user gesture, so expose a reconnect
          // control instead of silently discarding the saved directory.
          this.directoryToReconnect = selection.root;
          this.readinessError = `Speicherordner „${selection.root.name}“ ist nicht freigegeben. Bitte „Ordner freigeben“ bestätigen.`;
        }
        this.changed();
      })
      .catch((error) => {
        if (this.storageRevision === storageRevision)
          this.report(
            `Gespeicherte Ablage konnte nicht geöffnet werden: ${String(error)}`,
          );
      })
      .finally(() => {
        this.storageRestoring = false;
        this.changed();
      });
    if (import.meta.env.DEV)
      void navigator.storage
        .getDirectory()
        .then(async (root) => {
          for await (const entry of root.values())
            if (
              entry.kind === "directory" &&
              entry.name.startsWith("diagnostic-")
            )
              this.testFolders.push(entry as FileSystemDirectoryHandle);
          this.changed();
        })
        .catch(() => undefined);
    setInterval(() => void this.maintain(), 1000);
    queueMicrotask(() => void this.restoreLinkedRoom());
  }
  private telemetrySample() {
    const recording = this.recording ?? this.lastRecording;
    return {
      build: diagnosticBuild(),
      browser: {
        userAgent: navigator.userAgent,
        online: navigator.onLine,
        visibility: document.visibilityState,
      },
      signaling: this.room.diagnosticState(),
      connectionId: this.room.state?.peers.find(
        (p) => p.id === this.room.credentials?.participantId,
      )?.connectionId,
      clock: this.room.clock.snapshot(),
      iceServers: this.mesh.diagnosticIceServers(),
      iceTransportPolicy: this.mesh.diagnosticIceTransportPolicy(),
      livePaused: this.mesh.paused,
      peers: [...this.mesh.remotes.values()].map((remote) => ({
        id: remote.id,
        connectionId: remote.peer.connectionId,
        linkId: remote.linkId,
        connection: remote.pc.connectionState,
        ice: remote.pc.iceConnectionState,
        gathering: remote.pc.iceGatheringState,
        signaling: remote.pc.signalingState,
        localDescription: remote.pc.localDescription?.type,
        remoteDescription: remote.pc.remoteDescription?.type,
        control: {
          state: remote.control?.readyState,
          bufferedAmount: remote.control?.bufferedAmount,
        },
        files: {
          state: remote.files?.readyState,
          bufferedAmount: remote.files?.bufferedAmount,
        },
        stats: remote.stats,
        rtc: remote.telemetryStats,
      })),
      capture: {
        quality: this.quality,
        armed: this.armed,
        probePassed: this.probePassed,
        readinessError: this.readinessError,
        sourceErrors: this.sourceErrors,
        storageKind: this.storageKind,
        storageWritable: this.storageWritable,
        audioContextState: this.capture.context?.state,
        sources: this.sources.map((source) => ({
          id: source.id,
          kind: source.kind,
          enabled: source.track.enabled,
          muted: source.track.muted,
          state: source.track.readyState,
        })),
      },
      recording: recording
        ? {
            ...recording.status,
            performance: Object.fromEntries(recording.performance),
          }
        : null,
      upload: this.sync.status,
      archive: {
        pending: this.uploadPending,
        finalizing: this.archiveFinalizing,
        error: this.archiveError,
        libraryCount: this.library.length,
        scanIssues: this.store?.scanIssues.slice(-5) ?? [],
        session: this.currentSession
          ? {
              id: this.currentSession.id,
              settled: this.currentSession.settled,
              participants: this.currentSession.participants.map((p) => ({
                id: p.id,
                self: p.self,
                state: p.state,
                bytes: p.bytes,
                total: p.total,
              })),
            }
          : null,
      },
      error: this.error,
    };
  }
  changed = () => {
    this.revision++;
    this.dispatchEvent(new Event("change"));
  };
  subscribe = (listener: () => void) => {
    this.addEventListener("change", listener);
    return () => this.removeEventListener("change", listener);
  };
  snapshot = () => this.revision;
  report(error: unknown) {
    this.error = error instanceof Error ? error.message : String(error);
    this.diagnostics.record("app", "error", { message: this.error });
    this.changed();
  }
  clearError() {
    this.error = "";
    this.changed();
  }
  get groupActive() {
    return Boolean(
      this.room.state?.take &&
      ["preparing", "recording", "stopping"].includes(
        this.room.state.take.phase,
      ),
    );
  }
  get groupRecording() {
    return Boolean(
      this.room.state?.take &&
      ["preparing", "recording"].includes(this.room.state.take.phase),
    );
  }
  get archiveDestination() {
    return this.room.state?.peers.find(
      (p) => p.id === this.archiveDestinationId,
    );
  }
  // The host receives every participant's originals.
  get archiveDestinationId() {
    return (
      this.room.state?.archiveDestinationId ||
      this.room.state?.peers.find((p) => p.role === "host")?.id
    );
  }
  get isDestination() {
    return Boolean(
      this.room.credentials &&
      this.archiveDestinationId === this.room.credentials.participantId,
    );
  }
  get sessions(): SessionView[] {
    if (this.sessionCache?.revision !== this.revision) {
      const rooms = savedRooms();
      const credentials = this.room.credentials;
      this.sessionCache = {
        revision: this.revision,
        value: buildSessions({
          library: this.library,
          manifests: this.manifests,
          room: this.room.state,
          selfFor: (roomId) =>
            !roomId
              ? this.ownerId
              : roomId === credentials?.roomId
                ? credentials.participantId
                : rooms[roomId]?.credentials.participantId,
          transfers: [...this.transfer.transfers.values()],
          sync: this.sync.items,
          local: [this.recording, this.lastRecording].flatMap((s) =>
            s
              ? [
                  {
                    recordingId: s.meta.recordingId,
                    createdAt: s.meta.createdAt,
                    status: s.status,
                  },
                ]
              : [],
          ),
        }),
      };
    }
    return this.sessionCache.value;
  }
  // The session being recorded or most recently recorded in this room or tab.
  get currentSessionId() {
    const take = this.room.state?.take;
    const self = this.room.credentials?.participantId;
    return (
      this.recording?.meta.recordingId ??
      (take &&
      take.phase !== "cancelled" &&
      self &&
      take.participants.includes(self)
        ? take.id
        : undefined) ??
      this.lastRecording?.meta.recordingId ??
      null
    );
  }
  get currentSession() {
    return this.sessions.find((s) => s.id === this.currentSessionId) ?? null;
  }
  get qualityEditable() {
    return (
      (!this.room.state || this.isHost) &&
      !this.recording &&
      !this.pendingStart &&
      !this.groupActive &&
      !this.sourcesChanging
    );
  }
  get archiveFinalizing() {
    return this.archiveWriting || this.exportPending;
  }
  get uploadPending() {
    const receivingPending = hostUploadPending(
      this.room.state,
      this.room.credentials?.participantId,
      this.sessions,
    );
    return (
      this.sync.status.pending > 0 ||
      this.archiveWriting ||
      this.exportPending ||
      !!this.archiveError ||
      receivingPending ||
      [...this.transfer.transfers.values()].some(
        (t) => !["done", "error"].includes(t.state),
      )
    );
  }
  get readinessReason() {
    if (this.storageChoosing) return "Speicherordner wird gewählt.";
    if (this.directoryToReconnect)
      return `Speicherordner „${this.directoryToReconnect.name}“ freigeben.`;
    if (!this.store)
      return "Aufnahmeordner wählen und Schreibzugriff freigeben.";
    if (this.sourcesChanging) return "Kamera und Mikrofon werden eingerichtet.";
    if (!this.sources.length)
      return "Mindestens eine Kamera oder ein Mikrofon hinzufügen.";
    if (this.readinessError) return this.readinessError;
    if (this.probing && !this.probePassed)
      return "Quellen und Speicher werden automatisch geprüft.";
    if (!this.probePassed) return "Automatische Prüfung wird vorbereitet.";
    if (!this.armed) return "Aufnahmefreigabe ist ausgeschaltet.";
    return "Aufnahmebereit – Quellen und Speicher geprüft.";
  }
  get startBlocked() {
    if (this.recording || this.pendingStart || this.groupActive) return "";
    if (this.room.state && !this.isHost)
      return "Der Host startet die Aufnahme.";
    if (!this.armed || !this.probePassed) return this.readinessReason;
    const peers =
      this.room.state?.peers.filter((p) => p.connected && !p.ready) ?? [];
    if (peers.length)
      return peers
        .map((p) => `${p.name}: ${p.readyReason || "Noch nicht bereit"}`)
        .join(" · ");
    return "";
  }
  get isHost() {
    return (
      this.room.state?.peers.find(
        (p) => p.id === this.room.credentials?.participantId,
      )?.role === "host"
    );
  }
  get sources() {
    return this.capture.sources.filter(
      (s) =>
        s.track.readyState === "live" &&
        (s.kind !== "screen" || this.recordScreen),
    );
  }
  get sourcesChanging() {
    return this.openingDefaults || this.capture.sources.some((s) => s.changing);
  }
  invalidate() {
    this.checkRevision++;
    this.cancelProbeDelay?.();
    this.nextCheckAt = Date.now() + 1200;
    this.readinessError = "";
    this.probePassed = false;
    this.armed = false;
    this.publishPresence();
    this.changed();
  }
  setName(name: string) {
    this.name = name.slice(0, 60);
    localStorage.setItem("localtake-name", this.name);
    this.changed();
  }
  async devicesRefresh() {
    try {
      this.devices = await this.capture.devices();
      this.changed();
    } catch {
      /* secure context / permission shown by preflight */
    }
  }
  private assertSourcesEditable() {
    if (this.sourcesChanging)
      throw new Error("Gerätewechsel zuerst abschließen.");
    if (this.recording || this.pendingStart || this.groupActive)
      throw new Error("Quellen erst nach Ende der Aufnahme ändern.");
  }
  async add(kind: "audio" | "video", id: string) {
    this.assertSourcesEditable();
    this.invalidate();
    this.error = "";
    this.notice = `${kind === "video" ? "Kamera" : "Mikrofon"} wird geöffnet. Falls der Browser eine Freigabe anzeigt, bitte bestätigen.`;
    this.changed();
    try {
      const source = id
        ? await this.capture.add(kind, id, this.quality)
        : await this.capture.addDefault(kind, this.quality);
      rememberDevice(source);
      delete this.sourceErrors[kind];
      await this.devicesRefresh();
      this.notice = `${source.label} ist bereit.`;
      this.changed();
    } catch (error) {
      this.notice = "";
      const reason = mediaError(error);
      if (!this.capture.sources.some((s) => s.kind === kind))
        this.sourceErrors[kind] = reason;
      this.changed();
      throw new Error(reason, { cause: error });
    }
  }
  // "+" adds another device of this kind; the first unused one is preselected
  // and can then be changed in the source itself.
  async addExtra(kind: "audio" | "video") {
    const inUse = this.capture.sources.filter((s) => s.kind === kind);
    const unused = this.devices.find(
      (d) =>
        d.kind === (kind === "video" ? "videoinput" : "audioinput") &&
        d.deviceId &&
        !["default", "communications"].includes(d.deviceId) &&
        !inUse.some(
          (s) =>
            s.settings.deviceId === d.deviceId ||
            (d.groupId && s.settings.groupId === d.groupId),
        ),
    );
    if (!unused && inUse.length)
      throw new Error(
        `Kein weiteres ${kind === "video" ? "Kameragerät" : "Mikrofon"} gefunden.`,
      );
    await this.add(kind, unused?.deviceId ?? "");
  }
  async switchSource(id: string, deviceId: string) {
    this.assertSourcesEditable();
    this.invalidate();
    this.error = "";
    this.notice = "Gerät wird gewechselt …";
    this.changed();
    try {
      const source = await this.capture.switch(id, deviceId, this.quality);
      rememberDevice(source);
      await this.devicesRefresh();
      this.notice = `${source.label} ist bereit.`;
    } catch (error) {
      this.notice = "";
      throw error;
    } finally {
      this.changed();
    }
  }
  // One camera and one microphone are opened by default once a recording folder
  // is available; further sources are optional extras.
  ensureDefaultSources(): Promise<void> {
    return (this.defaultSources ??= this.openDefaultSources());
  }
  // A failed default stays visible in its source row until it opens.
  private async openDefaultSources() {
    this.openingDefaults = true;
    this.changed();
    try {
      await this.openEachDefault();
    } finally {
      this.openingDefaults = false;
      this.changed();
    }
  }
  private async openEachDefault() {
    await this.devicesRefresh();
    for (const kind of ["video", "audio"] as const) {
      if (this.capture.sources.some((s) => s.kind === kind)) continue;
      const deviceKind = kind === "video" ? "videoinput" : "audioinput";
      if (
        this.devices.length &&
        !this.devices.some((d) => d.kind === deviceKind)
      ) {
        this.sourceErrors[kind] =
          kind === "video"
            ? "Keine Kamera gefunden."
            : "Kein Mikrofon gefunden.";
        continue;
      }
      try {
        const source = await this.capture.addDefault(
          kind,
          this.quality,
          preferredDevice(kind),
        );
        rememberDevice(source);
        delete this.sourceErrors[kind];
      } catch (error) {
        console.warn(`LocalTake: Standard-${kind} nicht geöffnet`, error);
        this.sourceErrors[kind] = mediaError(error);
      }
    }
    await this.devicesRefresh();
    this.invalidate();
  }
  // The host's profile applies to everyone in the room; solo it is a local choice.
  async setQuality(quality: Quality) {
    if (this.room.state && !this.isHost)
      throw new Error("Der Host bestimmt die Aufnahmequalität.");
    if (!this.qualityEditable)
      throw new Error("Qualität erst nach Ende der Aufnahme ändern.");
    if (this.room.state && !this.room.send({ type: "room.quality", quality }))
      throw new Error("Keine Verbindung zum Raum.");
    await this.applyQuality(quality);
  }
  private async applyQuality(quality: Quality) {
    if (quality === this.quality) return;
    this.quality = quality;
    localStorage.setItem("localtake-quality", quality);
    this.invalidate();
    await this.capture.applyQuality(quality);
  }
  // Guests follow the host's profile; it is adopted once no take is running.
  private adoptRoomQuality(state: RoomState | null = this.room.state) {
    if (!state?.quality || state.quality === this.quality) return;
    if (this.isHost) {
      if (!this.groupRecording)
        this.room.send({ type: "room.quality", quality: this.quality });
      return;
    }
    if (this.recording || this.pendingStart) return;
    void this.applyQuality(state.quality).catch((error) => this.report(error));
  }
  async folder() {
    if (!this.folderSupported)
      throw new Error(
        "Dieser Browser bietet keine direkte Ordnerauswahl an. Bitte Desktop-Chrome oder Edge über HTTPS oder localhost verwenden.",
      );
    this.beginStorageChange();
    this.notice = "Aufnahmeordner im Auswahldialog wählen …";
    this.changed();
    let stage = "Ordnerauswahl";
    try {
      const root = await window.showDirectoryPicker({
        mode: "readwrite",
        id: "localtake-recordings",
      });
      this.notice = `Ordner „${root.name}“ gewählt. Schreibzugriff wird geprüft …`;
      this.changed();
      stage = `Schreibtest für „${root.name}“`;
      const store = new LocalStore(root);
      await store.preflight();
      stage = `Merken von „${root.name}“ für den nächsten Besuch`;
      await savedStorage({ kind: "folder", root });
      stage = `Aktivieren von „${root.name}“`;
      this.selectStorage(store, "folder");
      this.notice =
        "Ordner ist beschreibbar. Quellen werden automatisch im Hintergrund geprüft.";
      this.changed();
    } catch (error) {
      this.notice = "";
      this.changed();
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      // AbortError also occurs after a selection or during a write. Preserve the
      // browser's reason and stage instead of interpreting it as user cancellation.
      const alternative =
        stage === "Ordnerauswahl"
          ? " Bitte die Ordnerauswahl in Desktop-Chrome oder Edge verwenden."
          : "";
      throw new Error(`${stage} fehlgeschlagen. ${detail}${alternative}`, {
        cause: error,
      });
    } finally {
      this.endStorageChange();
    }
    await this.scan();
  }
  async useBrowserStorage() {
    if (!BROWSER_STORAGE_ENABLED)
      throw new Error(
        "Browserspeicher ist vorübergehend deaktiviert. Bitte einen Aufnahmeordner in Chrome oder Edge wählen.",
      );
    if (!this.browserStorageSupported)
      throw new Error(
        "Dieser Browser bietet keinen lokalen Browserspeicher an. Desktop-Chrome über HTTPS oder localhost verwenden.",
      );
    this.beginStorageChange();
    this.notice = "Lokalen Browserspeicher öffnen und Schreibzugriff prüfen …";
    this.changed();
    try {
      const status = await browserStorageStatus(navigator.storage, true);
      const store = await openBrowserStorage();
      await savedStorage({ kind: "browser", root: store.root });
      this.selectStorage(store, "browser");
      this.browserStorage = status;
      this.notice =
        "Browserspeicher ist beschreibbar. Quellen werden automatisch geprüft.";
    } catch (error) {
      this.notice = "";
      throw new Error(
        `Browserspeicher konnte nicht geöffnet werden: ${String(error)}`,
        { cause: error },
      );
    } finally {
      this.endStorageChange();
    }
    await this.scan();
  }
  async protectBrowserStorage() {
    if (!BROWSER_STORAGE_ENABLED || this.storageKind !== "browser") return;
    this.beginStorageChange();
    try {
      this.browserStorage = await browserStorageStatus(navigator.storage, true);
      this.notice =
        this.browserStorage.persistent === true
          ? "Der Browser schützt diese Ablage vor automatischem Löschen bei Speicherdruck."
          : "Der Browser hat keinen Löschschutz erteilt. Originale nach der Aufnahme herunterladen.";
    } finally {
      this.endStorageChange();
    }
  }
  async diagnosticStorage() {
    this.assertStorageChange();
    if (!import.meta.env.DEV)
      throw new Error("Diagnoseablage ist nur im Entwicklungsmodus verfügbar.");
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle(`diagnostic-${crypto.randomUUID()}`, { create: true });
    this.testFolders.push(root);
    await this.useDiagnostic(root);
  }
  async reconnectFolder() {
    const root = this.directoryToReconnect;
    if (!root) throw new Error("Kein gespeicherter Aufnahmeordner vorhanden.");
    this.beginStorageChange();
    this.notice = `Schreibfreigabe für „${root.name}“ im Browser bestätigen …`;
    this.changed();
    let stage = `Schreibfreigabe für „${root.name}“`;
    try {
      // Called directly from the button to retain transient user activation.
      const permission = await root.requestPermission({ mode: "readwrite" });
      if (permission !== "granted")
        throw new Error(
          `Der Browser hat keinen Schreibzugriff erteilt (${permission}).`,
        );
      stage = `Schreibtest für „${root.name}“`;
      const store = new LocalStore(root);
      await store.preflight();
      stage = `Aktivieren von „${root.name}“`;
      this.selectStorage(store, "folder");
      this.notice =
        "Ordner ist wieder beschreibbar. Quellen werden automatisch geprüft; ausstehende Uploads werden fortgesetzt.";
      this.changed();
    } catch (error) {
      this.notice = "";
      this.changed();
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      throw new Error(`${stage} fehlgeschlagen. ${detail}`, { cause: error });
    } finally {
      this.endStorageChange();
    }
    await this.scan();
  }
  async useDiagnostic(root: FileSystemDirectoryHandle) {
    if (!import.meta.env.DEV)
      throw new Error("Diagnoseablage nicht verfügbar.");
    this.beginStorageChange();
    try {
      const store = new LocalStore(root);
      await store.preflight();
      await savedStorage({ kind: "diagnostic", root });
      this.selectStorage(store, "diagnostic");
      this.notice =
        "Diagnoseablage im Browser: nur Testdaten, keine sichere Ablage für Originalaufnahmen.";
    } finally {
      this.endStorageChange();
    }
  }
  private beginStorageChange() {
    this.assertStorageChange();
    this.storageChoosing = true;
    this.storageRevision++;
    this.invalidate();
    this.error = "";
    this.publishPresence();
    this.changed();
  }
  private endStorageChange() {
    this.storageChoosing = false;
    this.publishPresence();
    this.changed();
  }
  private assertStorageChange(ownSelection = false) {
    if (
      (this.storageChoosing && !ownSelection) ||
      this.recording ||
      this.probing ||
      this.pendingStart ||
      this.groupActive ||
      this.busy ||
      [...this.transfer.transfers.values()].some((t) =>
        ["transferring", "paused", "verifying"].includes(t.state),
      )
    )
      throw new Error(
        "Aufnahme, Speicherwahl, Archivarbeit oder Übernahme zuerst beenden, bevor die Ablage gewechselt wird.",
      );
  }
  private selectStorage(store: LocalStore, kind: StorageKind) {
    this.assertStorageChange(true);
    this.store = store;
    this.storageWritable = true;
    this.storageKind = kind;
    this.browserStorage = null;
    this.directoryToReconnect = null;
    this.testStorage = kind === "diagnostic";
    this.library = [];
    this.manifests = [];
    this.manifestKeys.clear();
    this.lastRecording = null;
    this.exportPending = false;
    this.archiveError = "";
    for (const file of this.exported) URL.revokeObjectURL(file.url);
    this.exported = [];
    this.invalidate();
  }
  private validate() {
    if (this.storageChoosing)
      throw new Error("Speicherwahl zuerst abschließen.");
    if (!this.store) throw new Error("Zuerst einen lokalen Speicher wählen.");
    if (this.sourcesChanging)
      throw new Error("Gerätewechsel zuerst abschließen.");
    if (!this.sources.length)
      throw new Error("Mindestens eine Aufnahmequelle wählen.");
    if (this.recording || this.pendingStart)
      throw new Error("Eine Aufnahme läuft bereits.");
    if (!isSecureContext)
      throw new Error("Aufnahme benötigt HTTPS oder localhost.");
    if (
      this.sources.some((s) => s.kind !== "audio") &&
      (!("VideoEncoder" in window) || !("MediaStreamTrackProcessor" in window))
    )
      throw new Error(
        "Dieser Browser unterstützt den erforderlichen Video-Aufnahmepfad nicht.",
      );
  }
  probe(): Promise<void> {
    if (this.probeOperation) return this.probeOperation;
    const operation = this.backgroundProbe();
    this.probeOperation = operation;
    return operation.finally(() => {
      this.probeOperation = null;
    });
  }
  private async backgroundProbe() {
    this.validate();
    if (this.groupRecording || this.busy || this.uploadPending) return;
    const revision = this.checkRevision;
    const store = new LocalStore(this.store!.root, "temp");
    const wasReady = this.probePassed;
    this.probing = true;
    this.changed();
    // The check is recorded exactly like a take, so it also proves that the
    // folder's path leaves room for real recordings. It is marked "check",
    // never listed in the archive and removed afterwards.
    const checkId = crypto.randomUUID();
    let started = false;
    let session: RecordingSession | null = null;
    try {
      try {
        await store.preflight();
      } catch (error) {
        this.storageWritable = false;
        throw error;
      }
      this.storageWritable = true;
      started = true;
      session = new RecordingSession(
        store,
        this.capture,
        this.room.clock,
        [...this.sources],
        checkId,
        this.room.credentials?.participantId || this.ownerId,
        this.name.trim() || "Gerätecheck",
        this.quality,
        { purpose: "check" },
      );
      await session.start();
      if (revision === this.checkRevision) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 6000);
          this.cancelProbeDelay = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      await session.stop();
      if (revision !== this.checkRevision) return;
      const inventory = await store.scan(
        session.meta.recordingId,
        session.meta.participantId,
      );
      if (session.status.state !== "saved" || !inventory.complete) {
        const reason =
          session.status.sources
            .filter((s) => s.error)
            .map((s) => `${s.label}: ${s.error}`)
            .join(" · ") || inventory.issues.join(" · ");
        throw new Error(
          `Gerätecheck fehlgeschlagen: ${reason || "Keine vollständigen Medien empfangen."}`,
        );
      }
      this.probePassed = true;
      for (const track of inventory.tracks) {
        const preference = track.settings.encoderAccelerationPreference;
        const source = this.sources.find((s) => s.id === track.trackId);
        if (
          source &&
          (preference === "prefer-hardware" || preference === "prefer-software")
        )
          source.encoderPreference = preference;
      }
      if (!wasReady) this.armed = true;
      this.readinessError = "";
      this.lastProbeAt = Date.now();
      this.nextCheckAt = Date.now() + RECHECK_MS;
    } catch (error) {
      if (revision === this.checkRevision) {
        this.probePassed = false;
        this.armed = false;
        this.readinessError =
          error instanceof Error ? error.message : String(error);
        this.nextCheckAt = Date.now() + 15_000;
        if (
          this.storageKind === "folder" &&
          store.root.queryPermission &&
          (await store.root
            .queryPermission({ mode: "readwrite" })
            .catch(() => "denied")) !== "granted"
        )
          this.directoryToReconnect = store.root;
      }
    } finally {
      await session?.stop().catch(() => undefined);
      this.cancelProbeDelay = null;
      // Only this check's own folder, created under a fresh id, is deleted.
      if (started)
        try {
          await store.removeCheck(checkId, false);
        } catch (error) {
          if ((error as DOMException).name !== "NotFoundError") {
            this.probePassed = false;
            this.armed = false;
            this.readinessError = `Prüfdateien konnten nicht aufgeräumt werden: ${String(error)}`;
          }
        }
      this.probing = false;
      this.publishPresence();
      this.changed();
    }
  }
  private async stopProbe() {
    this.checkRevision++;
    this.cancelProbeDelay?.();
    await this.probeOperation?.catch(() => undefined);
  }
  arm(value: boolean) {
    if (value && !this.probePassed) throw new Error(this.readinessReason);
    this.armed = value;
    this.publishPresence();
    this.changed();
  }
  private publishPresence() {
    const ready = {
      type: "ready",
      ready:
        this.armed &&
        this.probePassed &&
        !this.recording &&
        !this.pendingStart &&
        !this.storageChoosing,
      reason: this.readinessReason.slice(0, 300),
      archiveReady: Boolean(
        this.store &&
        !this.directoryToReconnect &&
        !this.storageChoosing &&
        this.storageWritable &&
        !this.recording &&
        !this.pendingStart &&
        !this.probing,
      ),
    } as const;
    const media = {
      type: "media",
      media: {
        micMuted: this.capture.micMuted,
        camMuted: this.capture.camMuted,
        sharing: Boolean(this.capture.screenTrack),
        livePaused: this.mesh.paused,
      },
    } as const;
    const key = JSON.stringify([ready, media]);
    if (key !== this.presenceSent && this.room.connected) {
      this.room.send(ready);
      this.room.send(media);
      this.presenceSent = key;
    }
  }
  async createRoom() {
    if (!this.name.trim()) throw new Error("Bitte einen Namen eingeben.");
    if (!this.roomName.trim())
      throw new Error("Bitte einen Raumnamen eingeben.");
    this.assertRoomChange();
    this.resetRoomContext();
    await this.room.create(this.name.trim(), this.roomName.trim());
    this.updateRoomLink();
  }
  async joinRoom() {
    if (!this.name.trim()) throw new Error("Bitte einen Namen eingeben.");
    const linked = roomFromLink(
      this.invite === roomFromLink(location.hash).invite
        ? location.hash
        : new URLSearchParams({ invite: this.invite }).toString(),
    );
    if (linked.error) throw new Error(linked.error);
    const previous = linked.roomId ? savedRooms()[linked.roomId] : undefined;
    this.assertRoomChange();
    this.resetRoomContext();
    if (previous) this.room.join(previous.credentials, this.name.trim());
    else
      await this.room.accept(
        linked.invite,
        this.name.trim(),
        linked.roomId || undefined,
      );
    this.updateRoomLink();
    this.invite = "";
  }
  invitation() {
    return this.room.credentials
      ? sessionLink(location.origin, location.pathname, this.room.credentials)
      : location.href;
  }
  private updateRoomLink() {
    if (!this.room.credentials) return;
    history.replaceState(null, "", this.invitation());
    this.invite = "";
    this.changed();
  }
  private assertRoomChange() {
    if (
      this.recording ||
      this.pendingStart ||
      this.groupActive ||
      this.archiveWriting ||
      this.busy ||
      this.storageChoosing
    )
      throw new Error(
        "Raumwechsel wartet auf das Ende der laufenden Aufnahme oder Dateiablage.",
      );
  }
  private resetRoomContext() {
    this.room.leave();
    for (const transfer of this.transfer.transfers.values())
      if (!["done", "error"].includes(transfer.state))
        this.transfer.cancel(transfer.id);
    this.mesh.close();
    this.chat = [];
    this.lastRecording = null;
    this.presenceSent = "";
    this.uploadSent = "";
    this.exportPending = false;
    this.archiveError = "";
    this.error = "";
    this.notice = "";
    this.syncDialog = false;
    this.leaveRequested = false;
    this.showedUpload = false;
    void this.refreshSync().catch((error) => this.report(error));
    this.changed();
  }
  private async restoreLinkedRoom() {
    const hash = location.hash;
    if (this.restoringRoomLink === hash) return;
    const linked = roomFromLink(location.hash);
    if (!linked.error && this.room.credentials?.roomId === linked.roomId) {
      this.roomLinkPending = false;
      this.invite = "";
      return;
    }
    try {
      this.assertRoomChange();
    } catch (error) {
      this.roomLinkPending = true;
      this.notice = (error as Error).message;
      this.changed();
      return;
    }
    this.roomLinkPending = false;
    this.restoringRoomLink = hash;
    try {
      this.resetRoomContext();
      this.invite = linked.invite;
      if (linked.error) throw new Error(linked.error);
      const saved = linked.roomId ? savedRooms()[linked.roomId] : undefined;
      if (saved) {
        this.name = this.name.trim() || saved.name;
        this.room.join(saved.credentials, this.name);
      } else if (linked.invite && this.name.trim()) {
        await this.room.accept(
          linked.invite,
          this.name.trim(),
          linked.roomId || undefined,
        );
      } else if (linked.roomId && !linked.invite) {
        throw new Error(
          "Für diesen Raum ist kein Zugang gespeichert. Bitte den vollständigen Einladungslink öffnen.",
        );
      }
      // A newer navigation invalidates the API request before it can join.
      if (this.room.credentials) this.updateRoomLink();
    } catch (error) {
      if ((error as DOMException)?.name !== "AbortError") this.report(error);
    } finally {
      if (this.restoringRoomLink === hash) this.restoringRoomLink = null;
      this.changed();
    }
  }
  async copyInvite() {
    await navigator.clipboard.writeText(this.invitation());
    this.notice = "Einladungslink kopiert.";
    this.changed();
  }
  async leave(force = false) {
    if (this.uploadPending && !force) {
      this.leaveRequested = true;
      this.syncDialog = true;
      this.changed();
      return;
    }
    await this.stopProbe();
    if (this.recording) await this.stopLocal();
    if (this.uploadPending && !force) {
      this.leaveRequested = true;
      this.syncDialog = true;
      this.changed();
      return;
    }
    clearTimeout(this.startTimer);
    this.pendingStart = false;
    this.room.leave();
    this.mesh.close();
    this.armed = false;
    localStorage.removeItem("localtake-session");
    this.roomLinkPending = false;
    this.leaveRequested = false;
    this.syncDialog = false;
    history.replaceState(null, "", location.pathname);
    await this.refreshSync();
    this.changed();
  }
  async mute(kind: "audio" | "video") {
    const muted =
      kind === "audio" ? !this.capture.micMuted : !this.capture.camMuted;
    this.capture.mute(kind, muted);
    if (this.recording)
      await this.recording.event(
        kind === "audio" ? "mic-mute" : "camera-mute",
        { muted },
      );
  }
  async pauseLive() {
    await this.mesh.pause(!this.mesh.paused);
    this.publishPresence();
    this.changed();
  }
  async screen() {
    await this.capture.screen();
    if (!this.recording) this.invalidate();
  }
  async record() {
    if (this.recording || this.pendingStart || this.groupActive) {
      if (this.isHost && this.room.state?.take)
        this.room.send({
          type: "record.stop",
          commandId: crypto.randomUUID(),
          recordingId: this.room.state.take.id,
        });
      await this.stopLocal();
      return;
    }
    if (this.startBlocked) throw new Error(this.startBlocked);
    await this.stopProbe();
    if (this.room.state) {
      if (!this.isHost)
        throw new Error("Der Host startet die gemeinsame Aufnahme.");
      if (
        !this.room.send({
          type: "record.prepare",
          commandId: crypto.randomUUID(),
        })
      )
        throw new Error("Keine Verbindung zum Koordinationsdienst.");
    } else {
      await this.start(crypto.randomUUID());
    }
  }
  private async message(message: ServerMessage) {
    if (message.type === "error") this.report(message.message);
    if (message.type === "welcome") {
      this.presenceSent = "";
      this.uploadSent = "";
      this.publishPresence();
      if (this.recording || this.lastRecording)
        this.room.send({
          type: "record.status",
          status: (this.recording || this.lastRecording)!.status,
        });
    }
    if (message.type === "room.state" || message.type === "welcome") {
      const take = message.state.take;
      // A participant that was offline when the host stopped still records.
      if (
        this.recording &&
        take?.id === this.recording.meta.recordingId &&
        ["stopping", "done", "cancelled"].includes(take.phase)
      )
        void this.stopLocal().catch((error) => this.report(error));
      this.adoptRoomQuality(message.state);
      this.recordManifest(message.state);
      if (
        this.isDestination &&
        this.library.some(
          (i) =>
            !i.archive &&
            !i.transferredTo &&
            i.recording.roomId === message.state.roomId,
        )
      )
        this.exportPending = true;
      void this.refreshSync().catch((error) => this.report(error));
    }
    if (message.type === "chat") {
      this.chat = [...this.chat, message].slice(-100);
      this.changed();
    }
    if (message.type === "record.prepare") {
      try {
        if (!this.armed)
          throw new Error("Lokale Aufnahme ist nicht freigegeben.");
        await this.stopProbe();
        this.validate();
        await this.store!.preflight();
        this.room.send({
          type: "record.ready",
          recordingId: message.take.id,
          ready: true,
        });
      } catch (error) {
        this.armed = false;
        this.probePassed = false;
        this.storageWritable = false;
        this.readinessError =
          error instanceof Error ? error.message : String(error);
        this.nextCheckAt = Date.now() + 1200;
        this.publishPresence();
        this.room.send({
          type: "record.ready",
          recordingId: message.take.id,
          ready: false,
          reason: String(error).slice(0, 200),
        });
        this.report(error);
      }
    }
    if (message.type === "record.start" && !this.started.has(message.take.id)) {
      this.started.add(message.take.id);
      this.pendingStart = true;
      this.changed();
      const delay = Math.max(
        0,
        Math.min(
          2000,
          this.room.clock.serverToLocal(message.take.startAt!) -
            performance.now(),
        ),
      );
      this.startTimer = setTimeout(() => {
        this.pendingStart = false;
        void this.start(message.take.id).catch((error) => {
          this.armed = false;
          this.probePassed = false;
          this.readinessError =
            error instanceof Error ? error.message : String(error);
          this.nextCheckAt = Date.now() + 15_000;
          this.publishPresence();
          this.report(error);
          this.room.send({
            type: "record.status",
            status:
              this.lastRecording?.meta.recordingId === message.take.id
                ? this.lastRecording.status
                : {
                    recordingId: message.take.id,
                    state: "failed",
                    sources: [],
                  },
          });
        });
      }, delay);
    }
    if (
      message.type === "record.stop" &&
      (this.recording?.meta.recordingId === message.recordingId ||
        (this.pendingStart &&
          this.room.state?.take?.id === message.recordingId))
    )
      await this.stopLocal();
    if (
      message.type === "room.state" &&
      message.state.take?.phase === "cancelled"
    ) {
      clearTimeout(this.startTimer);
      this.pendingStart = false;
      this.notice =
        message.state.take.reason || "Aufnahmevorbereitung abgebrochen.";
      this.changed();
    }
  }
  // The receiving host remembers who took part in each take and their final
  // recording size, so pending uploads stay visible after the room moves on.
  private recordManifest(state: RoomState) {
    const take = state.take;
    const self = this.room.credentials?.participantId;
    if (
      !take ||
      !self ||
      !this.store ||
      this.storageChoosing ||
      state.archiveDestinationId !== self ||
      !take.participants.includes(self) ||
      !["recording", "stopping", "done"].includes(take.phase)
    )
      return;
    const previous = this.manifests.find((m) => m.recordingId === take.id);
    const manifest: SessionManifest = {
      formatVersion: 1,
      recordingId: take.id,
      roomId: state.roomId,
      roomName: state.name,
      startedAt:
        previous?.startedAt ?? take.createdAt ?? new Date().toISOString(),
      participants: take.participants.map((id) => {
        const peer = state.peers.find((p) => p.id === id);
        const before = previous?.participants.find((p) => p.id === id);
        const status =
          peer?.recording?.recordingId === take.id ? peer.recording : null;
        return {
          id,
          name: (peer?.name ?? before?.name ?? "Teilnehmer").slice(0, 60),
          role: peer?.role ?? before?.role ?? "guest",
          state: status?.state ?? before?.state,
          bytes: status
            ? status.sources.reduce((n, s) => n + s.bytes, 0)
            : before?.bytes,
        };
      }),
    };
    // Rewrite only for new participants or final states, not every progress tick.
    const key = JSON.stringify(
      manifest.participants.map((p) => [
        p.id,
        p.name,
        ["saved", "partial", "failed"].includes(p.state ?? "")
          ? [p.state, p.bytes]
          : null,
      ]),
    );
    if (this.manifestKeys.get(take.id) === key) return;
    this.manifestKeys.set(take.id, key);
    this.manifests = [
      ...this.manifests.filter((m) => m.recordingId !== take.id),
      manifest,
    ];
    const store = this.store;
    this.manifestWrites = this.manifestWrites
      .then(() => store.writeSession(manifest))
      .catch((error) =>
        this.report(
          `Sitzungsübersicht konnte nicht gespeichert werden: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    this.changed();
  }
  private async wake() {
    try {
      this.wakeLock = await navigator.wakeLock?.request("screen");
    } catch {
      /* best effort; never represented as recording safety */
    }
  }
  async start(recordingId: string) {
    await this.stopProbe();
    this.validate();
    this.pendingStart = true;
    this.changed();
    const operation = this.begin(recordingId);
    this.initializing = operation;
    try {
      await operation;
    } catch (error) {
      this.armed = false;
      this.probePassed = false;
      this.readinessError =
        error instanceof Error ? error.message : String(error);
      this.nextCheckAt = Date.now() + 15_000;
      this.publishPresence();
      throw error;
    } finally {
      this.initializing = null;
      this.pendingStart = false;
      this.changed();
    }
  }
  private async begin(recordingId: string) {
    await this.store!.preflight();
    const session = new RecordingSession(
      this.store!,
      this.capture,
      this.room.clock,
      [...this.sources],
      recordingId,
      this.room.credentials?.participantId || this.ownerId,
      this.name.trim() || "Lokale Aufnahme",
      this.quality,
      {
        roomId: this.room.credentials?.roomId,
        sessionName:
          this.room.state?.name || this.roomName.trim() || "Lokale-Aufnahmen",
        sessionStartedAt:
          this.room.state?.take?.id === recordingId
            ? this.room.state.take.createdAt
            : undefined,
        purpose: "recording",
      },
    );
    this.recording = session;
    this.diagnostics.record("recorder", "starting", {
      recordingId,
      sources: session.meta.trackIds,
      quality: this.quality,
    });
    this.armed = false;
    this.publishPresence();
    this.changed();
    let lastSent = 0;
    session.addEventListener("change", () => {
      this.changed();
      if (
        performance.now() - lastSent >= 1000 ||
        ["saved", "partial", "failed"].includes(session.status.state)
      ) {
        this.room.send({ type: "record.status", status: session.status });
        lastSent = performance.now();
      }
    });
    session.addEventListener("error", (event) =>
      this.report((event as CustomEvent).detail),
    );
    try {
      await session.start();
      this.diagnostics.record("recorder", "started", { recordingId });
      await this.wake();
    } catch (error) {
      this.lastRecording = session;
      this.recording = null;
      this.armed = false;
      this.probePassed = false;
      this.readinessError = `Aufnahmestart fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`;
      this.nextCheckAt = Date.now() + 15_000;
      await this.wakeLock?.release().catch(() => undefined);
      this.wakeLock = null;
      await this.scan().catch((scanError) => this.report(scanError));
      this.exportPending = Boolean(
        this.room.credentials &&
        this.archiveDestinationId === this.room.credentials.participantId,
      );
      this.publishPresence();
      if (this.uploadPending) this.syncDialog = true;
      this.changed();
      throw error;
    }
  }
  async stopLocal() {
    if (this.stoppingLocal) return this.stoppingLocal;
    const operation = this.finalizeLocal();
    this.stoppingLocal = operation;
    try {
      await operation;
    } finally {
      this.stoppingLocal = null;
    }
  }
  private async finalizeLocal() {
    clearTimeout(this.startTimer);
    this.pendingStart = false;
    await this.initializing?.catch(() => undefined);
    const session = this.recording;
    if (session) {
      this.diagnostics.record("recorder", "stopping", {
        recordingId: session.meta.recordingId,
      });
      await session.stop();
      this.diagnostics.record("recorder", "finished", session.status);
      this.lastRecording = session;
      this.recording = null;
      this.armed = this.probePassed && session.status.state === "saved";
      if (session.status.state !== "saved") this.probePassed = false;
      await this.wakeLock?.release().catch(() => undefined);
      this.wakeLock = null;
      this.notice =
        session.status.state !== "saved"
          ? "Aufnahme enthält Fehler. Gesicherte Spuren bleiben erhalten; bitte das Archiv prüfen."
          : !this.room.credentials
            ? "Aufnahme lokal gesichert."
            : this.isDestination
              ? "Aufnahme lokal gesichert. Die Originale der Gäste werden automatisch hier gesammelt."
              : `Aufnahme lokal gesichert. Die Originale werden automatisch an ${this.archiveDestination?.name || "den Host"} gesendet.`;
      await this.scan();
      this.nextCheckAt = Date.now() + (this.probePassed ? RECHECK_MS : 1200);
      this.exportPending = this.isDestination;
      this.archiveError = "";
      if (this.uploadPending) this.syncDialog = true;
    }
    this.adoptRoomQuality();
    this.publishPresence();
    this.changed();
  }
  async scan() {
    if (this.storageChoosing)
      throw new Error("Speicherwahl zuerst abschließen.");
    if (!this.store) throw new Error("Zuerst den lokalen Speicher öffnen.");
    if (this.recording)
      throw new Error("Archivprüfung erst nach Ende der Aufnahme starten.");
    const store = this.store;
    this.busy = "Archiv und Prüfsummen prüfen …";
    this.changed();
    try {
      await store.housekeeping();
      this.lastHousekeepingAt = Date.now();
      const library = await store.list();
      const manifests = await store.sessions();
      if (this.store === store) {
        this.library = library;
        if (
          this.isDestination &&
          library.some(
            (i) =>
              !i.archive &&
              !i.transferredTo &&
              i.recording.roomId === this.room.state?.roomId,
          )
        )
          this.exportPending = true;
        // Keep manifests written meanwhile for takes the scan has not seen yet.
        this.manifests = [
          ...manifests,
          ...this.manifests.filter(
            (m) =>
              Date.now() - Date.parse(m.startedAt) < LOCAL_RETENTION_MS &&
              !manifests.some((n) => n.recordingId === m.recordingId),
          ),
        ];
        if (this.storageKind === "browser")
          this.browserStorage = await browserStorageStatus();
        if (store.scanIssues.length) this.report(store.scanIssues.join("\n"));
        await this.refreshSync(true);
      }
    } finally {
      this.busy = "";
      this.changed();
    }
  }
  async export(inventory: Inventory) {
    await this.exportAll({ recordingId: inventory.recording.recordingId });
  }
  private async refreshSync(force = false) {
    const key = `${this.room.credentials?.roomId}/${this.room.credentials?.participantId}/${this.archiveDestinationId}/${this.storageRevision}`;
    if (!force && key === this.lastSyncContext) return;
    this.lastSyncContext = key;
    if (this.syncRefreshing) {
      this.syncRefreshAgain = true;
      return;
    }
    this.syncRefreshing = true;
    try {
      do {
        this.syncRefreshAgain = false;
        await this.sync.refresh();
      } while (this.syncRefreshAgain);
    } finally {
      this.syncRefreshing = false;
    }
  }
  private async maintain() {
    if (this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    try {
      if (this.store && !this.storageChoosing && !this.recording)
        void this.ensureDefaultSources().catch((error) => this.report(error));
      if (
        this.store &&
        !this.recording &&
        !this.probing &&
        !this.busy &&
        Date.now() - this.lastPermissionCheck > 10_000
      ) {
        this.lastPermissionCheck = Date.now();
        if (
          this.storageKind === "folder" &&
          this.store.root.queryPermission &&
          (await this.store.root
            .queryPermission({ mode: "readwrite" })
            .catch(() => "denied")) !== "granted"
        ) {
          this.storageWritable = false;
          this.directoryToReconnect = this.store.root;
          this.probePassed = false;
          this.armed = false;
          this.readinessError = `Speicherordner „${this.store.root.name}“ ist nicht freigegeben. Bitte „Ordner freigeben“ bestätigen.`;
          this.changed();
        } else if (!this.storageWritable && !this.directoryToReconnect) {
          try {
            await this.store.preflight();
            this.storageWritable = true;
            this.nextCheckAt = 0;
          } catch (error) {
            this.readinessError =
              error instanceof Error ? error.message : String(error);
          }
        }
      }
      await this.sync.tick();
      if (
        this.store &&
        !this.recording &&
        !this.pendingStart &&
        !this.probing &&
        !this.groupRecording &&
        !this.busy &&
        !this.storageChoosing &&
        Date.now() - this.lastHousekeepingAt > 60_000
      ) {
        const changed = await this.store.housekeeping();
        this.lastHousekeepingAt = Date.now();
        if (changed) await this.scan();
      }
      if (
        this.exportPending &&
        this.store &&
        !this.recording &&
        !this.pendingStart &&
        !this.groupRecording &&
        !this.probing &&
        !this.busy &&
        !this.storageChoosing &&
        ![...this.transfer.transfers.values()].some(
          (t) =>
            t.direction === "receive" &&
            ["transferring", "paused", "verifying"].includes(t.state),
        )
      ) {
        if (this.isDestination) {
          this.archiveWriting = true;
          try {
            await this.exportAll(
              { roomId: this.room.credentials!.roomId },
              true,
            );
            this.exportPending = false;
          } catch (error) {
            this.exportPending = false;
            this.archiveError = `Originale sind lokal erhalten. Sitzungsordner konnte nicht fertiggestellt werden: ${String(error)}`;
            this.report(this.archiveError);
          } finally {
            this.archiveWriting = false;
          }
        } else this.exportPending = false;
      }
      if (
        this.store &&
        this.storageWritable &&
        this.sources.length &&
        !this.directoryToReconnect &&
        !this.recording &&
        !this.pendingStart &&
        !this.probing &&
        !this.groupRecording &&
        !this.busy &&
        !this.storageChoosing &&
        !this.sourcesChanging &&
        !this.uploadPending &&
        Date.now() >= this.nextCheckAt
      ) {
        this.nextCheckAt = Date.now() + 15_000;
        void this.probe().catch((error) => {
          this.readinessError =
            error instanceof Error ? error.message : String(error);
          this.publishPresence();
          this.changed();
        });
      }
      this.publishPresence();
      const upload = this.sync.status;
      const key = JSON.stringify(upload);
      if (this.room.connected && key !== this.uploadSent) {
        this.room.send({ type: "archive.status", status: upload });
        this.uploadSent = key;
      }
      const pendingUpload = Boolean(
        this.uploadPending &&
        !this.recording &&
        !this.pendingStart &&
        !this.groupRecording,
      );
      if (pendingUpload && !this.showedUpload) this.syncDialog = true;
      this.showedUpload = pendingUpload;
      if (this.uploadPending || this.recording || this.syncDialog)
        this.changed();
      if (this.roomLinkPending) await this.restoreLinkedRoom();
    } catch (error) {
      this.report(error);
    } finally {
      this.maintenanceRunning = false;
    }
  }
  // One folder per session (take), collecting every participant's originals.
  async exportAll(
    scope: { roomId?: string; recordingId?: string } = {},
    automatic = false,
  ) {
    if (!this.store || this.recording || this.storageChoosing || this.busy)
      throw new Error(
        "Sitzungsexport erst nach der Aufnahme und Archivprüfung möglich.",
      );
    const inventories = this.library.filter(
      (i) =>
        i.recording.purpose !== "check" &&
        i.segments.length &&
        (!scope.roomId || i.recording.roomId === scope.roomId) &&
        (!scope.recordingId || i.recording.recordingId === scope.recordingId),
    );
    if (!inventories.length) return;
    this.busy = "Sitzungsordner fertigstellen …";
    this.changed();
    try {
      const { exportSession } = await import("../export/exporter.js");
      const groups = new Map<string, Inventory[]>();
      for (const inventory of inventories) {
        const id = inventory.recording.recordingId;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id)!.push(inventory);
      }
      if (!automatic) {
        for (const file of this.exported) URL.revokeObjectURL(file.url);
        this.exported = [];
      }
      const folders = [];
      for (const group of groups.values()) {
        const folder = await exportSession(
          this.store,
          group,
          this.store.root,
          (text) => {
            this.busy = text;
            this.changed();
          },
          true,
          group[0].recording.roomId === this.room.state?.roomId
            ? this.room.state?.name
            : undefined,
        );
        folders.push(folder.name);
        if (!automatic) await this.collectExportFiles(folder, folder.name);
      }
      this.notice = `Sitzung${folders.length > 1 ? "en" : ""} im Aufnahmeordner gesichert: ${folders.join(", ")}. Alle MP4- und WAV-Spuren liegen gemeinsam im Raum/Aufnahme-Ordner, Metadaten unter „metadata“.`;
      if (this.error === this.archiveError) this.error = "";
      this.archiveError = "";
      this.library = await this.store.list(false);
      await this.refreshSync(true);
    } finally {
      this.busy = "";
      this.changed();
    }
  }
  retryArchive() {
    if (this.error === this.archiveError) this.error = "";
    this.archiveError = "";
    this.exportPending = true;
    this.changed();
  }
  private async collectExportFiles(
    folder: FileSystemDirectoryHandle,
    prefix = "",
  ) {
    for await (const entry of folder.values()) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "directory")
        await this.collectExportFiles(entry as FileSystemDirectoryHandle, name);
      else {
        const file = await retrying(
          async () => (await folder.getFileHandle(entry.name)).getFile(),
          `Exportdatei ${entry.name} lesen`,
        );
        this.exported.push({
          name,
          url: URL.createObjectURL(file),
          size: file.size,
        });
      }
    }
  }
}
export const studio = new StudioRuntime();
