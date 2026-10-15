import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BlobSource,
  BufferTarget,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import {
  exportRecording,
  exportSession,
  sessionStamp,
} from "../apps/client/src/export/exporter.js";
import { LocalStore, retryPolicy } from "../apps/client/src/storage/store.js";
import { encodeWav } from "../apps/client/src/recorder/wav.js";
import { MemoryDirectory } from "./helpers/memory-files.js";
import {
  buildSessions,
  hostUploadPending,
} from "../apps/client/src/core/sessions.js";
import type {
  RecordingMeta,
  TrackMeta,
} from "../packages/protocol/src/index.js";

const delays = retryPolicy.delays;
afterEach(() => {
  retryPolicy.delays = delays;
  vi.unstubAllGlobals();
});

async function lockedExport(
  root: MemoryDirectory,
  extension: string,
  stage: "open" | "write" | "close",
  failures = 1,
) {
  const folder = await root.getDirectoryHandle("locked-export", {
    create: true,
  });
  const fault = { attempts: 0, failures };
  const opened = new WeakSet();
  const getFile = folder.getFileHandle.bind(folder);
  folder.getFileHandle = async (name, options) => {
    const file = await getFile(name, options);
    if (!name.endsWith(extension) || opened.has(file)) return file;
    opened.add(file);
    const create = file.createWritable.bind(file);
    file.createWritable = async () => {
      fault.attempts++;
      const fail = () => {
        if (fault.failures > 0) {
          fault.failures--;
          throw new DOMException(
            "Windows file operation failed",
            "InvalidStateError",
          );
        }
      };
      if (stage === "open") fail();
      const writable = await create();
      if (stage === "write") {
        const write = writable.write.bind(writable);
        writable.write = async (chunk) => {
          fail();
          await write(chunk);
        };
      }
      if (stage === "close") {
        const close = writable.close.bind(writable);
        writable.close = async () => {
          fail();
          await close();
        };
      }
      return writable;
    };
    return file;
  };
  return { folder, fault };
}

async function verifyRetriedExport(folder: FileSystemDirectoryHandle) {
  const files: File[] = [];
  for await (const entry of folder.values())
    if (entry.kind === "file")
      files.push(await (entry as FileSystemFileHandle).getFile());
  const input = new Input({
    formats: [MP4],
    source: new BlobSource(files.find((f) => f.name.endsWith(".mp4"))!),
  });
  try {
    const track = (await input.getPrimaryVideoTrack())!;
    const timestamps = [];
    for await (const packet of new EncodedPacketSink(track).packets())
      timestamps.push(packet.timestamp);
    expect(timestamps).toEqual(Array.from({ length: 40 }, (_, i) => i / 10));
  } finally {
    input.dispose();
  }
  const pcm = new DataView(
    await files.find((f) => f.name.endsWith(".wav"))!.arrayBuffer(),
  );
  expect(pcm.byteLength).toBe(56 + 192000 * 4);
  expect(pcm.getFloat32(56, true)).toBe(0.25);
  expect(pcm.getFloat32(56 + 95999 * 4, true)).toBe(0.25);
  expect(pcm.getFloat32(56 + 96000 * 4, true)).toBe(-0.25);
  expect(pcm.getFloat32(pcm.byteLength - 4, true)).toBe(-0.25);
}

async function fixture(
  jitter = false,
  context: Partial<RecordingMeta> = {},
  sharedRoot?: MemoryDirectory,
) {
  const root = sharedRoot ?? new MemoryDirectory();
  const handle = root as unknown as FileSystemDirectoryHandle;
  const store = new LocalStore(handle);
  const recording: RecordingMeta = {
    formatVersion: 1,
    recordingId: crypto.randomUUID(),
    participantId: crypto.randomUUID(),
    participantName: "Export integration",
    createdAt: new Date().toISOString(),
    appVersion: "test",
    trackIds: [crypto.randomUUID(), crypto.randomUUID()],
    ...context,
  };
  const common = {
    formatVersion: 1 as const,
    localStartMs: 100,
    clock: {
      id: crypto.randomUUID(),
      epoch: "test",
      localMs: 100,
      offsetMs: 0,
      drift: 1,
      uncertaintyMs: 1,
      samples: 1,
    },
    settings: {},
  };
  const video: TrackMeta = {
    ...common,
    trackId: recording.trackIds[0],
    epochId: crypto.randomUUID(),
    label: "Video",
    kind: "video",
    codec: "avc",
    width: 320,
    height: 180,
    frameRate: 10,
  };
  const audio: TrackMeta = {
    ...common,
    trackId: recording.trackIds[1],
    epochId: crypto.randomUUID(),
    label: "Audio",
    kind: "audio",
    codec: "pcm-f32",
    sampleRate: 48000,
    channels: 1,
  };
  await store.initialize(recording);
  await store.initializeTrack(recording, video);
  await store.initializeTrack(recording, audio);
  let mp4: Uint8Array = await readFile(
    new URL("./fixtures/h264-2s.mp4", import.meta.url),
  );
  if (jitter) {
    const input = new Input({
      formats: [MP4],
      source: new BlobSource(new Blob([new Uint8Array(mp4)])),
    });
    try {
      const track = (await input.getPrimaryVideoTrack())!;
      const decoderConfig = (await track.getDecoderConfig())!;
      const target = new BufferTarget();
      const output = new Output({ format: new Mp4OutputFormat(), target });
      const source = new EncodedVideoPacketSource("avc");
      output.addVideoTrack(source);
      await output.start();
      let index = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        // 0.151s and 0.249s are distinct captures but both round to 0.2s at 10fps.
        const timestamp =
          index === 1 ? 0.151 : index === 2 ? 0.249 : index / 10;
        const next =
          index === 0 ? 0.151 : index === 1 ? 0.249 : (index + 1) / 10;
        await source.add(
          packet.clone({ timestamp, duration: next - timestamp }),
          { decoderConfig },
        );
        index++;
      }
      source.close();
      await output.finalize();
      mp4 = new Uint8Array(target.buffer!);
    } finally {
      input.dispose();
    }
  }
  for (let index = 0; index < 2; index++) {
    const start = index * 2_000_000;
    await store.commit(
      recording,
      video,
      {
        sequence: index,
        fileName: `${index}_${start}us.mp4`,
        mediaStartUs: start,
        mediaDurationUs: 2_000_000,
      },
      new Uint8Array(mp4).buffer,
    );
    await store.commit(
      recording,
      audio,
      {
        sequence: index,
        fileName: `${index}_${start}us.wav`,
        mediaStartUs: start,
        mediaDurationUs: 2_000_000,
        sampleStart: index * 96000,
        sampleCount: 96000,
      },
      encodeWav(new Float32Array(96000).fill(index ? -0.25 : 0.25), 48000, 1),
    );
  }
  await store.finish(recording, {
    formatVersion: 1,
    recordingId: recording.recordingId,
    participantId: recording.participantId,
    finishedAt: new Date().toISOString(),
    sources: [video, audio].map((track) => ({
      trackId: track.trackId,
      label: track.label,
      kind: track.kind,
      state: "saved",
      savedSeconds: 4,
      capturedSeconds: 4,
      bytes: track.kind === "video" ? mp4.byteLength * 2 : (56 + 96000 * 4) * 2,
      segments: 2,
    })),
  });
  const inventory = await store.scan(
    recording.recordingId,
    recording.participantId,
  );
  return { root, handle, store, inventory };
}

describe("original export", () => {
  it("recognizes both retired originals in a Windows folder with an earlier capitalization and finishes the host", async () => {
    const root = new MemoryDirectory("root", true);
    await root.getDirectoryHandle("Testraum", { create: true });
    const roomId = crypto.randomUUID();
    const host = await fixture(
      false,
      {
        roomId,
        sessionName: "testraum",
        participantName: "Host",
        sessionStartedAt: "2026-10-13T10:16:25Z",
      },
      root,
    );
    const guest = await fixture(
      false,
      {
        roomId,
        sessionName: "testraum",
        participantName: "RemoteTest",
        sessionStartedAt: "2026-10-13T10:16:25Z",
        recordingId: host.inventory.recording.recordingId,
      },
      root,
    );
    const takeId = host.inventory.recording.recordingId;
    const hostId = host.inventory.recording.participantId;
    const guestId = guest.inventory.recording.participantId;
    await host.store.writeSession({
      formatVersion: 1,
      recordingId: takeId,
      roomId,
      roomName: "testraum",
      startedAt: "2026-10-13T10:16:25Z",
      participants: [
        { id: hostId, name: "Host", role: "host" },
        { id: guestId, name: "RemoteTest", role: "guest" },
      ],
    });
    await exportSession(
      host.store,
      [host.inventory, guest.inventory],
      host.handle,
      () => {},
      true,
    );
    await expect(host.store.participant(takeId, hostId)).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await expect(host.store.participant(takeId, guestId)).rejects.toMatchObject(
      { name: "NotFoundError" },
    );
    const library = await host.store.list();
    expect(library).toHaveLength(2);
    expect(
      library.every((i) => i.complete && i.archive?.path[0] === "Testraum"),
    ).toBe(true);
    expect(host.store.scanIssues).toEqual([]);
    const room = {
      roomId,
      archiveDestinationId: hostId,
      take: {
        id: takeId,
        commandId: crypto.randomUUID(),
        phase: "done" as const,
        participants: [hostId, guestId],
        ready: [],
      },
      peers: [
        {
          id: hostId,
          name: "Host",
          role: "host" as const,
          connected: true,
          ready: true,
          media: {
            micMuted: false,
            camMuted: false,
            sharing: false,
            livePaused: false,
          },
          recording: null,
        },
        {
          id: guestId,
          name: "RemoteTest",
          role: "guest" as const,
          connected: false,
          ready: false,
          media: {
            micMuted: false,
            camMuted: false,
            sharing: false,
            livePaused: false,
          },
          recording: null,
          upload: {
            pending: 1,
            bytes: 100,
            total: 100,
            state: "uploading" as const,
          },
        },
      ],
    };
    const sessions = buildSessions({
      library,
      manifests: await host.store.sessions(),
      room,
      selfFor: () => hostId,
      transfers: [],
      sync: [],
      local: [],
    });
    expect(sessions[0].participants.map((p) => [p.name, p.state])).toEqual([
      ["Host", "done"],
      ["RemoteTest", "done"],
    ]);
    expect(hostUploadPending(room, hostId, sessions)).toBe(false);
  });
  it("rejects a receipt pointing to a different case-sensitive folder", async () => {
    const f = await fixture(false, { sessionName: "Testraum" });
    const folder = await exportSession(
      f.store,
      [f.inventory],
      f.handle,
      () => {},
      true,
    );
    const metadata = await folder.getDirectoryHandle("metadata");
    const receiptFile = await metadata.getFileHandle(
      `${f.inventory.recording.participantId}.archive.json`,
    );
    const receipt = JSON.parse(await (await receiptFile.getFile()).text());
    receipt.path[0] = "testraum";
    const other = await f.handle.getDirectoryHandle("testraum", {
      create: true,
    });
    await other.getDirectoryHandle(folder.name, { create: true });
    const writer = await receiptFile.createWritable();
    await writer.write(new TextEncoder().encode(JSON.stringify(receipt)));
    await writer.close();
    expect(await f.store.list()).toEqual([]);
    expect(await f.store.sessions()).toEqual([]);
    expect(await f.store.catalogs()).toEqual([]);
    expect(f.store.scanIssues).toHaveLength(1);
    expect(f.store.scanIssues.join("\n")).toContain("Ungültiger Ablagebeleg");
  });
  it("protects an ongoing export from expiry and serializes a second tab exporting the same take", async () => {
    const held = new Map<string, number>(),
      tails = new Map<string, Promise<unknown>>();
    vi.stubGlobal("navigator", {
      locks: {
        query: async () => ({
          held: [...held.keys()].map((name) => ({ name })),
        }),
        request: (
          name: string,
          options:
            | { ifAvailable?: boolean; mode?: string }
            | ((lock: unknown) => Promise<unknown>),
          callback?: (lock: unknown) => Promise<unknown>,
        ) => {
          const call = typeof options === "function" ? options : callback!;
          if (
            typeof options !== "function" &&
            options.ifAvailable &&
            held.has(name)
          )
            return Promise.resolve(call(null));
          const run = async () => {
            held.set(name, (held.get(name) ?? 0) + 1);
            try {
              return await call({ name });
            } finally {
              const count = held.get(name)! - 1;
              if (count) held.set(name, count);
              else held.delete(name);
            }
          };
          if (typeof options !== "function" && options.mode === "shared")
            return run();
          const job = (tails.get(name) ?? Promise.resolve()).then(run);
          tails.set(
            name,
            job.catch(() => {}),
          );
          return job;
        },
      },
    });
    const f = await fixture();
    let resume!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve)),
      ready = new Promise<void>((resolve) => (entered = resolve));
    const read = f.store.segmentBytes.bind(f.store);
    const segmentRead = vi
      .spyOn(f.store, "segmentBytes")
      .mockImplementationOnce(async (segment) => {
        entered();
        await gate;
        return read(segment);
      });
    const first = exportSession(
      f.store,
      [f.inventory],
      f.handle,
      () => {},
      true,
    );
    await ready;
    const second = exportSession(
      f.store,
      [f.inventory],
      f.handle,
      () => {},
      true,
    );
    await f.store.housekeeping(
      Date.parse(f.inventory.recording.createdAt) + 7 * 24 * 60 * 60_000 + 1,
    );
    expect(
      await f.store.participant(
        f.inventory.recording.recordingId,
        f.inventory.recording.participantId,
      ),
    ).toBeTruthy();
    expect(segmentRead).toHaveBeenCalledTimes(1);
    resume();
    const [a, b] = await Promise.all([first, second]);
    expect(a.name).toBe(b.name);
    await verifyRetriedExport(a);
    expect((await f.store.list())[0].complete).toBe(true);
    await expect(
      f.store.participant(
        f.inventory.recording.recordingId,
        f.inventory.recording.participantId,
      ),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("reads long-take catalogs exceeding the smaller per-file JSON budget", async () => {
    const f = await fixture();
    const folder = await exportSession(
      f.store,
      [f.inventory],
      f.handle,
      () => {},
      true,
    );
    const file = await (
      await folder.getDirectoryHandle("metadata")
    ).getFileHandle(`${f.inventory.recording.participantId}.archive.json`);
    const contents = await (await file.getFile()).text();
    const writable = await file.createWritable();
    await writable.write(
      new TextEncoder().encode(contents.padEnd(16 * 1024 * 1024 + 1, " ")),
    );
    await writable.close();
    expect((await f.store.list())[0].complete).toBe(true);
  });
  it.each([
    [".mp4", "open"],
    [".mp4", "write"],
    [".mp4", "close"],
    [".wav", "open"],
    [".wav", "write"],
    [".wav", "close"],
  ] as const)(
    "rebuilds a %s export after a transient Windows error at %s",
    async (extension, stage) => {
      retryPolicy.delays = [1, 1, 1, 1, 1];
      const f = await fixture();
      const { folder, fault } = await lockedExport(f.root, extension, stage);
      await exportRecording(
        f.store,
        f.inventory,
        f.handle,
        () => {},
        folder.name,
      );
      expect(fault.attempts).toBe(2);
      await verifyRetriedExport(folder as unknown as FileSystemDirectoryHandle);
      const original = await f.store.scan(
        f.inventory.recording.recordingId,
        f.inventory.recording.participantId,
      );
      expect(original.complete).toBe(true);
      expect(original.segments.map((s) => s.sha256)).toEqual(
        f.inventory.segments.map((s) => s.sha256),
      );
    },
  );
  it.each([".mp4", ".wav"])(
    "bounds a permanently locked %s export and allows later recovery",
    async (extension) => {
      retryPolicy.delays = [1, 1, 1, 1, 1];
      const f = await fixture();
      const { folder, fault } = await lockedExport(
        f.root,
        extension,
        "close",
        20,
      );
      await expect(
        exportRecording(f.store, f.inventory, f.handle, () => {}, folder.name),
      ).rejects.toThrow(
        /Exportieren von .*: Datei blieb nach 6 Versuchen gesperrt \(InvalidStateError\)/,
      );
      expect(fault.attempts).toBe(6);
      await expect(
        (await folder.getDirectoryHandle("metadata")).getFileHandle(
          "export.json",
        ),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      expect(
        (
          await f.store.scan(
            f.inventory.recording.recordingId,
            f.inventory.recording.participantId,
          )
        ).complete,
      ).toBe(true);
      fault.failures = 0;
      await exportRecording(
        f.store,
        f.inventory,
        f.handle,
        () => {},
        folder.name,
      );
      await verifyRetriedExport(folder as unknown as FileSystemDirectoryHandle);
    },
  );
  it("collects flat media in the named room with all participant metadata and skips finished exports", async () => {
    const f = await fixture(false, {
      roomId: crypto.randomUUID(),
      sessionName: "Podcast",
    });
    const output = await exportSession(
      f.store,
      [f.inventory],
      f.handle,
      () => {},
    );
    expect(output.name).toBe(
      `Aufnahme-${sessionStamp(f.inventory.recording.createdAt)}-${f.inventory.recording.recordingId.slice(0, 12)}`,
    );
    expect(sessionStamp(f.inventory.recording.createdAt)).toMatch(
      /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/,
    );
    const metadata = await output.getDirectoryHandle("metadata");
    const manifest = JSON.parse(
      await (
        await (await metadata.getFileHandle("session.json")).getFile()
      ).text(),
    );
    expect(manifest).toMatchObject({
      formatVersion: 3,
      sessionId: f.inventory.recording.recordingId,
      roomId: f.inventory.recording.roomId,
    });
    expect(manifest.recordings).toHaveLength(1);
    await expect(
      exportSession(
        f.store,
        [
          f.inventory,
          {
            ...f.inventory,
            recording: {
              ...f.inventory.recording,
              recordingId: crypto.randomUUID(),
            },
          },
        ],
        f.handle,
        () => {},
      ),
    ).rejects.toThrow("verschiedenen Sitzungen");
    const take = output;
    expect((await f.handle.getDirectoryHandle("Podcast")).name).toBe("Podcast");
    expect(
      (await Array.fromAsync(take.values()))
        .filter((e) => e.kind === "directory")
        .map((e) => e.name),
    ).toEqual(["metadata"]);
    expect(
      await (
        await take.getDirectoryHandle("metadata")
      ).getFileHandle(`${f.inventory.recording.participantId}.timeline.json`),
    ).toBeTruthy();
    expect(
      (await Array.fromAsync(take.values())).filter(
        (entry) => entry.kind === "file",
      ),
    ).toHaveLength(2);
    // Remuxing already finished media would recreate writable streams. A second
    // automatic pass must only update the session manifest.
    for await (const entry of take.values())
      if (entry.kind === "file")
        (entry as any).createWritable = () => {
          throw new Error("Unexpected media rewrite");
        };
    const repeated = await exportSession(
      f.store,
      [f.inventory],
      f.handle,
      () => {},
    );
    expect(repeated.name).toBe(output.name);
  });
  it("keeps the same flat folder when a late guest arrives after the master's staging files were removed", async () => {
    const startedAt = "2026-10-09T08:00:00.000Z";
    const context = {
      recordingId: crypto.randomUUID(),
      roomId: crypto.randomUUID(),
      sessionName: "Podcast / Test",
      sessionStartedAt: startedAt,
      participantName: "Host",
    };
    const host = await fixture(false, { ...context, createdAt: startedAt });
    const guest = await fixture(
      false,
      { ...context, createdAt: "2026-10-09T08:00:01.250Z" },
      host.root,
    );
    await host.store.writeSession({
      formatVersion: 1,
      recordingId: context.recordingId,
      roomId: context.roomId,
      roomName: context.sessionName,
      startedAt,
      participants: [host, guest].map((f, i) => ({
        id: f.inventory.recording.participantId,
        name: "Host",
        role: i ? "guest" : "host",
        state: "saved",
        bytes: f.inventory.segments.reduce((n, s) => n + s.byteLength, 0),
      })),
    });
    const folder = await exportSession(
      host.store,
      [host.inventory],
      host.handle,
      () => {},
      true,
    );
    await expect(
      host.store.participant(
        context.recordingId,
        host.inventory.recording.participantId,
      ),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    const before = await host.store.list();
    expect(before).toHaveLength(2);
    const repeated = await exportSession(
      host.store,
      before,
      host.handle,
      () => {},
      true,
    );
    expect(repeated.name).toBe(folder.name);
    const files = (await Array.fromAsync(folder.values())).filter(
      (e) => e.kind === "file",
    );
    expect(files).toHaveLength(4);
    expect(new Set(files.map((f) => f.name)).size).toBe(4);
    expect(files.filter((f) => f.name.endsWith(".mp4"))).toHaveLength(2);
    expect(files.filter((f) => f.name.endsWith(".wav"))).toHaveLength(2);
    expect(
      await Array.fromAsync(
        (await host.handle.getDirectoryHandle("local")).values(),
      ),
    ).toEqual([]);
    const metadata = await folder.getDirectoryHandle("metadata");
    const session = JSON.parse(
      await (
        await (await metadata.getFileHandle("session.json")).getFile()
      ).text(),
    );
    expect(session.recordings).toHaveLength(2);
    expect(session.pendingParticipants).toEqual([]);
    for (const f of [host, guest]) {
      const entry = session.recordings.find(
        (r: any) =>
          r.recording.participantId === f.inventory.recording.participantId,
      );
      expect(entry.metadataFiles.map((m: any) => m.path)).toContain(
        "completion.json",
      );
      for (const item of entry.metadataFiles)
        expect(
          (await (await metadata.getFileHandle(item.file)).getFile()).size,
        ).toBe(item.bytes);
    }
    expect(await host.store.sessions()).toHaveLength(1);
    const restored = await new LocalStore(host.handle).list();
    expect(restored).toHaveLength(2);
    expect(restored.every((i) => i.complete)).toBe(true);
    await exportSession(host.store, restored, host.handle, () => {}, true);
    expect(
      await Array.fromAsync(
        (await host.handle.getDirectoryHandle("local")).values(),
      ),
    ).toEqual([]);
  });
  it("does not clear local originals when a cutter file cannot be finalized", async () => {
    const f = await fixture();
    const room = await f.handle.getDirectoryHandle("Lokale-Aufnahmen", {
      create: true,
    });
    const take = await room.getDirectoryHandle(
      `Aufnahme-${sessionStamp(f.inventory.recording.createdAt)}-${f.inventory.recording.recordingId.slice(0, 12)}`,
      { create: true },
    );
    (take as unknown as MemoryDirectory).failCloseFor = ".wav";
    await expect(
      exportSession(f.store, [f.inventory], f.handle, () => {}, true),
    ).rejects.toThrow("Disk failure at close");
    expect(
      (
        await f.store.scan(
          f.inventory.recording.recordingId,
          f.inventory.recording.participantId,
        )
      ).complete,
    ).toBe(true);
    expect(await f.store.catalogs()).toEqual([]);
  });
  it("detects even same-length corruption in a finished cutter file", async () => {
    const f = await fixture();
    const folder = await exportSession(
      f.store,
      [f.inventory],
      f.handle,
      () => {},
      true,
    );
    const wav = (await Array.fromAsync(folder.values())).find(
      (e) => e.kind === "file" && e.name.endsWith(".wav"),
    )!;
    const handle = wav as FileSystemFileHandle;
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    bytes[bytes.length - 1] ^= 1;
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    expect(await f.store.list()).toEqual([]);
    expect(f.store.scanIssues.join(" ")).toContain("Exportdatei verändert");
  });
  it.each([false, true])(
    "retires a verified legacy export but preserves user additions (%s)",
    async (extra) => {
      const f = await fixture(false, { sessionName: "Podcast" });
      const old = await f.handle.getDirectoryHandle(
        `LocalTake-${sessionStamp(f.inventory.recording.createdAt)}-${f.inventory.recording.recordingId.slice(0, 8)}`,
        { create: true },
      );
      const participant = await old.getDirectoryHandle(
        `Host-${f.inventory.recording.participantId.slice(0, 8)}`,
        { create: true },
      );
      const take = await exportRecording(
        f.store,
        f.inventory,
        participant,
        () => {},
        "Take-old",
      );
      const metadata = await old.getDirectoryHandle("metadata", {
        create: true,
      });
      const stream = await (
        await metadata.getFileHandle("session.json", { create: true })
      ).createWritable();
      await stream.write(
        new TextEncoder().encode(
          JSON.stringify({
            formatVersion: 2,
            sessionId: f.inventory.recording.recordingId,
            recordings: [
              {
                recording: f.inventory.recording,
                folder: `${participant.name}/${take.name}`,
              },
            ],
          }),
        ),
      );
      await stream.close();
      if (extra) await old.getFileHandle("cutter-notes.txt", { create: true });
      await exportSession(f.store, [f.inventory], f.handle, () => {}, true);
      if (extra)
        expect(await f.handle.getDirectoryHandle(old.name)).toBeTruthy();
      else
        await expect(
          f.handle.getDirectoryHandle(old.name),
        ).rejects.toMatchObject({ name: "NotFoundError" });
    },
  );
  it("fits native Windows folder and .crswap limits with maximum room and participant names", async () => {
    const root = new MemoryDirectory("TMP_LOCALTAKE"),
      wrapped = new WeakSet<MemoryDirectory>();
    const windows = (dir: MemoryDirectory, path: string) => {
      if (wrapped.has(dir)) return dir;
      wrapped.add(dir);
      const getDir = dir.getDirectoryHandle.bind(dir),
        getFile = dir.getFileHandle.bind(dir);
      dir.getDirectoryHandle = async (name, options) => {
        if (`${path}\\${name}`.length > 248)
          throw new DOMException("Long directory", "InvalidStateError");
        return windows(await getDir(name, options), `${path}\\${name}`);
      };
      dir.getFileHandle = async (name, options) => {
        if (`${path}\\${name}.crswap`.length > 259)
          throw new DOMException("Long swap file", "InvalidStateError");
        return getFile(name, options);
      };
      return dir;
    };
    windows(root, "C:\\Users\\Demo\\Desktop\\TMP_LOCALTAKE");
    const f = await fixture(
      false,
      { sessionName: "R".repeat(60), participantName: "P".repeat(60) },
      root,
    );
    await f.store.preflight();
    const output = await exportSession(
      f.store,
      [f.inventory],
      f.handle,
      () => {},
      true,
    );
    await verifyRetriedExport(output);
    expect((await f.store.list())[0].complete).toBe(true);
  });
  it("preserves irregular capture timestamps without collapsing adjacent frames", async () => {
    const f = await fixture(true);
    const folder = await exportRecording(
      f.store,
      f.inventory,
      f.handle,
      () => {},
    );
    for await (const entry of folder.values()) {
      if (entry.kind !== "file" || !entry.name.endsWith(".mp4")) continue;
      const file = await (entry as FileSystemFileHandle).getFile();
      const input = new Input({ formats: [MP4], source: new BlobSource(file) });
      try {
        const track = (await input.getPrimaryVideoTrack())!;
        const timestamps = [];
        for await (const packet of new EncodedPacketSink(track).packets())
          timestamps.push(packet.timestamp);
        expect(timestamps).toHaveLength(40);
        for (let index = 0; index < 40; index++) {
          const local = index % 20;
          const expected =
            (index >= 20 ? 2 : 0) +
            (local === 1 ? 0.151 : local === 2 ? 0.249 : local / 10);
          // MP4 uses Mediabunny's default 57,600 Hz timescale.
          expect(Math.abs(timestamps[index] - expected)).toBeLessThanOrEqual(
            1 / 57600,
          );
          if (index)
            expect(timestamps[index]).toBeGreaterThan(timestamps[index - 1]);
        }
      } finally {
        input.dispose();
      }
    }
  });
  it("remuxes forty H.264 frames and preserves all PCM samples across segment boundaries", async () => {
    const f = await fixture();
    expect(f.inventory.complete).toBe(true);
    const output = await exportRecording(
      f.store,
      f.inventory,
      f.handle,
      () => {},
    );
    const files: File[] = [];
    for await (const entry of output.values())
      if (entry.kind === "file")
        files.push(await (entry as FileSystemFileHandle).getFile());
    const mp4 = files.find((file) => file.name.endsWith(".mp4"))!;
    const input = new Input({ formats: [MP4], source: new BlobSource(mp4) });
    try {
      const track = (await input.getPrimaryVideoTrack())!;
      expect(track.displayWidth).toBe(320);
      expect(track.displayHeight).toBe(180);
      const packets = [];
      for await (const packet of new EncodedPacketSink(track).packets())
        packets.push(packet);
      expect(packets).toHaveLength(40);
      expect(packets.map((p) => p.timestamp)).toEqual(
        Array.from({ length: 40 }, (_, i) => i / 10),
      );
    } finally {
      input.dispose();
    }
    const wav = files.find((file) => file.name.endsWith(".wav"))!;
    const data = new DataView(await wav.arrayBuffer());
    expect(data.byteLength).toBe(56 + 192000 * 4);
    expect(data.getUint32(24, true)).toBe(48000);
    for (let index = 0; index < 192000; index++)
      expect(data.getFloat32(56 + index * 4, true)).toBe(
        index < 96000 ? 0.25 : -0.25,
      );
    const timeline = JSON.parse(
      await (
        await (
          await output.getDirectoryHandle("metadata")
        ).getFileHandle("timeline.json")
      )
        .getFile()
        .then((f) => f.text()),
    );
    expect(timeline.complete).toBe(true);
    expect(
      timeline.outputs.map((o: { durationUs: number }) => o.durationUs),
    ).toEqual([4_000_000, 4_000_000]);
    if (process.env.LOCALTAKE_EXPORT_VALIDATION_DIR) {
      await mkdir(process.env.LOCALTAKE_EXPORT_VALIDATION_DIR, {
        recursive: true,
      });
      for (const file of files)
        await writeFile(
          join(
            process.env.LOCALTAKE_EXPORT_VALIDATION_DIR,
            file.name.endsWith(".mp4")
              ? "video.mp4"
              : file.name.endsWith(".wav")
                ? "audio.wav"
                : file.name,
          ),
          new Uint8Array(await file.arrayBuffer()),
        );
    }
  });
  it("refuses originals changed after the inventory hash check", async () => {
    const f = await fixture();
    const segment = f.inventory.segments.find((s) =>
      s.fileName.endsWith(".wav"),
    )!;
    let dir = await f.store.participant(
      segment.recordingId,
      segment.participantId,
    );
    for (const name of ["tracks", segment.trackId, segment.epochId])
      dir = await dir.getDirectoryHandle(name);
    const handle = await dir.getFileHandle(segment.fileName);
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    bytes[bytes.length - 1] ^= 1;
    const writer = await handle.createWritable();
    await writer.write(bytes);
    await writer.close();
    await expect(
      exportRecording(f.store, f.inventory, f.handle, () => {}),
    ).rejects.toThrow("nach der Archivprüfung verändert");
  });
});
