import type {
  Inventory,
  RecordingStatus,
  RoomState,
  SessionManifest,
} from "../../../../packages/protocol/src/index.js";
import type { Transfer } from "../transfer/manager.js";
import type { SyncItem } from "../transfer/sync.js";

// A session is one take: from pressing record until stop, in one room. The
// receiving host (master) sees every participant and how much of their originals
// arrived; a guest (slave) sees its own upload; solo takes are local only.
export type ParticipantState =
  | "recording"
  | "finalizing"
  | "waiting"
  | "sending"
  | "receiving"
  | "done"
  | "local"
  | "partial"
  | "failed";
const SETTLED: ParticipantState[] = ["done", "local", "partial", "failed"];
export type ParticipantProgress = {
  id: string;
  name: string;
  role?: "host" | "guest";
  self: boolean;
  online?: boolean;
  state: ParticipantState;
  // Stored or transferred bytes against the expected total; total 0 = unknown.
  bytes: number;
  total: number;
  detail?: string;
  inventory?: Inventory;
};
export type SessionView = {
  id: string;
  roomId?: string;
  startedAt: string;
  role: "master" | "slave" | "solo";
  participants: ParticipantProgress[];
  recordings: Inventory[];
  settled: boolean;
  bytes: number;
  total: number;
};
export type SessionInputs = {
  library: Inventory[];
  manifests: SessionManifest[];
  room: RoomState | null;
  // Own participant id per room; solo takes use the local owner id.
  selfFor: (roomId?: string) => string | undefined;
  transfers: Transfer[];
  sync: SyncItem[];
  local: { recordingId: string; createdAt: string; status: RecordingStatus }[];
};

export function hostUploadPending(
  room: RoomState | null,
  self: string | undefined,
  sessions: SessionView[],
): boolean {
  if (!room || !self || room.archiveDestinationId !== self) return false;
  // Upload counts describe a connected sender's current queue. After disconnect
  // its final "done" may not have reached WSS; local receipts are authoritative.
  if (
    room.peers.some(
      (peer) =>
        peer.id !== self && peer.connected && (peer.upload?.pending ?? 0) > 0,
    )
  )
    return true;
  // Keep missing guests visible across earlier takes as well. A completed
  // current take must not hide another participant's undelivered originals.
  return sessions.some(
    (session) =>
      session.roomId === room.roomId &&
      session.role === "master" &&
      session.participants.some((p) => !p.self && !SETTLED.includes(p.state)),
  );
}

const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);
const stored = (inventory?: Inventory) =>
  sum(inventory?.segments.map((s) => s.byteLength) ?? []);
const recorded = (status?: RecordingStatus) =>
  sum(status?.sources.map((s) => s.bytes) ?? []);
const active = (state?: RecordingStatus["state"]) =>
  state === "recording" || state === "finalizing";

export function buildSessions(input: SessionInputs): SessionView[] {
  const ids = new Set<string>();
  for (const inventory of input.library)
    if (inventory.recording.purpose !== "check")
      ids.add(inventory.recording.recordingId);
  for (const manifest of input.manifests) ids.add(manifest.recordingId);
  for (const local of input.local) ids.add(local.recordingId);
  const take = input.room?.take;
  const currentSelf = input.selfFor(input.room?.roomId);
  if (
    take &&
    take.phase !== "cancelled" &&
    currentSelf &&
    take.participants.includes(currentSelf)
  )
    ids.add(take.id);
  return [...ids]
    .map((id) => buildSession(id, input))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function buildSession(id: string, input: SessionInputs): SessionView {
  const recordings = input.library.filter(
    (i) => i.recording.recordingId === id && i.recording.purpose !== "check",
  );
  const manifest = input.manifests.find((m) => m.recordingId === id);
  const local = input.local.find((l) => l.recordingId === id);
  const take = input.room?.take?.id === id ? input.room.take : null;
  const roomId =
    manifest?.roomId ??
    recordings.find((r) => r.recording.roomId)?.recording.roomId ??
    (take ? input.room?.roomId : undefined);
  const room = roomId && input.room?.roomId === roomId ? input.room : null;
  const owners = new Set(recordings.map((r) => r.recording.participantId));
  const self =
    input.selfFor(roomId) ??
    (owners.size === 1 && !manifest ? [...owners][0] : undefined);
  const role: SessionView["role"] = !roomId
    ? "solo"
    : manifest ||
        (room && room.archiveDestinationId === self) ||
        recordings.some((r) => r.recording.participantId !== self)
      ? "master"
      : "slave";
  const participantIds = new Set<string>();
  if (role === "master") {
    for (const p of manifest?.participants ?? []) participantIds.add(p.id);
    for (const p of take?.participants ?? []) participantIds.add(p);
    for (const r of recordings) participantIds.add(r.recording.participantId);
  }
  if (self) participantIds.add(self);
  const participants = [...participantIds].map((participantId) =>
    participant(participantId, id, role, self, {
      input,
      room,
      manifest,
      local,
      inventory: recordings.find(
        (r) => r.recording.participantId === participantId,
      ),
    }),
  );
  // Host first, then guests in join order; own row first for a guest.
  participants.sort(
    (a, b) =>
      Number(b.role === "host") - Number(a.role === "host") ||
      Number(b.self) - Number(a.self),
  );
  const measured = participants.filter((p) => p.total > 0);
  return {
    id,
    roomId,
    startedAt:
      manifest?.startedAt ??
      recordings
        .map((r) => r.recording.createdAt)
        .sort()
        .at(0) ??
      local?.createdAt ??
      new Date().toISOString(),
    role,
    participants,
    recordings,
    settled: participants.every((p) => SETTLED.includes(p.state)),
    bytes: sum(measured.map((p) => Math.min(p.bytes, p.total))),
    total: sum(measured.map((p) => p.total)),
  };
}

function participant(
  id: string,
  sessionId: string,
  role: SessionView["role"],
  self: string | undefined,
  context: {
    input: SessionInputs;
    room: RoomState | null;
    manifest?: SessionManifest;
    local?: SessionInputs["local"][number];
    inventory?: Inventory;
  },
): ParticipantProgress {
  const { input, room, manifest, local, inventory } = context;
  const peer = room?.peers.find((p) => p.id === id);
  const entry = manifest?.participants.find((p) => p.id === id);
  const isSelf = id === self;
  const live =
    isSelf && local
      ? local.status
      : peer?.recording?.recordingId === sessionId
        ? peer.recording
        : undefined;
  const base = {
    id,
    name:
      peer?.name ??
      entry?.name ??
      inventory?.recording.participantName ??
      "Teilnehmer",
    role: peer?.role ?? entry?.role,
    self: isSelf,
    online: peer ? peer.connected : undefined,
    inventory,
  };
  const have = stored(inventory);
  if (active(live?.state))
    return {
      ...base,
      state: live!.state as ParticipantState,
      bytes: recorded(live),
      total: 0,
    };
  const finished = (
    complete: ParticipantState = "done",
  ): ParticipantProgress =>
    inventory
      ? {
          ...base,
          state: inventory.complete ? complete : "partial",
          bytes: have,
          total: have,
        }
      : live && live.state !== "failed"
        ? // Saved locally; the archive scan has not listed it yet.
          { ...base, state: "waiting", bytes: 0, total: 0 }
        : { ...base, state: "failed", bytes: 0, total: 0 };
  // Own originals are local; only a guest still has to send them to the host.
  if (isSelf && role !== "slave") return finished();
  if (isSelf) {
    const item = input.sync.find(
      (i) => i.inventory.recording.recordingId === sessionId,
    );
    if (item?.state === "done") return finished();
    // Without an upload queue (other room, not yet connected) only local state is known.
    if (!item) return finished("local");
    const transfer = item.transferId
      ? input.transfers.find((t) => t.id === item.transferId)
      : undefined;
    return {
      ...base,
      state: item.state === "uploading" ? "sending" : "waiting",
      bytes: transfer?.bytes ?? 0,
      total: transfer?.total ?? have,
      detail: item.error,
    };
  }
  const expected = live ? recorded(live) : (entry?.bytes ?? 0);
  const transfer = input.transfers
    .filter(
      (t) =>
        t.direction === "receive" &&
        t.peerId === id &&
        t.recording.recordingId === sessionId &&
        t.state !== "error",
    )
    .at(-1);
  if (transfer && transfer.state !== "done")
    return {
      ...base,
      state: "receiving",
      bytes: transfer.bytes,
      total: transfer.total,
    };
  if (inventory && (!expected || have >= expected)) return finished();
  if (!inventory && transfer?.state === "done")
    return {
      ...base,
      state: "done",
      bytes: transfer.total,
      total: transfer.total,
    };
  if ((live?.state ?? entry?.state) === "failed" && !inventory)
    return { ...base, state: "failed", bytes: 0, total: 0 };
  return {
    ...base,
    state: "waiting",
    bytes: have,
    total: Math.max(expected, have),
    detail:
      peer && !peer.connected
        ? `${base.name} ist offline. Die Übertragung setzt fort, sobald ${base.name} den Raumlink wieder öffnet.`
        : peer?.upload?.state === "error"
          ? peer.upload.reason
          : undefined,
  };
}
