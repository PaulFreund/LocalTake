import { afterEach, expect, it, vi } from "vitest";
import { LiveMesh } from "../apps/client/src/live/mesh.js";
import type { CaptureManager } from "../apps/client/src/capture/manager.js";
import type { RoomClient } from "../apps/client/src/room/client.js";
import type { Peer, RoomState } from "../packages/protocol/src/index.js";

const selfId = "ffffffff-ffff-4fff-afff-ffffffffffff";
const peer: Peer = {
  id: "00000000-0000-4000-a000-000000000001",
  name: "Sender",
  role: "guest",
  connected: true,
  connectionId: "first-connection",
  ready: false,
  recording: null,
  media: {
    micMuted: false,
    camMuted: false,
    sharing: false,
    livePaused: false,
  },
};
class Connection {
  constructor(readonly configuration: RTCConfiguration) {}
  signalingState = "stable";
  connectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  restartIce = vi.fn();
  setConfiguration = vi.fn();
  private nextSlot = 0;
  slots = ["audio", "video", "video"].map((kind) => ({
    receiver: { track: { kind } },
    sender: { replaceTrack: async () => {}, track: null },
  }));
  getTransceivers() {
    return this.slots;
  }
  addTransceiver() {
    return this.slots[this.nextSlot++];
  }
  createDataChannel(label: string) {
    return { label, close() {} };
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
  }
  async setLocalDescription() {
    this.localDescription = { type: "answer", sdp: "answer" };
  }
  close() {
    this.signalingState = "closed";
    this.connectionState = "closed";
  }
}
let mesh: LiveMesh;
afterEach(() => {
  mesh?.dispose();
  vi.unstubAllGlobals();
});

function connectionFixture(participantId = selfId) {
  vi.stubGlobal("RTCPeerConnection", Connection);
  vi.stubGlobal("MediaStream", class {});
  const room = Object.assign(new EventTarget(), {
    credentials: { participantId },
    connected: true,
    state: { roomId: "test-room", peers: [peer], take: null },
    send: vi.fn(),
  });
  mesh = new LiveMesh(
    room as unknown as RoomClient,
    new EventTarget() as CaptureManager,
  );
  const publish = (detail: unknown) =>
    room.dispatchEvent(new CustomEvent("message", { detail }));
  publish({ type: "room.state", state: room.state });
  return { room, publish };
}

it("recreates an unanswered initial offer when the offerer retries", async () => {
  connectionFixture("00000000-0000-4000-a000-000000000000");
  await vi.waitFor(() => expect(mesh.remotes.size).toBe(1));
  const previous = mesh.remotes.get(peer.id)!;
  (previous.pc as unknown as Connection).signalingState = "have-local-offer";
  mesh.retry();
  await vi.waitFor(() => expect(mesh.remotes.get(peer.id)).not.toBe(previous));
  expect(previous.pc.signalingState).toBe("closed");
  expect(mesh.remotes.get(peer.id)?.linkId).not.toBe(previous.linkId);
});

it("drops queued signaling from a room that was left before processing", async () => {
  const { room, publish } = connectionFixture();
  room.credentials = { participantId: crypto.randomUUID() };
  room.state = { ...room.state, roomId: "new-room", peers: [] };
  publish({ type: "room.state", state: room.state });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(mesh.remotes.size).toBe(0);
});

it("forces relay routes from welcome and preserves the policy when rebuilding", async () => {
  const { room, publish } = connectionFixture(
    "00000000-0000-4000-a000-000000000000",
  );
  await vi.waitFor(() => expect(mesh.remotes.size).toBe(1));
  const iceServers = [
    {
      urls: "turn:relay.example.test:3478",
      username: "test",
      credential: "private",
    },
  ];
  publish({
    type: "welcome",
    participantId: room.credentials.participantId,
    iceServers,
    iceTransportPolicy: "relay",
    state: room.state,
  });
  await vi.waitFor(() =>
    expect(mesh.diagnosticIceTransportPolicy()).toBe("relay"),
  );
  expect(mesh.remotes.get(peer.id)!.pc.setConfiguration).toHaveBeenCalledWith({
    iceServers,
    iceTransportPolicy: "relay",
  });
  mesh.retry();
  await vi.waitFor(() =>
    expect(
      (mesh.remotes.get(peer.id)!.pc as unknown as Connection).configuration
        .iceTransportPolicy,
    ).toBe("relay"),
  );
  publish({
    type: "welcome",
    participantId: room.credentials.participantId,
    iceServers: [],
    state: room.state,
  });
  await vi.waitFor(() =>
    expect(mesh.diagnosticIceTransportPolicy()).toBe("all"),
  );
});

it("lets the answerer request a new link before an initial offer arrives", async () => {
  const { room } = connectionFixture();
  await vi.waitFor(() => expect(mesh.remotes.size).toBe(1));
  mesh.retry();
  expect(room.send).toHaveBeenCalledWith({
    type: "peer.signal",
    to: peer.id,
    linkId: undefined,
    restart: true,
  });
});

it("reports STUN errors and ICE state changes even before a diagnostic panel is opened", async () => {
  connectionFixture();
  await vi.waitFor(() => expect(mesh.remotes.size).toBe(1));
  const events: unknown[] = [];
  mesh.addEventListener("diagnostic", (event) =>
    events.push((event as CustomEvent).detail),
  );
  const pc = mesh.remotes.get(peer.id)!.pc;
  pc.onicecandidateerror!({
    url: "stun:stun.example.test:3478",
    address: "192.0.2.1",
    port: 1234,
    errorCode: 701,
    errorText: "STUN binding timed out",
  } as RTCPeerConnectionIceErrorEvent);
  pc.oniceconnectionstatechange!(new Event("iceconnectionstatechange"));
  expect(events).toContainEqual(
    expect.objectContaining({
      event: "ice.candidate_error",
      detail: expect.objectContaining({
        data: expect.objectContaining({ code: 701 }),
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({ event: "ice.state" }),
  );
  expect(mesh.remotes.get(peer.id)!.pc).toBe(pc);
});

it("honors current restart requests and ignores delayed requests for an old link", async () => {
  const { publish } = connectionFixture("00000000-0000-4000-a000-000000000000");
  await vi.waitFor(() => expect(mesh.remotes.size).toBe(1));
  const previous = mesh.remotes.get(peer.id)!;
  const restart = (linkId: string) =>
    publish({
      type: "peer.signal",
      from: peer.id,
      connectionId: peer.connectionId,
      linkId,
      restart: true,
    });
  restart(previous.linkId!);
  await vi.waitFor(() => expect(mesh.remotes.get(peer.id)).not.toBe(previous));
  const replacement = mesh.remotes.get(peer.id)!;
  restart(previous.linkId!);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mesh.remotes.get(peer.id)).toBe(replacement);
});

it("recreates stalled links after this participant reconnects to signaling", async () => {
  const { room, publish } = connectionFixture();
  await vi.waitFor(() => expect(mesh.remotes.size).toBe(1));
  const welcome = (connectionId: string) => {
    room.state.peers = [peer, { ...peer, id: selfId, connectionId }];
    publish({
      type: "welcome",
      participantId: selfId,
      iceServers: [],
      state: room.state,
    });
  };
  const previous = mesh.remotes.get(peer.id)!;
  welcome("first-self-connection");
  await vi.waitFor(() =>
    expect(previous.pc.setConfiguration).toHaveBeenCalled(),
  );
  expect(mesh.remotes.get(peer.id)).toBe(previous);
  welcome("second-self-connection");
  await vi.waitFor(() => expect(mesh.remotes.get(peer.id)).not.toBe(previous));
  expect(previous.pc.signalingState).toBe("closed");
});

it("rebuilds file and live connections after a sender reload, even without an offline event", async () => {
  vi.stubGlobal("RTCPeerConnection", Connection);
  vi.stubGlobal("MediaStream", class {});
  const room = Object.assign(new EventTarget(), {
    credentials: { participantId: selfId },
    state: null as RoomState | null,
    send: vi.fn(),
  });
  mesh = new LiveMesh(
    room as unknown as RoomClient,
    new EventTarget() as CaptureManager,
  );
  const publish = (peers: Peer[]) => {
    room.state = { roomId: "test-room", peers, take: null };
    room.dispatchEvent(
      new CustomEvent("message", {
        detail: { type: "room.state", state: room.state },
      }),
    );
  };
  publish([peer]);
  await vi.waitFor(() => expect(mesh.remotes.size).toBe(1));
  const old = mesh.remotes.get(peer.id)!;
  publish([{ ...peer, connectionId: "second-connection" }]);
  await vi.waitFor(() => expect(mesh.remotes.get(peer.id)).not.toBe(old));
  expect(old.pc.signalingState).toBe("closed");
  expect(mesh.remotes.get(peer.id)?.peer.connectionId).toBe(
    "second-connection",
  );
  const signal = (linkId: string) =>
    room.dispatchEvent(
      new CustomEvent("message", {
        detail: {
          type: "peer.signal",
          from: peer.id,
          connectionId: "second-connection",
          linkId,
          description: { type: "offer", sdp: "offer" },
        },
      }),
    );
  signal("first-link");
  await vi.waitFor(() =>
    expect(mesh.remotes.get(peer.id)?.linkId).toBe("first-link"),
  );
  const firstLink = mesh.remotes.get(peer.id)!;
  signal("replacement-link");
  await vi.waitFor(() =>
    expect(mesh.remotes.get(peer.id)?.linkId).toBe("replacement-link"),
  );
  expect(firstLink.pc.signalingState).toBe("closed");
  signal("first-link");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mesh.remotes.get(peer.id)?.linkId).toBe("replacement-link");
  publish([{ ...peer, connected: false }]);
  await vi.waitFor(() => expect(mesh.remotes.size).toBe(0));
  publish([{ ...peer, connectionId: "third-connection" }]);
  await vi.waitFor(() => expect(mesh.remotes.size).toBe(1));
  publish([]);
  await vi.waitFor(() => expect(mesh.remotes.size).toBe(0));
});
