import { describe, expect, it } from "vitest";
import {
  buildSessions,
  hostUploadPending,
  type SessionInputs,
} from "../apps/client/src/core/sessions.js";
import type { Transfer } from "../apps/client/src/transfer/manager.js";
import type {
  Inventory,
  Peer,
  RecordingStatus,
  RoomState,
} from "../packages/protocol/src/index.js";

const roomId = crypto.randomUUID(),
  hostId = crypto.randomUUID(),
  guestId = crypto.randomUUID(),
  lateId = crypto.randomUUID(),
  take = crypto.randomUUID(),
  earlier = crypto.randomUUID();
const inventory = (
  recordingId: string,
  participantId: string,
  bytes: number[],
  createdAt = "2026-10-09T10:00:00.000Z",
): Inventory => ({
  recording: {
    formatVersion: 1,
    recordingId,
    participantId,
    participantName: participantId === hostId ? "Host" : "Gast",
    createdAt,
    appVersion: "test",
    trackIds: [crypto.randomUUID()],
    roomId,
    purpose: "recording",
  },
  tracks: [],
  segments: bytes.map((byteLength, sequence) => ({
    formatVersion: 1,
    recordingId,
    participantId,
    trackId: crypto.randomUUID(),
    epochId: crypto.randomUUID(),
    sequence,
    fileName: `${String(sequence).padStart(6, "0")}_000000000000us.mp4`,
    byteLength,
    sha256: "0".repeat(64),
    mediaStartUs: 0,
    mediaDurationUs: 1,
    clockMappingId: crypto.randomUUID(),
  })),
  complete: true,
  issues: [],
});
const status = (
  state: RecordingStatus["state"],
  bytes: number,
): RecordingStatus => ({
  recordingId: take,
  state,
  sources: [
    {
      trackId: crypto.randomUUID(),
      label: "Kamera",
      kind: "video",
      state: state === "recording" ? "recording" : "saved",
      savedSeconds: 1,
      capturedSeconds: 1,
      bytes,
      segments: 1,
    },
  ],
});
const peer = (id: string, name: string, extra: Partial<Peer> = {}): Peer => ({
  id,
  name,
  role: id === hostId ? "host" : "guest",
  connected: true,
  media: {
    micMuted: false,
    camMuted: false,
    sharing: false,
    livePaused: false,
  },
  ready: true,
  recording: null,
  ...extra,
});
const room = (peers: Peer[]): RoomState => ({
  roomId,
  peers,
  take: {
    id: take,
    commandId: crypto.randomUUID(),
    phase: "done",
    participants: [hostId, guestId, lateId],
    ready: [],
  },
  archiveDestinationId: hostId,
});
const inputs = (
  self: string,
  overrides: Partial<SessionInputs>,
): SessionInputs => ({
  library: [],
  manifests: [],
  room: null,
  selfFor: (id) => (id === roomId ? self : undefined),
  transfers: [],
  sync: [],
  local: [],
  ...overrides,
});

describe("sessions as takes", () => {
  it("finishes the host when an offline guest's last upload count is stale but both archives exist", () => {
    const state = room([
      peer(hostId, "Host", { recording: status("saved", 1000) }),
      peer(guestId, "Gast", {
        connected: false,
        recording: status("saved", 900),
        upload: { pending: 1, bytes: 900, total: 900, state: "uploading" },
      }),
    ]);
    state.take!.participants = [hostId, guestId];
    const sessions = buildSessions(
      inputs(hostId, {
        room: state,
        library: [
          inventory(take, hostId, [1000]),
          inventory(take, guestId, [900]),
        ],
      }),
    );
    expect(sessions[0].participants.map((p) => p.state)).toEqual([
      "done",
      "done",
    ]);
    expect(sessions[0].settled).toBe(true);
    expect(hostUploadPending(state, hostId, sessions)).toBe(false);
  });
  it("still waits for missing originals from an offline guest even without an upload status", () => {
    const state = room([
      peer(hostId, "Host", { recording: status("saved", 1000) }),
      peer(guestId, "Gast", {
        connected: false,
        recording: status("saved", 900),
      }),
    ]);
    state.take!.participants = [hostId, guestId];
    const sessions = buildSessions(
      inputs(hostId, {
        room: state,
        library: [inventory(take, hostId, [1000])],
      }),
    );
    expect(hostUploadPending(state, hostId, sessions)).toBe(true);
  });
  it("keeps a connected guest's other queued recordings pending after the current take finishes", () => {
    const state = room([
      peer(hostId, "Host", { recording: status("saved", 1000) }),
      peer(guestId, "Gast", {
        recording: status("saved", 900),
        upload: { pending: 1, bytes: 0, total: 100, state: "waiting" },
      }),
    ]);
    state.take!.participants = [hostId, guestId];
    const sessions = buildSessions(
      inputs(hostId, {
        room: state,
        library: [
          inventory(take, hostId, [1000]),
          inventory(take, guestId, [900]),
        ],
      }),
    );
    expect(sessions[0].settled).toBe(true);
    expect(hostUploadPending(state, hostId, sessions)).toBe(true);
    expect(hostUploadPending(state, guestId, sessions)).toBe(false);
  });
  it("keeps undelivered originals from earlier takes pending after a later take is complete", () => {
    const state = room([
      peer(hostId, "Host", { recording: status("saved", 1000) }),
      peer(guestId, "Gast", {
        connected: false,
        recording: status("saved", 900),
      }),
    ]);
    state.take!.participants = [hostId, guestId];
    const sessions = buildSessions(
      inputs(hostId, {
        room: state,
        library: [
          inventory(take, hostId, [1000]),
          inventory(take, guestId, [900]),
          inventory(earlier, hostId, [100]),
        ],
        manifests: [
          {
            formatVersion: 1,
            recordingId: earlier,
            roomId,
            startedAt: "2026-10-08T10:00:00.000Z",
            participants: [
              {
                id: hostId,
                name: "Host",
                role: "host",
                state: "saved",
                bytes: 100,
              },
              {
                id: guestId,
                name: "Gast",
                role: "guest",
                state: "saved",
                bytes: 50,
              },
            ],
          },
        ],
      }),
    );
    expect(hostUploadPending(state, hostId, sessions)).toBe(true);
  });
  it("does not wait for an earlier guest recording that failed before any originals were saved", () => {
    const state = room([
      peer(hostId, "Host", { recording: status("saved", 1000) }),
      peer(guestId, "Gast", {
        connected: false,
        recording: status("saved", 900),
      }),
    ]);
    state.take!.participants = [hostId, guestId];
    const sessions = buildSessions(
      inputs(hostId, {
        room: state,
        library: [
          inventory(take, hostId, [1000]),
          inventory(take, guestId, [900]),
          inventory(earlier, hostId, [100]),
        ],
        manifests: [
          {
            formatVersion: 1,
            recordingId: earlier,
            roomId,
            startedAt: "2026-10-08T10:00:00.000Z",
            participants: [
              {
                id: hostId,
                name: "Host",
                role: "host",
                state: "saved",
                bytes: 100,
              },
              {
                id: guestId,
                name: "Gast",
                role: "guest",
                state: "failed",
                bytes: 0,
              },
            ],
          },
        ],
      }),
    );
    expect(sessions.find((s) => s.id === earlier)?.participants[1].state).toBe(
      "failed",
    );
    expect(hostUploadPending(state, hostId, sessions)).toBe(false);
  });
  it("shows the host every participant of the take with transfer progress", () => {
    const transfer = {
      id: crypto.randomUUID(),
      peerId: guestId,
      recording: inventory(take, guestId, []).recording,
      direction: "receive",
      state: "transferring",
      bytes: 300,
      total: 1000,
    } as Transfer;
    const sessions = buildSessions(
      inputs(hostId, {
        library: [
          inventory(take, hostId, [500, 500]),
          inventory(earlier, hostId, [10], "2026-10-08T10:00:00.000Z"),
          inventory(earlier, guestId, [10], "2026-10-08T10:00:00.000Z"),
        ],
        room: room([
          peer(hostId, "Host", { recording: status("saved", 1000) }),
          peer(guestId, "Gast", { recording: status("saved", 900) }),
          peer(lateId, "Lena", {
            connected: false,
            recording: status("recording", 120),
          }),
        ]),
        transfers: [transfer],
      }),
    );
    expect(sessions.map((s) => s.id)).toEqual([take, earlier]);
    const [current] = sessions;
    expect(current.role).toBe("master");
    expect(
      current.participants.map((p) => [p.name, p.state, p.bytes, p.total]),
    ).toEqual([
      ["Host", "done", 1000, 1000],
      ["Gast", "receiving", 300, 1000],
      ["Lena", "recording", 120, 0],
    ]);
    expect(current.settled).toBe(false);
    // Lena went offline while recording; once she stopped, her upload is pending.
    const later = buildSessions(
      inputs(hostId, {
        library: [
          inventory(take, hostId, [1000]),
          inventory(take, guestId, [900]),
        ],
        room: room([
          peer(hostId, "Host", { recording: status("saved", 1000) }),
          peer(guestId, "Gast", { recording: status("saved", 900) }),
          peer(lateId, "Lena", {
            connected: false,
            recording: status("saved", 400),
          }),
        ]),
      }),
    )[0];
    expect(later.participants.map((p) => p.state)).toEqual([
      "done",
      "done",
      "waiting",
    ]);
    expect(later.participants[2]).toMatchObject({
      bytes: 0,
      total: 400,
      online: false,
    });
    expect(later.participants[2].detail).toContain("offline");
  });
  it("keeps participants who never delivered visible through the host's manifest", () => {
    const [session] = buildSessions(
      inputs(hostId, {
        library: [inventory(earlier, hostId, [10])],
        manifests: [
          {
            formatVersion: 1,
            recordingId: earlier,
            roomId,
            startedAt: "2026-10-08T10:00:00.000Z",
            participants: [
              { id: hostId, name: "Host", role: "host" },
              {
                id: guestId,
                name: "Gast",
                role: "guest",
                state: "saved",
                bytes: 50,
              },
            ],
          },
        ],
      }),
    );
    expect(session.participants.map((p) => [p.name, p.state])).toEqual([
      ["Host", "done"],
      ["Gast", "waiting"],
    ]);
    expect(session.total).toBe(60);
  });
  it("shows a guest its own sending progress only", () => {
    const own = inventory(take, guestId, [700, 300]);
    const transferId = crypto.randomUUID();
    const view = (state: "waiting" | "uploading" | "done") =>
      buildSessions(
        inputs(guestId, {
          library: [own],
          room: room([
            peer(hostId, "Host", { recording: status("saved", 1000) }),
            peer(guestId, "Gast", { recording: status("saved", 1000) }),
          ]),
          sync: [
            {
              inventory: own,
              fingerprint: "f",
              state,
              transferId,
              retryAt: 0,
            },
          ],
          transfers: [
            {
              id: transferId,
              peerId: hostId,
              direction: "send",
              state: "transferring",
              bytes: 250,
              total: 1100,
            } as Transfer,
          ],
        }),
      )[0];
    const sending = view("uploading");
    expect(sending.role).toBe("slave");
    expect(sending.participants).toHaveLength(1);
    expect(sending.participants[0]).toMatchObject({
      self: true,
      state: "sending",
      bytes: 250,
      total: 1100,
    });
    expect(view("done").participants[0].state).toBe("done");
    expect(view("done").settled).toBe(true);
  });
  it("treats a recording outside a room as a local session", () => {
    const owner = crypto.randomUUID();
    const solo = inventory(take, owner, [5]);
    delete solo.recording.roomId;
    const [session] = buildSessions(
      inputs(owner, { library: [solo], selfFor: () => owner }),
    );
    expect(session).toMatchObject({ role: "solo", settled: true });
    expect(session.participants[0].state).toBe("done");
  });
});
