import { describe, expect, it, vi } from "vitest";
import {
  TransferManager,
  fileEntrySchema,
} from "../apps/client/src/transfer/manager.js";
import { LocalStore } from "../apps/client/src/storage/store.js";
import { MemoryDirectory } from "./helpers/memory-files.js";
import { encodeWav } from "../apps/client/src/recorder/wav.js";
import { AutomaticSync } from "../apps/client/src/transfer/sync.js";
import { exportSession } from "../apps/client/src/export/exporter.js";
import type { LiveMesh, Remote } from "../apps/client/src/live/mesh.js";
import type {
  RecordingMeta,
  TrackMeta,
} from "../packages/protocol/src/index.js";

// Crypto and disk acknowledgements can take longer on a busy development host.
const waitFor = (check: () => unknown) =>
  vi.waitFor(check, { timeout: 10_000 });

class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent = 0;
  peer!: Channel;
  constructor(readonly label: string) {
    super();
  }
  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("Closed");
    this.sent++;
    const copy = structuredClone(data);
    queueMicrotask(() =>
      this.peer.dispatchEvent(new MessageEvent("message", { data: copy })),
    );
  }
}
class Mesh extends EventTarget {
  remotes = new Map<string, Remote>();
}
async function fixture() {
  const senderId = crypto.randomUUID(),
    receiverId = crypto.randomUUID();
  const a = new Mesh(),
    b = new Mesh();
  let allowed = true;
  const sender = new TransferManager(a as unknown as LiveMesh, () => allowed),
    receiver = new TransferManager(b as unknown as LiveMesh, () => allowed);
  const ac = new Channel("localtake-control"),
    bc = new Channel("localtake-control"),
    af = new Channel("localtake-files"),
    bf = new Channel("localtake-files");
  ac.peer = bc;
  bc.peer = ac;
  af.peer = bf;
  bf.peer = af;
  const ar = {
    id: receiverId,
    pc: { sctp: { maxMessageSize: 16_384 } },
    control: ac,
    files: af,
  } as unknown as Remote;
  const br = {
    id: senderId,
    pc: { sctp: { maxMessageSize: 16_384 } },
    control: bc,
    files: bf,
  } as unknown as Remote;
  a.remotes.set(receiverId, ar);
  b.remotes.set(senderId, br);
  for (const [mesh, remote, channels] of [
    [a, ar, [ac, af]],
    [b, br, [bc, bf]],
  ] as const)
    for (const channel of channels)
      mesh.dispatchEvent(
        new CustomEvent("channel", { detail: { remote, channel } }),
      );
  const source = new LocalStore(
      new MemoryDirectory() as unknown as FileSystemDirectoryHandle,
    ),
    target = new LocalStore(
      new MemoryDirectory() as unknown as FileSystemDirectoryHandle,
    );
  const trackId = crypto.randomUUID();
  const recording: RecordingMeta = {
    formatVersion: 1,
    recordingId: crypto.randomUUID(),
    participantId: senderId,
    participantName: "Source",
    createdAt: new Date().toISOString(),
    appVersion: "test",
    trackIds: [trackId],
    roomId: crypto.randomUUID(),
  };
  const track: TrackMeta = {
    formatVersion: 1,
    trackId,
    epochId: crypto.randomUUID(),
    label: "Mic",
    kind: "audio",
    codec: "pcm-f32",
    sampleRate: 48_000,
    channels: 1,
    localStartMs: 10,
    clock: {
      id: crypto.randomUUID(),
      epoch: "test",
      localMs: 10,
      offsetMs: 0,
      drift: 1,
      uncertaintyMs: 2,
      samples: 1,
    },
    settings: {},
  };
  await source.initialize(recording);
  await source.initializeTrack(recording, track);
  const audio = encodeWav(new Float32Array(96_000).fill(0.125), 48_000, 1);
  await source.commit(
    recording,
    track,
    {
      sequence: 0,
      fileName: "000000_000000000000us.wav",
      mediaStartUs: 0,
      mediaDurationUs: 2_000_000,
      sampleStart: 0,
      sampleCount: 96_000,
    },
    audio,
  );
  await source.finish(recording, {
    formatVersion: 1,
    recordingId: recording.recordingId,
    participantId: senderId,
    finishedAt: new Date().toISOString(),
    sources: [
      {
        trackId,
        label: "Mic",
        kind: "audio",
        state: "saved",
        savedSeconds: 2,
        capturedSeconds: 2,
        bytes: audio.byteLength,
        segments: 1,
      },
    ],
  });
  const inventory = await source.scan(recording.recordingId, senderId);
  async function offer() {
    await sender.offer(receiverId, inventory, source);
    const id = [...sender.transfers.keys()].at(-1)!;
    await waitFor(() =>
      expect(receiver.transfers.get(id)?.state).toBe("offered"),
    );
    return id;
  }
  return {
    sender,
    receiver,
    source,
    target,
    inventory,
    offer,
    af,
    senderId,
    receiverId,
    pause: () => {
      allowed = false;
    },
  };
}
describe("P2P file protocol", () => {
  it("automatically collects originals once both peers are online and remembers completion in the source folder", async () => {
    const f = await fixture();
    let destinationReady = false;
    const senderContext = {
      roomId: f.inventory.recording.roomId,
      selfId: f.senderId,
      destinationId: f.receiverId,
      store: f.source,
      library: [f.inventory],
      canWork: true,
    };
    const sender = new AutomaticSync(f.sender, () => ({
      ...senderContext,
      destinationReady,
    }));
    const receiver = new AutomaticSync(f.receiver, () => ({
      ...senderContext,
      selfId: f.receiverId,
      store: f.target,
      library: [],
      destinationReady: true,
    }));
    await sender.refresh();
    await sender.tick();
    expect(sender.status).toMatchObject({ pending: 1, state: "waiting" });
    expect(f.sender.transfers.size).toBe(0);
    destinationReady = true;
    await sender.tick();
    await waitFor(() =>
      expect([...f.receiver.transfers.values()][0]?.state).toBe("offered"),
    );
    await receiver.tick();
    await waitFor(() =>
      expect(sender.status).toMatchObject({ pending: 0, state: "done" }),
    );
    expect((await f.target.list())[0].complete).toBe(true);
    await expect(
      f.source.participant(f.inventory.recording.recordingId, f.senderId),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    const restoredLibrary = await new LocalStore(f.source.root).list();
    expect(restoredLibrary).toHaveLength(1);
    expect(restoredLibrary[0].transferredTo).toBe(f.receiverId);
    const reopenedStore = new LocalStore(f.source.root);
    const reopened = new AutomaticSync(f.sender, () => ({
      ...senderContext,
      store: reopenedStore,
      destinationReady: true,
    }));
    await reopened.refresh();
    expect(reopened.status.pending).toBe(0);
    const sent = f.af.sent;
    await reopened.tick();
    expect(f.af.sent).toBe(sent);
  });
  it("acknowledges an upload retried after a lost final ACK using the verified cutter files", async () => {
    const f = await fixture(),
      id = await f.offer();
    await f.receiver.accept(id, f.target);
    await waitFor(() => expect(f.sender.transfers.get(id)?.state).toBe("done"));
    const received = (await f.target.list())[0];
    await exportSession(f.target, [received], f.target.root, () => {}, true);
    await expect(
      f.target.participant(
        received.recording.recordingId,
        received.recording.participantId,
      ),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    const sent = f.af.sent;
    const retried = await f.offer();
    await f.receiver.accept(retried, f.target);
    await waitFor(() =>
      expect(f.sender.transfers.get(retried)?.state).toBe("done"),
    );
    expect(f.af.sent).toBe(sent);
    expect((await f.target.list())[0].complete).toBe(true);
    await expect(
      f.target.participant(
        received.recording.recordingId,
        received.recording.participantId,
      ),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("requires a durable matching transfer receipt before clearing a guest's originals", async () => {
    const f = await fixture();
    await expect(
      f.source.retireTransferred(f.inventory, f.receiverId, "a".repeat(64)),
    ).rejects.toThrow("Empfangsbestätigung fehlt");
    expect((await f.source.list())[0].complete).toBe(true);
  });
  it("automatically resumes a pending upload from local files after a storage error and a new sync instance", async () => {
    const f = await fixture();
    const context = {
      roomId: f.inventory.recording.roomId,
      selfId: f.senderId,
      destinationId: f.receiverId,
      store: f.source,
      library: [f.inventory],
      canWork: true,
      destinationReady: true,
    };
    const sender = new AutomaticSync(f.sender, () => context);
    const receiver = new AutomaticSync(f.receiver, () => ({
      ...context,
      selfId: f.receiverId,
      store: f.target,
      library: [],
    }));
    await sender.refresh();
    vi.spyOn(f.target, "receive").mockRejectedValueOnce(
      new Error("Speicher nicht freigegeben"),
    );
    await sender.tick();
    await waitFor(() =>
      expect([...f.receiver.transfers.values()][0]?.state).toBe("offered"),
    );
    await receiver.tick();
    await waitFor(() =>
      expect([...f.sender.transfers.values()][0]?.state).toBe("error"),
    );
    const reopenedStore = new LocalStore(f.source.root);
    const resumed = new AutomaticSync(f.sender, () => ({
      ...context,
      store: reopenedStore,
    }));
    await resumed.refresh();
    expect(resumed.status.pending).toBe(1);
    await resumed.tick();
    await waitFor(() =>
      expect([...f.receiver.transfers.values()].at(-1)?.state).toBe("offered"),
    );
    await receiver.tick();
    await waitFor(() => expect(resumed.status.pending).toBe(0));
    expect((await f.target.list())[0].complete).toBe(true);
  });
  it("reports receiver storage failure to both peers and resumes after repair", async () => {
    const f = await fixture(),
      id = await f.offer();
    const receive = vi
      .spyOn(f.target, "receive")
      .mockRejectedValueOnce(new Error("Disk full"));
    await f.receiver.accept(id, f.target);
    await waitFor(() =>
      expect(f.sender.transfers.get(id)?.state).toBe("error"),
    );
    expect(f.receiver.transfers.get(id)?.error).toBe("Disk full");
    expect(f.sender.transfers.get(id)?.error).toBe("Disk full");
    expect(f.sender.transfers.get(id)?.bytes).toBe(0);
    receive.mockRestore();
    const resumed = await f.offer();
    await f.receiver.accept(resumed, f.target);
    await waitFor(() =>
      expect(f.sender.transfers.get(resumed)?.state).toBe("done"),
    );
    expect((await f.target.list())[0].complete).toBe(true);
  });
  it("does not acknowledge a write completed after cancellation", async () => {
    const f = await fixture(),
      id = await f.offer();
    const receive = f.target.receive.bind(f.target);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writing = false;
    vi.spyOn(f.target, "receive").mockImplementationOnce(async (...args) => {
      writing = true;
      await pending;
      return receive(...args);
    });
    await f.receiver.accept(id, f.target);
    await waitFor(() => expect(writing).toBe(true));
    f.receiver.cancel(id);
    release();
    await waitFor(() =>
      expect(f.sender.transfers.get(id)?.state).toBe("error"),
    );
    expect(f.sender.transfers.get(id)?.bytes).toBe(0);
    const resumed = await f.offer();
    await f.receiver.accept(resumed, f.target);
    await waitFor(() =>
      expect(f.sender.transfers.get(resumed)?.state).toBe("done"),
    );
    expect((await f.target.list())[0].complete).toBe(true);
  });
  it("resumes a receiver interrupted between creating and closing a media file", async () => {
    const f = await fixture();
    const segment = f.inventory.segments[0];
    let dir = await f.target.participant(
      segment.recordingId,
      segment.participantId,
      true,
    );
    for (const part of ["tracks", segment.trackId, segment.epochId])
      dir = await dir.getDirectoryHandle(part, { create: true });
    await dir.getFileHandle(segment.fileName, { create: true });
    const id = await f.offer();
    await f.receiver.accept(id, f.target);
    await waitFor(() => expect(f.sender.transfers.get(id)?.state).toBe("done"));
    expect((await f.target.list())[0].complete).toBe(true);
  });
  it("copies a recording with durable receipts, then resumes with no media retransmission", async () => {
    const f = await fixture(),
      id = await f.offer();
    await f.receiver.accept(id, f.target);
    await waitFor(() => expect(f.sender.transfers.get(id)?.state).toBe("done"));
    const [received] = await f.target.list();
    expect(received.complete).toBe(true);
    expect(received.segments[0].sha256).toBe(f.inventory.segments[0].sha256);
    const blocks = f.af.sent,
      resume = await f.offer();
    await f.receiver.accept(resume, f.target);
    await waitFor(() =>
      expect(f.sender.transfers.get(resume)?.state).toBe("done"),
    );
    expect(f.af.sent).toBe(blocks);
  });
  it("can cancel a transfer while it is paused for live media", async () => {
    const f = await fixture(),
      id = await f.offer();
    f.pause();
    await f.receiver.accept(id, f.target);
    await waitFor(() =>
      expect(f.sender.transfers.get(id)?.state).toBe("paused"),
    );
    f.receiver.cancel(id);
    await waitFor(() =>
      expect(f.sender.transfers.get(id)?.state).toBe("error"),
    );
    expect(f.af.sent).toBe(0);
  });
  it("rejects traversal and uncontrolled media paths before writing", () => {
    for (const path of [
      "../secret.txt",
      "tracks/../../secret.json",
      "C:/secret.json",
      "recording.json/evil",
      "arbitrary.json",
    ])
      expect(
        fileEntrySchema.safeParse({ path, bytes: 4, hash: "a".repeat(64) })
          .success,
      ).toBe(false);
  });
});
