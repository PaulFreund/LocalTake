import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalStore,
  writeImmutable,
  readStableFile,
  retryPolicy,
} from "../apps/client/src/storage/store.js";
import type {
  RecordingMeta,
  TrackMeta,
} from "../packages/protocol/src/index.js";

// A crash-aware filesystem double: writes become visible only at close, like FSA.
class MemoryDirectory {
  kind = "directory";
  entries = new Map<string, MemoryDirectory | MemoryFile>();
  failCloseFor = "";
  // Chromium on Windows: the .crswap move fails while another process holds the file.
  lockedCloses = 0;
  constructor(readonly name = "root") {}
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let entry = this.entries.get(name);
    if (!entry && options?.create) {
      entry = new MemoryDirectory(name);
      this.entries.set(name, entry);
    }
    if (!entry) throw new DOMException("Not found", "NotFoundError");
    if (!(entry instanceof MemoryDirectory)) throw new Error("Not a directory");
    return entry;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    let entry = this.entries.get(name);
    if (!entry && options?.create) {
      entry = new MemoryFile(name, this);
      this.entries.set(name, entry);
    }
    if (!entry) throw new DOMException("Not found", "NotFoundError");
    if (!(entry instanceof MemoryFile)) throw new Error("Not a file");
    return entry;
  }
  async *values() {
    yield* this.entries.values();
  }
  async removeEntry(name: string) {
    this.entries.delete(name);
  }
}
class MemoryFile {
  kind = "file";
  bytes = new Uint8Array();
  constructor(
    readonly name: string,
    readonly parent: MemoryDirectory,
  ) {}
  async getFile() {
    return new File([this.bytes], this.name);
  }
  async createWritable() {
    let pending = new Uint8Array();
    return {
      write: async (bytes: ArrayBuffer) => {
        pending = new Uint8Array(bytes).slice();
      },
      close: async () => {
        if (
          this.name.endsWith(this.parent.failCloseFor) &&
          this.parent.failCloseFor
        )
          throw new Error("Disk failure at close");
        if (this.parent.lockedCloses > 0) {
          this.parent.lockedCloses--;
          throw new DOMException(
            "An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.",
            "InvalidStateError",
          );
        }
        this.bytes = pending;
      },
      abort: async () => {},
    };
  }
}
const delays = retryPolicy.delays;
afterEach(() => {
  retryPolicy.delays = delays;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
// Chrome/Edge on Windows are not long-path aware: CreateDirectory fails above
// 248 characters (reported as InvalidStateError), files and their .crswap
// above 259 (NotFoundError).
class WindowsDirectory extends MemoryDirectory {
  constructor(
    name: string,
    readonly path: string,
  ) {
    super(name);
  }
  override async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ) {
    const path = `${this.path}\\${name}`;
    if (!this.entries.has(name) && options?.create) {
      if (path.length > 248)
        throw new DOMException(
          "An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.",
          "InvalidStateError",
        );
      this.entries.set(name, new WindowsDirectory(name, path));
    }
    return super.getDirectoryHandle(name, options);
  }
  override async getFileHandle(name: string, options?: { create?: boolean }) {
    if (`${this.path}\\${name}.crswap`.length > 259)
      throw new DOMException("Path not found", "NotFoundError");
    return super.getFileHandle(name, options);
  }
}
const windowsStore = (path: string) =>
  new LocalStore(
    new WindowsDirectory(
      path.split("\\").at(-1)!,
      path,
    ) as unknown as FileSystemDirectoryHandle,
  );
function fixture(cacheDirectories = false) {
  const root = new MemoryDirectory(),
    store = new LocalStore(
      root as unknown as FileSystemDirectoryHandle,
      "local",
      {
        cacheDirectories,
      },
    );
  const trackId = crypto.randomUUID();
  const recording: RecordingMeta = {
    formatVersion: 1,
    recordingId: crypto.randomUUID(),
    participantId: crypto.randomUUID(),
    participantName: "Test",
    createdAt: new Date().toISOString(),
    appVersion: "test",
    trackIds: [trackId],
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
  const info = {
    sequence: 0,
    fileName: "000000_000000000000us.wav",
    mediaStartUs: 0,
    mediaDurationUs: 2_000_000,
    sampleStart: 0,
    sampleCount: 96_000,
  };
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  return { root, store, recording, track, info, bytes };
}
describe("local recording durability contract", () => {
  it("independently rejects a late short original even if completion calls every source saved", async () => {
    const f = fixture();
    f.track.localStartMs = 3910;
    const info = { ...f.info, mediaDurationUs: 33333, sampleCount: 1600 };
    await f.store.initialize(f.recording);
    await f.store.initializeTrack(f.recording, f.track);
    await f.store.commit(f.recording, f.track, info, f.bytes);
    await f.store.finish(f.recording, {
      formatVersion: 1,
      recordingId: f.recording.recordingId,
      participantId: f.recording.participantId,
      finishedAt: new Date().toISOString(),
      sources: [
        {
          trackId: f.track.trackId,
          label: f.track.label,
          kind: "audio",
          state: "saved",
          savedSeconds: 0.033333,
          capturedSeconds: 0.033333,
          bytes: f.bytes.byteLength,
          segments: 1,
        },
      ],
      timing: { startMs: 10, stopMs: 4010 },
      issues: [],
    });
    const scanned = await f.store.scan(
      f.recording.recordingId,
      f.recording.participantId,
    );
    expect(scanned.complete).toBe(false);
    expect(scanned.issues.join(" ")).toContain("Aufnahme unvollständig");
    expect(scanned.segments).toHaveLength(1);
  });
  it("reuses writer directories across segments and still verifies fresh file contents", async () => {
    const f = fixture(true);
    await f.store.initialize(f.recording);
    await f.store.initializeTrack(f.recording, f.track);
    const lookup = vi.spyOn(MemoryDirectory.prototype, "getDirectoryHandle");
    const first = await f.store.commit(f.recording, f.track, f.info, f.bytes);
    const second = await f.store.commit(
      f.recording,
      f.track,
      {
        ...f.info,
        sequence: 1,
        fileName: "000001_000002000000us.wav",
        mediaStartUs: 2_000_000,
        sampleStart: 96_000,
      },
      f.bytes,
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(first.sha256).toEqual(second.sha256);
    const base = await f.store.participant(
      f.recording.recordingId,
      f.recording.participantId,
    );
    const tracks = await base.getDirectoryHandle("tracks");
    const track = await tracks.getDirectoryHandle(f.track.trackId);
    const epoch = await track.getDirectoryHandle(f.track.epochId);
    const file = (await epoch.getFileHandle(
      first.fileName,
    )) as unknown as MemoryFile;
    file.bytes = new Uint8Array([9, 9, 9, 9]);
    await expect(
      f.store.commit(f.recording, f.track, f.info, f.bytes),
    ).rejects.toThrow("Dateikonflikt");
    expect([...file.bytes]).toEqual([9, 9, 9, 9]);
    expect(new Uint8Array(await f.store.segmentBytes(second))).toEqual(
      new Uint8Array(f.bytes),
    );
  });
  it("does not create missing track directories on commit or retain failed writer lookups", async () => {
    const f = fixture(true);
    await f.store.initialize(f.recording);
    await expect(
      f.store.commit(f.recording, f.track, f.info, f.bytes),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    const base = (await f.store.participant(
      f.recording.recordingId,
      f.recording.participantId,
    )) as unknown as MemoryDirectory;
    expect(base.entries.has("tracks")).toBe(false);
    await f.store.initializeTrack(f.recording, f.track);
    const receipt = await f.store.commit(f.recording, f.track, f.info, f.bytes);
    expect(receipt.byteLength).toBe(f.bytes.byteLength);
    const inventory = await f.store.scan(
      f.recording.recordingId,
      f.recording.participantId,
    );
    expect(inventory.segments).toHaveLength(1);
    expect(inventory.tracks[0].clock).toEqual(f.track.clock);
  });
  it("reports a pending native close and clears progress only after verified readback", async () => {
    const root = new MemoryDirectory();
    const file = await root.getFileHandle("original.wav", { create: true });
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const createWritable = file.createWritable.bind(file);
    vi.spyOn(file, "createWritable").mockImplementation(async () => {
      const stream = await createWritable();
      return {
        ...stream,
        close: async () => {
          await closeGate;
          await stream.close();
        },
      };
    });
    const stages: (string | undefined)[] = [];
    const operation = writeImmutable(
      root as unknown as FileSystemDirectoryHandle,
      "original.wav",
      new Uint8Array([3, 4]).buffer,
      (stage) => {
        stages.push(stage);
      },
    );
    try {
      await vi.waitFor(() =>
        expect(stages.at(-1)).toBe("original.wav: Schließen"),
      );
      expect(file.bytes).toHaveLength(0);
    } finally {
      finishClose();
    }
    await operation;
    expect(stages).toContain("original.wav: Zurücklesen und prüfen");
    expect(stages.at(-1)).toBeUndefined();
    expect([...file.bytes]).toEqual([3, 4]);
    await expect(
      writeImmutable(
        root as unknown as FileSystemDirectoryHandle,
        "other.wav",
        new Uint8Array([5]).buffer,
        () => {
          throw Error("Diagnostic observer failure");
        },
      ),
    ).resolves.toMatch(/^[a-f0-9]{64}$/);
  });
  it("reacquires stale native File snapshots after close before certifying an original", async () => {
    const root = new MemoryDirectory();
    const original = await root.getFileHandle("original.mp4", { create: true });
    const getFile = original.getFile.bind(original);
    let failures = 2;
    original.getFile = async () => {
      const file = await getFile();
      if (file.size && failures-- > 0)
        file.arrayBuffer = async () => {
          throw new DOMException(
            "Snapshot state changed since disk read",
            "NotReadableError",
          );
        };
      return file;
    };
    await writeImmutable(
      root as unknown as FileSystemDirectoryHandle,
      "original.mp4",
      new Uint8Array([1, 2, 3]).buffer,
    );
    expect([
      ...new Uint8Array(
        (
          await readStableFile(
            root as unknown as FileSystemDirectoryHandle,
            "original.mp4",
          )
        ).bytes,
      ),
    ]).toEqual([1, 2, 3]);
    expect(failures).toBeLessThan(0);
  });
  it("retries a briefly locked file on close and still verifies the original", async () => {
    retryPolicy.delays = [1, 1, 1];
    const root = new MemoryDirectory();
    root.lockedCloses = 2;
    const dir = root as unknown as FileSystemDirectoryHandle;
    await writeImmutable(dir, "original.mp4", new Uint8Array([5, 6]).buffer);
    expect(root.lockedCloses).toBe(0);
    expect([
      ...new Uint8Array((await readStableFile(dir, "original.mp4")).bytes),
    ]).toEqual([5, 6]);
  });
  it("names the file and the likely cause when a lock persists", async () => {
    retryPolicy.delays = [1, 1];
    const root = new MemoryDirectory();
    root.lockedCloses = 10;
    await expect(
      writeImmutable(
        root as unknown as FileSystemDirectoryHandle,
        "000001_000002000000us.mp4",
        new Uint8Array([1]).buffer,
      ),
    ).rejects.toThrow(
      /Speichern von 000001_000002000000us\.mp4: Datei blieb nach 3 Versuchen gesperrt \(InvalidStateError\)/,
    );
    expect(root.lockedCloses).toBe(7);
  });
  it("checks the full recording depth against the Windows path limit", async () => {
    vi.stubGlobal("navigator", { userAgent: "Windows NT 10.0" });
    retryPolicy.delays = [1];
    const fits = windowsStore("C:\\Users\\Demo\\Desktop\\TMP_LOCALTAKE");
    await fits.preflight();
    // What passes the check also fits a real take, including its receipts.
    const f = fixture();
    const store = windowsStore("C:\\Users\\Demo\\Desktop\\TMP_LOCALTAKE");
    await store.initialize(f.recording);
    await store.initializeTrack(f.recording, f.track);
    await store.commit(f.recording, f.track, f.info, f.bytes);
    expect((await store.list())[0].segments).toHaveLength(1);
    // The depth probe leaves nothing behind.
    const probed = await (
      fits.root as unknown as MemoryDirectory
    ).getDirectoryHandle("temp");
    expect([...probed.entries.keys()]).toEqual([]);
    const deep = windowsStore(
      "C:\\Users\\Demo\\Example Organization\\Projects\\Podcast 2026\\Recordings\\TMP_LOCALTAKE",
    );
    await expect(deep.preflight()).rejects.toThrow(/Pfad zu lang/);
  });
  it("hides device checks from the archive and removes only checks", async () => {
    const f = fixture();
    const check = {
      ...f.recording,
      recordingId: crypto.randomUUID(),
      purpose: "check" as const,
    };
    await f.store.initialize(f.recording);
    await f.store.initialize(check);
    expect((await f.store.list()).map((i) => i.recording.recordingId)).toEqual([
      f.recording.recordingId,
    ]);
    expect(f.store.leftoverChecks).toEqual([
      { recordingId: check.recordingId, createdAt: check.createdAt },
    ]);
    await expect(f.store.removeCheck(f.recording.recordingId)).rejects.toThrow(
      "Keine reine Prüfaufnahme",
    );
    await f.store.removeCheck(check.recordingId);
    await f.store.list();
    expect(f.store.leftoverChecks).toEqual([]);
    expect(await f.store.list()).toHaveLength(1);
  });
  it("keeps a session manifest next to the participant folders", async () => {
    const f = fixture();
    await f.store.initialize(f.recording);
    const manifest = {
      formatVersion: 1 as const,
      recordingId: f.recording.recordingId,
      roomId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      participants: [
        {
          id: f.recording.participantId,
          name: "Host",
          role: "host" as const,
        },
        {
          id: crypto.randomUUID(),
          name: "Gast",
          role: "guest" as const,
          state: "saved" as const,
          bytes: 1234,
        },
      ],
    };
    await f.store.writeSession(manifest);
    await f.store.writeSession({
      ...manifest,
      participants: [manifest.participants[0]],
    });
    expect(await f.store.sessions()).toEqual([
      { ...manifest, participants: [manifest.participants[0]] },
    ]);
    expect((await f.store.list()).map((i) => i.recording.recordingId)).toEqual([
      f.recording.recordingId,
    ]);
    expect(f.store.scanIssues).toEqual([]);
  });
  it("resumes an empty pre-close placeholder but preserves non-empty conflicts", async () => {
    const root = new MemoryDirectory();
    const handle = await root.getFileHandle("original.wav", { create: true });
    const dir = root as unknown as FileSystemDirectoryHandle;
    await writeImmutable(dir, "original.wav", new Uint8Array([1, 2]).buffer);
    expect([...handle.bytes]).toEqual([1, 2]);
    await expect(
      writeImmutable(dir, "original.wav", new Uint8Array([3, 4]).buffer),
    ).rejects.toThrow("Dateikonflikt");
    expect([...handle.bytes]).toEqual([1, 2]);
  });
  it("lists healthy recordings even when another recording metadata file is corrupt", async () => {
    const f = fixture();
    await f.store.initialize(f.recording);
    const broken = { ...f.recording, recordingId: crypto.randomUUID() };
    await f.store.initialize(broken);
    const base = await f.store.participant(
      broken.recordingId,
      broken.participantId,
    );
    const file = (await base.getFileHandle(
      "recording.json",
    )) as unknown as MemoryFile;
    file.bytes = new TextEncoder().encode("{broken");
    expect((await f.store.list()).map((i) => i.recording.recordingId)).toEqual([
      f.recording.recordingId,
    ]);
    expect(f.store.scanIssues).toHaveLength(1);
    expect(f.store.scanIssues[0]).toContain(broken.recordingId);
  });
  it("recovers confirmed segments without a completion file or browser database", async () => {
    const f = fixture();
    await f.store.initialize(f.recording);
    await f.store.initializeTrack(f.recording, f.track);
    const committed = await f.store.commit(
      f.recording,
      f.track,
      f.info,
      f.bytes,
    );
    const recovery = new LocalStore(
      f.root as unknown as FileSystemDirectoryHandle,
    );
    const [inventory] = await recovery.list();
    expect(inventory.segments[0].sha256).toBe(committed.sha256);
    expect(inventory.complete).toBe(false);
    expect(inventory.issues.join(" ")).toContain("Teilbestand");
  });
  it("does not certify media when the receipt cannot be closed", async () => {
    const f = fixture();
    await f.store.initialize(f.recording);
    await f.store.initializeTrack(f.recording, f.track);
    let dir = f.root;
    for (const name of [
      "local",
      f.recording.recordingId,
      f.recording.participantId,
      "tracks",
      f.track.trackId,
      f.track.epochId,
    ])
      dir = await dir.getDirectoryHandle(name);
    dir.failCloseFor = ".segment.json";
    await expect(
      f.store.commit(f.recording, f.track, f.info, f.bytes),
    ).rejects.toThrow("Disk failure");
    const [inventory] = await f.store.list();
    expect(inventory.complete).toBe(false);
    expect(inventory.segments).toHaveLength(0);
    expect(inventory.issues.join(" ")).toContain("ohne gültigen Speicherbeleg");
  });
  it("detects post-commit corruption and never overwrites conflicting originals", async () => {
    const f = fixture();
    await f.store.initialize(f.recording);
    await f.store.initializeTrack(f.recording, f.track);
    await f.store.commit(f.recording, f.track, f.info, f.bytes);
    let dir = f.root;
    for (const name of [
      "local",
      f.recording.recordingId,
      f.recording.participantId,
      "tracks",
      f.track.trackId,
      f.track.epochId,
    ])
      dir = await dir.getDirectoryHandle(name);
    const file = await dir.getFileHandle(f.info.fileName);
    file.bytes[0] = 99;
    expect((await f.store.list())[0].segments).toHaveLength(0);
    await expect(
      f.store.commit(f.recording, f.track, f.info, f.bytes),
    ).rejects.toThrow("Dateikonflikt");
    expect(file.bytes[0]).toBe(99);
  });
  it("only reports complete after matching durable completion counters", async () => {
    const f = fixture();
    await f.store.initialize(f.recording);
    await f.store.initializeTrack(f.recording, f.track);
    await f.store.commit(f.recording, f.track, f.info, f.bytes);
    await f.store.finish(f.recording, {
      formatVersion: 1,
      recordingId: f.recording.recordingId,
      participantId: f.recording.participantId,
      finishedAt: new Date().toISOString(),
      sources: [
        {
          trackId: f.track.trackId,
          label: "Mic",
          kind: "audio",
          state: "saved",
          savedSeconds: 2,
          capturedSeconds: 2,
          segments: 1,
          bytes: 4,
        },
      ],
    });
    expect((await f.store.list())[0].complete).toBe(true);
  });
});
