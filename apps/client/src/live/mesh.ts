import type {
  IceServer,
  Peer,
  ServerMessage,
} from "../../../../packages/protocol/src/index.js";
import type { CaptureManager } from "../capture/manager.js";
import type { RoomClient } from "../room/client.js";
import { summarizeRtc } from "./statistics.js";

export type Remote = {
  id: string;
  peer: Peer;
  linkId: string | null;
  pc: RTCPeerConnection;
  stream: MediaStream;
  screen: MediaStream;
  control: RTCDataChannel | null;
  files: RTCDataChannel | null;
  connection: RTCPeerConnectionState;
  stats: { bitrate: number; rtt: number; quality: number };
  telemetryStats?: ReturnType<typeof summarizeRtc>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  candidates: RTCIceCandidateInit[];
  senders: Partial<Record<"audio" | "video" | "screen", RTCRtpSender>>;
  lastBytes: number;
  lastTime: number;
  lastAdapt: number;
  restartTimer?: ReturnType<typeof setTimeout>;
  connectTimer?: ReturnType<typeof setTimeout>;
  channelTimer?: ReturnType<typeof setTimeout>;
  connectionIssue?: string;
};
export class LiveMesh extends EventTarget {
  remotes = new Map<string, Remote>();
  paused = false;
  private iceServers: IceServer[] = [];
  private iceTransportPolicy: RTCIceTransportPolicy = "all";
  private localConnectionId?: string;
  private updating = Promise.resolve();
  private signaling = Promise.resolve();
  private retiredLinks = new Set<string>();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    readonly room: RoomClient,
    readonly capture: CaptureManager,
  ) {
    super();
    room.addEventListener("message", (event) => {
      const credentials = room.credentials;
      this.signaling = this.signaling
        .then(() => {
          if (room.credentials === credentials)
            return this.message((event as CustomEvent<ServerMessage>).detail);
        })
        .catch((error) => this.error(error));
    });
    capture.addEventListener("change", () => {
      this.updating = this.updating
        .then(() => this.refresh())
        .catch((error) => this.error(error));
    });
    this.timer = setInterval(() => {
      for (const remote of this.remotes.values())
        void this.stats(remote).catch(() => undefined);
    }, 2500);
  }
  private changed() {
    this.dispatchEvent(new Event("change"));
  }
  private diagnostic(event: string, remote?: Remote, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent("diagnostic", {
        detail: {
          event,
          detail: { peerId: remote?.id, linkId: remote?.linkId, data: detail },
        },
      }),
    );
  }
  diagnosticIceServers() {
    return this.iceServers.map((server) => ({
      urls: server.urls,
      credentialsConfigured: Boolean(server.username && server.credential),
    }));
  }
  diagnosticIceTransportPolicy() {
    return this.iceTransportPolicy;
  }
  private error(error: unknown) {
    this.dispatchEvent(
      new CustomEvent("error", {
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  private async message(message: ServerMessage) {
    if (message.type === "welcome") {
      const connectionId = message.state.peers.find(
        (peer) => peer.id === message.participantId,
      )?.connectionId;
      // An offer sent before a signaling reconnect may never have reached its
      // recipient. Recreate both ends instead of keeping an unanswered offer.
      if (
        this.localConnectionId &&
        connectionId &&
        connectionId !== this.localConnectionId
      )
        for (const remote of this.remotes.values()) this.remove(remote);
      this.localConnectionId = connectionId;
      this.iceServers = message.iceServers;
      this.iceTransportPolicy = message.iceTransportPolicy ?? "all";
      for (const remote of this.remotes.values())
        remote.pc.setConfiguration({
          iceServers: this.iceServers,
          iceTransportPolicy: this.iceTransportPolicy,
        });
    }
    if (message.type === "room.state" || message.type === "welcome") {
      const peers = new Map(message.state.peers.map((peer) => [peer.id, peer]));
      for (const remote of this.remotes.values()) {
        const peer = peers.get(remote.id);
        if (
          !peer?.connected ||
          (peer.connectionId && peer.connectionId !== remote.peer.connectionId)
        )
          this.remove(remote);
      }
      for (const peer of message.state.peers) {
        if (peer.id === this.room.credentials?.participantId) continue;
        const remote = this.remotes.get(peer.id);
        if (remote) remote.peer = peer;
        else if (peer.connected) await this.add(peer);
      }
      this.changed();
    }
    if (message.type === "peer.signal") {
      if (message.linkId && this.retiredLinks.has(message.linkId)) {
        this.diagnostic("signal.ignored_retired_link", undefined, {
          from: message.from,
          linkId: message.linkId,
        });
        return;
      }
      const peer = this.room.state?.peers.find((p) => p.id === message.from);
      if (
        !peer?.connected ||
        (message.connectionId && message.connectionId !== peer.connectionId)
      ) {
        this.diagnostic("signal.ignored_old_connection", undefined, {
          from: message.from,
          connectionId: message.connectionId,
        });
        return;
      }
      let remote = this.remotes.get(message.from);
      if (!remote) {
        remote = await this.add(peer);
      }
      this.diagnostic("signal.received", remote, {
        description: message.description?.type,
        candidate: message.candidate,
        restart: message.restart,
      });
      if (message.restart) {
        if (!message.linkId || message.linkId === remote.linkId)
          this.rebuild(remote);
        return;
      }
      if (message.linkId && message.linkId !== remote.linkId) {
        if (remote.linkId && message.description?.type !== "offer") return;
        if (remote.linkId) {
          this.remove(remote);
          remote = await this.add(peer);
        }
        remote.linkId = message.linkId;
      }
      const { pc } = remote;
      const polite = this.room.credentials!.participantId > message.from;
      if (message.description) {
        const readyForOffer =
          !remote.makingOffer &&
          (pc.signalingState === "stable" || remote.settingAnswer);
        const collision =
          message.description.type === "offer" && !readyForOffer;
        remote.ignoreOffer = !polite && collision;
        if (remote.ignoreOffer) {
          this.diagnostic("offer.ignored_collision", remote);
          return;
        }
        remote.settingAnswer = message.description.type === "answer";
        try {
          await pc.setRemoteDescription(message.description);
        } finally {
          remote.settingAnswer = false;
        }
        for (const candidate of remote.candidates.splice(0))
          await pc.addIceCandidate(candidate);
        if (message.description.type === "offer") {
          const slots = pc.getTransceivers();
          if (
            slots.length !== 3 ||
            slots[0].receiver.track.kind !== "audio" ||
            slots.slice(1).some((t) => t.receiver.track.kind !== "video")
          )
            throw new Error("Unerwartete Medienzuordnung der Gegenstelle.");
          for (const [index, kind] of (
            ["audio", "video", "screen"] as const
          ).entries()) {
            slots[index].direction = "sendrecv";
            remote.senders[kind] = slots[index].sender;
          }
          await this.update(remote);
          await pc.setLocalDescription();
          this.signal(remote);
        }
      } else if (message.candidate) {
        try {
          if (pc.remoteDescription) await pc.addIceCandidate(message.candidate);
          else if (remote.candidates.length < 128)
            remote.candidates.push(message.candidate);
        } catch (error) {
          if (!remote.ignoreOffer) throw error;
        }
      }
    }
  }
  private signal(remote: Remote) {
    if (this.remotes.get(remote.id) !== remote) return;
    const description = remote.pc.localDescription;
    if (
      description &&
      (description.type === "offer" || description.type === "answer")
    ) {
      const sent = this.room.send({
        type: "peer.signal",
        to: remote.id,
        linkId: remote.linkId || undefined,
        description: { type: description.type, sdp: description.sdp },
      });
      this.diagnostic("description.sent", remote, {
        type: description.type,
        sent,
      });
    }
  }
  private async add(peer: Peer): Promise<Remote> {
    const existing = this.remotes.get(peer.id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: this.iceTransportPolicy,
      bundlePolicy: "max-bundle",
    });
    const senders: Remote["senders"] = {};
    if (this.room.credentials!.participantId < peer.id) {
      senders.audio = pc.addTransceiver("audio", {
        direction: "sendrecv",
      }).sender;
      senders.video = pc.addTransceiver("video", {
        direction: "sendrecv",
        sendEncodings: [{ maxBitrate: 2_500_000, maxFramerate: 30 }],
      }).sender;
      senders.screen = pc.addTransceiver("video", {
        direction: "sendrecv",
        sendEncodings: [{ maxBitrate: 1_500_000, maxFramerate: 15 }],
      }).sender;
    }
    const remote: Remote = {
      id: peer.id,
      peer,
      linkId:
        this.room.credentials!.participantId < peer.id
          ? crypto.randomUUID()
          : null,
      pc,
      stream: new MediaStream(),
      screen: new MediaStream(),
      control: null,
      files: null,
      connection: "new",
      stats: { bitrate: 0, rtt: 0, quality: 0 },
      makingOffer: false,
      ignoreOffer: false,
      settingAnswer: false,
      candidates: [],
      senders,
      lastBytes: 0,
      lastTime: 0,
      lastAdapt: 0,
    };
    this.remotes.set(peer.id, remote);
    this.diagnostic("connection.created", remote, {
      offerer: this.room.credentials!.participantId < peer.id,
    });
    this.watchConnection(remote);
    pc.oniceconnectionstatechange = () => {
      this.diagnostic("ice.state", remote, { state: pc.iceConnectionState });
      this.changed();
    };
    pc.onicegatheringstatechange = () => {
      this.diagnostic("ice.gathering", remote, { state: pc.iceGatheringState });
      this.changed();
    };
    pc.onsignalingstatechange = () => {
      this.diagnostic("signaling.state", remote, { state: pc.signalingState });
      this.changed();
    };
    pc.onicecandidateerror = (event) => {
      this.diagnostic("ice.candidate_error", remote, {
        url: event.url,
        address: event.address,
        port: event.port,
        code: event.errorCode,
        message: event.errorText,
      });
    };
    pc.onnegotiationneeded = async () => {
      // One side creates the three media slots; the answerer adopts the offered slots.
      // Keep perfect negotiation below for later ICE restarts and simultaneous changes.
      if (
        !pc.remoteDescription &&
        this.room.credentials!.participantId > peer.id
      )
        return;
      try {
        remote.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(remote);
      } catch (error) {
        if (pc.signalingState !== "closed") this.error(error);
      } finally {
        remote.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      this.diagnostic(
        candidate ? "ice.local_candidate" : "ice.gathering_complete",
        remote,
        candidate?.toJSON(),
      );
      if (candidate && this.remotes.get(peer.id) === remote)
        this.room.send({
          type: "peer.signal",
          to: peer.id,
          linkId: remote.linkId || undefined,
          candidate: { ...candidate.toJSON(), candidate: candidate.candidate },
        });
    };
    pc.ontrack = ({ track, transceiver }) => {
      const index = pc.getTransceivers().indexOf(transceiver);
      const stream =
        index === 2 && track.kind === "video" ? remote.screen : remote.stream;
      for (const previous of stream
        .getTracks()
        .filter((t) => t.kind === track.kind))
        stream.removeTrack(previous);
      stream.addTrack(track);
      track.onunmute = () => this.changed();
      track.onmute = () => this.changed();
      this.changed();
    };
    pc.onconnectionstatechange = () => {
      this.diagnostic("connection.state", remote, {
        state: pc.connectionState,
      });
      remote.connection = pc.connectionState;
      this.changed();
      clearTimeout(remote.restartTimer);
      if (pc.connectionState === "connected") {
        clearTimeout(remote.connectTimer);
        remote.connectionIssue = undefined;
        this.changed();
      }
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected"
      )
        remote.restartTimer = setTimeout(() => {
          if (!this.room.connected || pc.signalingState === "closed") return;
          if (pc.connectionState === "failed") this.rebuild(remote);
          else pc.restartIce();
        }, 3000);
    };
    const channel = (dc: RTCDataChannel) => {
      dc.binaryType = "arraybuffer";
      if (dc.label === "localtake-control") remote.control = dc;
      else if (dc.label === "localtake-files") remote.files = dc;
      else {
        dc.close();
        return;
      }
      dc.onopen = () => {
        this.diagnostic("channel.open", remote, { label: dc.label });
        this.changed();
        this.dispatchEvent(new CustomEvent("channels", { detail: remote }));
      };
      dc.onclose = () => {
        this.diagnostic("channel.closed", remote, { label: dc.label });
        this.changed();
        clearTimeout(remote.channelTimer);
        if (this.remotes.get(remote.id) === remote)
          remote.channelTimer = setTimeout(() => this.rebuild(remote), 1000);
      };
      dc.onerror = () => {
        this.diagnostic("channel.error", remote, { label: dc.label });
        this.changed();
      };
      this.dispatchEvent(
        new CustomEvent("channel", { detail: { remote, channel: dc } }),
      );
    };
    pc.ondatachannel = (event) => channel(event.channel);
    if (this.room.credentials!.participantId < peer.id) {
      channel(pc.createDataChannel("localtake-control", { ordered: true }));
      channel(pc.createDataChannel("localtake-files", { ordered: true }));
    }
    await this.update(remote);
    return remote;
  }
  private async update(remote: Remote) {
    await remote.senders.audio?.replaceTrack(
      this.paused ? null : this.capture.audioTrack,
    );
    await remote.senders.video?.replaceTrack(
      this.paused ? null : this.capture.cameraTrack,
    );
    await remote.senders.screen?.replaceTrack(
      this.paused ? null : this.capture.screenTrack,
    );
    await this.parameters(remote);
  }
  async refresh() {
    for (const remote of this.remotes.values())
      if (remote.pc.signalingState !== "closed") await this.update(remote);
    this.changed();
  }
  async pause(paused: boolean) {
    this.paused = paused;
    await this.refresh();
  }
  private watchConnection(remote: Remote) {
    clearTimeout(remote.connectTimer);
    remote.connectTimer = setTimeout(() => {
      if (
        remote.pc.connectionState === "connected" ||
        remote.pc.connectionState === "closed"
      )
        return;
      remote.connectionIssue =
        "Liveverbindung fehlt. Netzwerk und STUN/TURN-Konfiguration prüfen. Lokale Aufnahmen funktionieren unabhängig davon.";
      this.diagnostic("connection.timeout", remote, {
        connection: remote.pc.connectionState,
        ice: remote.pc.iceConnectionState,
        signaling: remote.pc.signalingState,
        localDescription: remote.pc.localDescription?.type,
        remoteDescription: remote.pc.remoteDescription?.type,
      });
      this.changed();
    }, 15_000);
  }
  retry() {
    this.diagnostic("retry.requested");
    for (const remote of [...this.remotes.values()])
      if (remote.pc.connectionState !== "closed") {
        remote.connectionIssue = undefined;
        if (this.room.credentials!.participantId < remote.id)
          this.rebuild(remote);
        else {
          // restartIce cannot recover a missing initial offer or answer. Ask
          // the designated offerer to create a fresh link, from either side.
          this.room.send({
            type: "peer.signal",
            to: remote.id,
            linkId: remote.linkId || undefined,
            restart: true,
          });
          this.watchConnection(remote);
        }
      }
    this.changed();
  }
  private async parameters(remote: Remote) {
    const quality = remote.stats.quality;
    for (const kind of ["audio", "video", "screen"] as const) {
      const sender = remote.senders[kind];
      if (!sender?.track) continue;
      const p = sender.getParameters();
      if (!p.encodings.length) continue;
      if (kind === "audio")
        p.encodings[0].maxBitrate = quality >= 2 ? 48_000 : 96_000;
      else {
        p.encodings[0].maxBitrate =
          kind === "video"
            ? [2_500_000, 1_500_000, 800_000, 400_000][quality]
            : [1_500_000, 700_000, 350_000, 200_000][quality];
        p.encodings[0].maxFramerate =
          kind === "video" ? (quality === 3 ? 20 : 30) : [15, 8, 4, 2][quality];
        p.encodings[0].scaleResolutionDownBy = Math.max(
          1,
          (sender.track.getSettings().width || 1280) /
            (kind === "video" ? [1280, 960, 640, 480][quality] : 1920),
        );
        p.degradationPreference =
          kind === "video" ? "maintain-framerate" : "maintain-resolution";
      }
      try {
        await sender.setParameters(p);
      } catch (error) {
        this.error(
          `Liveprofil: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  private async stats(remote: Remote) {
    if (remote.pc.connectionState !== "connected") return;
    const report = await remote.pc.getStats();
    remote.telemetryStats = summarizeRtc(report);
    let bytes = 0,
      rtt = 0,
      available = Infinity;
    report.forEach((stat) => {
      if (stat.type === "outbound-rtp") bytes += stat.bytesSent || 0;
      if (
        stat.type === "candidate-pair" &&
        stat.state === "succeeded" &&
        stat.nominated
      ) {
        rtt = (stat.currentRoundTripTime || 0) * 1000;
        available = stat.availableOutgoingBitrate ?? Infinity;
      }
    });
    const now = performance.now();
    if (remote.lastTime)
      remote.stats.bitrate = Math.max(
        0,
        ((bytes - remote.lastBytes) * 8) / ((now - remote.lastTime) / 1000),
      );
    remote.lastBytes = bytes;
    remote.lastTime = now;
    remote.stats.rtt = rtt;
    if (now - remote.lastAdapt > 7500) {
      const before = remote.stats.quality;
      const target =
        available < 600_000 || rtt > 500
          ? 3
          : available < 1_200_000 || rtt > 300
            ? 2
            : available < 2_300_000 || rtt > 180
              ? 1
              : 0;
      remote.stats.quality += Math.sign(target - remote.stats.quality);
      if (before !== remote.stats.quality) {
        remote.lastAdapt = now;
        await this.parameters(remote);
      }
    }
    this.changed();
  }
  close() {
    for (const remote of this.remotes.values()) this.remove(remote);
    this.localConnectionId = undefined;
    this.changed();
  }
  private remove(remote: Remote) {
    this.diagnostic("connection.removed", remote);
    if (remote.linkId) {
      this.retiredLinks.add(remote.linkId);
      if (this.retiredLinks.size > 128)
        this.retiredLinks.delete(this.retiredLinks.values().next().value!);
    }
    clearTimeout(remote.restartTimer);
    clearTimeout(remote.connectTimer);
    clearTimeout(remote.channelTimer);
    this.remotes.delete(remote.id);
    remote.pc.onconnectionstatechange = null;
    remote.pc.onnegotiationneeded = null;
    remote.pc.onicecandidate = null;
    remote.pc.close();
  }
  private rebuild(remote: Remote) {
    if (
      this.remotes.get(remote.id) !== remote ||
      !this.room.connected ||
      !remote.peer.connected ||
      this.room.credentials!.participantId > remote.id
    )
      return;
    this.remove(remote);
    void this.add(remote.peer)
      .then(() => this.changed())
      .catch((error) => this.error(error));
  }
  dispose() {
    clearInterval(this.timer);
    this.close();
  }
}
