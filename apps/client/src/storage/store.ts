import {
  completionSchema,
  idSchema,
  inventorySchema,
  recordingMetaSchema,
  segmentSchema,
  sessionManifestSchema,
  trackMetaSchema,
  type ClockMapping,
  type Completion,
  type Inventory,
  type RecordingMeta,
  type Segment,
  type SessionManifest,
  type TrackMeta,
} from "../../../../packages/protocol/src/index.js";
import { LOCAL_RETENTION_MS, takePath } from "./layout.js";

export type StoredInventory = Inventory & {
  archive?: Catalog;
  transferredTo?: string;
};
export type Catalog = {
  formatVersion: 1;
  type: "archive" | "transfer";
  path: [string, string];
  inventory: Inventory;
  fingerprint: string;
  files: ExportFile[];
  originals: { path: string; bytes: number; hash: string }[];
  metadataFiles?: { path: string; file: string; bytes: number; hash: string }[];
  destinationId?: string;
};
export type ExportFile = { name: string; bytes: number; chunks: string[] };
const CHUNK_BYTES = 16 * 1024 * 1024;
async function entriesOf(folder: FileSystemDirectoryHandle) {
  const entries: FileSystemHandle[] = [];
  for await (const entry of folder.values()) entries.push(entry);
  return entries;
}
export async function describeExportFile(
  folder: FileSystemDirectoryHandle,
  name: string,
): Promise<ExportFile> {
  return retrying(async () => {
    const file = await (await folder.getFileHandle(name)).getFile();
    const chunks: string[] = [];
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES)
      chunks.push(
        await sha256(
          await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer(),
        ),
      );
    return { name, bytes: file.size, chunks };
  }, `Prüfen der Exportdatei ${name}`);
}
export async function verifyExportFiles(
  folder: FileSystemDirectoryHandle,
  files: ExportFile[],
) {
  for (const item of files) {
    if (
      !/^[a-zA-Z0-9_.-]+$/.test(item.name) ||
      item.name === "." ||
      item.name === ".."
    )
      throw new Error("Ungültiger Exportpfad.");
    const actual = await describeExportFile(folder, item.name);
    if (
      actual.bytes !== item.bytes ||
      JSON.stringify(actual.chunks) !== JSON.stringify(item.chunks)
    )
      throw new Error(
        `Exportdatei verändert oder unvollständig: ${item.name}.`,
      );
  }
}

function recordingLock(
  recording: Pick<RecordingMeta, "recordingId" | "participantId">,
) {
  return `localtake-original-${recording.recordingId}-${recording.participantId}`;
}
export async function holdOriginals(
  recording: RecordingMeta,
): Promise<() => void> {
  if (typeof navigator === "undefined" || !navigator.locks) return () => {};
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(
        recordingLock(recording),
        { mode: "shared" },
        () => new Promise<void>((release) => resolve(release)),
      )
      .catch(reject);
  });
}
async function whenUnused(
  recording: RecordingMeta,
  action: () => Promise<void>,
) {
  if (typeof navigator === "undefined" || !navigator.locks) {
    await action();
    return true;
  }
  return navigator.locks.request(
    recordingLock(recording),
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return false;
      await action();
      return true;
    },
  );
}

export const MAX_SEGMENT_BYTES = 256 * 1024 * 1024;
const encoder = new TextEncoder();
// Chromium maps generic OS file errors to these names. On Windows they mostly
// mean another process (virus scanner, indexer, cloud sync) briefly holds the
// file, e.g. while the browser moves its .crswap file into place on close().
const TRANSIENT_ERRORS = [
  "InvalidStateError",
  "NotReadableError",
  "NoModificationAllowedError",
];
export const retryPolicy = { delays: [50, 150, 400, 1000, 2000] };
export const transientFileError = (error: unknown) =>
  TRANSIENT_ERRORS.includes((error as DOMException)?.name);
// Every retried operation is idempotent: originals are content-addressed and
// verified, so a repeated write either completes or detects a conflict.
export async function retrying<T>(
  operation: () => Promise<T>,
  label: string,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!transientFileError(error)) throw error;
      if (attempt >= retryPolicy.delays.length)
        throw new Error(
          `${label}: Datei blieb nach ${attempt + 1} Versuchen gesperrt (${(error as DOMException).name}). Häufig greifen Virenscanner, Indexdienst oder Cloud-Sync gleichzeitig auf den Aufnahmeordner zu.`,
          { cause: error },
        );
      await new Promise((resolve) =>
        setTimeout(resolve, retryPolicy.delays[attempt]),
      );
    }
  }
}
// File objects are snapshots. Native folders can briefly expose stale snapshots
// after close (notably on external disks). Retry reads with a fresh handle/File;
// never treat a failed read as permission to replace an existing original.
export function readStableFile(dir: FileSystemDirectoryHandle, name: string) {
  return retrying(async () => {
    const file = await (await dir.getFileHandle(name)).getFile();
    if (file.size > MAX_SEGMENT_BYTES)
      throw new Error("Datei überschreitet das Segmentbudget.");
    const bytes = await file.arrayBuffer();
    return { file, bytes };
  }, `Lesen von ${name}`);
}
export async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export async function directory(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create = false,
) {
  let current = root;
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..")
      throw new Error("Ungültiger Dateipfad.");
    const parent = current;
    current = await retrying(
      () => parent.getDirectoryHandle(part, { create }),
      `Ordner ${part}`,
    );
  }
  return current;
}
async function readJson(
  dir: FileSystemDirectoryHandle,
  name: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<unknown> {
  const { file, bytes } = await readStableFile(dir, name);
  if (file.size > maxBytes) throw new Error("Metadaten zu groß.");
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function existingFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<File | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (error) {
    if ((error as DOMException).name === "NotFoundError") return null;
    throw error;
  }
}
export async function writeImmutable(
  dir: FileSystemDirectoryHandle,
  name: string,
  bytes: ArrayBuffer,
): Promise<string> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..")
    throw new Error("Ungültiger Dateiname.");
  if (!bytes.byteLength)
    throw new Error("Leere Dateien sind kein gültiger Aufnahmebestand.");
  const write = () => writeLocked(dir, name, bytes);
  // UUID directory names make this lock common to tabs and workers for the same original.
  // A coincidentally equal name in another root merely serializes two unrelated writes.
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (typeof isSecureContext !== "undefined" && !locks)
    throw new Error("Sicherer Dateizugriff benötigt die Web Locks API.");
  return locks
    ? locks.request(`localtake-file-${dir.name}-${name}`, write)
    : write();
}
async function writeLocked(
  dir: FileSystemDirectoryHandle,
  name: string,
  bytes: ArrayBuffer,
): Promise<string> {
  const hash = await sha256(bytes);
  return retrying(async () => {
    const existing = await existingFile(dir, name);
    // getFileHandle(create:true) may leave an empty placeholder after a crash or a
    // failed close. No valid LocalTake file is empty. Non-empty originals remain immutable.
    if (existing && existing.size > 0) {
      if (
        existing.size === bytes.byteLength &&
        (await sha256((await readStableFile(dir, name)).bytes)) === hash
      )
        return hash;
      throw new Error(
        `Dateikonflikt: ${name}. Vorhandene Daten bleiben erhalten.`,
      );
    }
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    const { file: saved, bytes: savedBytes } = await readStableFile(dir, name);
    if (saved.size !== bytes.byteLength || (await sha256(savedBytes)) !== hash)
      throw new Error(`Speicherprüfung fehlgeschlagen: ${name}`);
    return hash;
  }, `Speichern von ${name}`);
}
export async function writeJson(
  dir: FileSystemDirectoryHandle,
  name: string,
  value: unknown,
) {
  return writeImmutable(
    dir,
    name,
    encoder.encode(JSON.stringify(value, null, 2)).buffer,
  );
}
// Only regenerable metadata/preferences use replacement. Media and receipts
// always go through writeImmutable, including during transfer resumption.
export async function replaceJson(
  dir: FileSystemDirectoryHandle,
  name: string,
  value: unknown,
) {
  if (!/^[a-zA-Z0-9_.-]+\.json$/.test(name))
    throw new Error("Ungültiger Metadatenpfad.");
  await retrying(async () => {
    const writable = await (
      await dir.getFileHandle(name, { create: true })
    ).createWritable();
    try {
      await writable.write(encoder.encode(JSON.stringify(value, null, 2)));
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
  }, `Speichern von ${name}`);
}
export async function inventoryFingerprint(inventory: Inventory) {
  return sha256(
    encoder.encode(
      JSON.stringify({
        recording: inventory.recording,
        tracks: inventory.tracks
          .slice()
          .sort((a, b) => a.epochId.localeCompare(b.epochId)),
        segments: inventory.segments
          .slice()
          .sort((a, b) =>
            `${a.trackId}/${a.epochId}/${a.sequence}`.localeCompare(
              `${b.trackId}/${b.epochId}/${b.sequence}`,
            ),
          ),
        complete: inventory.complete,
        issues: inventory.issues,
        warnings: inventory.warnings ?? [],
      }),
    ).buffer,
  );
}
export class LocalStore {
  readonly scanIssues: string[] = [];
  // Device checks that a crash left behind; hidden from the archive.
  readonly leftoverChecks: { recordingId: string; createdAt: string }[] = [];
  private addScanIssue(message: string) {
    if (!this.scanIssues.includes(message)) this.scanIssues.push(message);
  }
  constructor(
    readonly root: FileSystemDirectoryHandle,
    readonly area: "local" | "temp" = "local",
  ) {}
  async preflight(): Promise<void> {
    if (
      this.root.queryPermission &&
      (await this.root.queryPermission({ mode: "readwrite" })) !== "granted"
    )
      throw new Error(
        `Speicherordner „${this.root.name}“ ist nicht freigegeben. Bitte „Ordner freigeben“ bestätigen.`,
      );
    const base = await directory(this.root, ["temp"], true);
    // Chrome and Edge on Windows are limited to 260 characters per path. Write
    // at the full depth and name length of a real segment receipt; the probe
    // folder has a UUID's length but not its form, so archive scans skip it.
    // temp is one character shorter than local; the extra probe character also
    // checks the real local path budget (including long transfer receipts).
    const probe = `probe-${crypto.randomUUID().replace(/-/g, "").slice(0, 31)}`;
    try {
      const dir = await directory(
        base,
        [
          probe,
          crypto.randomUUID(),
          "tracks",
          crypto.randomUUID(),
          crypto.randomUUID(),
        ],
        true,
      );
      await writeJson(dir, "000000_000000000000us.segment.json", {
        check: "localtake-write-read",
        at: Date.now(),
      });
      await writeJson(
        await directory(
          base,
          [probe, crypto.randomUUID(), "metadata", "transfers"],
          true,
        ),
        `${crypto.randomUUID()}-${"0".repeat(64)}.json`,
        { check: "localtake-transfer-receipt" },
      );
    } catch (error) {
      throw new Error(
        `Im Aufnahmeordner „${this.root.name}“ ließ sich keine Testdatei in der Ordnertiefe einer Aufnahme anlegen (${error instanceof Error ? error.message : String(error)}). Meist ist der Pfad zu lang: Chrome und Edge erlauben unter Windows höchstens 260 Zeichen, LocalTake braucht unterhalb des Ordners rund 210. Bitte einen Ordner nahe am Laufwerk wählen, z. B. „C:\\LocalTake“.`,
        { cause: error },
      );
    } finally {
      await retrying(
        () => base.removeEntry(probe, { recursive: true }),
        `Aufräumen von ${probe}`,
      ).catch((error) => {
        if ((error as DOMException).name !== "NotFoundError") throw error;
      });
    }
  }
  // Device checks are recorded like real takes (same path length) and removed
  // afterwards. Only folders whose every participant is marked as a check go.
  async removeCheck(recordingId: string, verify = true) {
    idSchema.parse(recordingId);
    const base = await directory(this.root, [this.area]);
    if (verify) {
      const take = await directory(base, [recordingId]);
      for await (const entry of take.values()) {
        if (entry.kind !== "directory")
          throw new Error("Keine reine Prüfaufnahme.");
        const meta = recordingMetaSchema.parse(
          await readJson(entry as FileSystemDirectoryHandle, "recording.json"),
        );
        if (meta.purpose !== "check")
          throw new Error("Keine reine Prüfaufnahme.");
      }
    }
    await retrying(
      () => base.removeEntry(recordingId, { recursive: true }),
      `Aufräumen der Prüfaufnahme ${recordingId}`,
    );
  }
  async participant(
    recordingId: string,
    participantId: string,
    create = false,
  ) {
    idSchema.parse(recordingId);
    idSchema.parse(participantId);
    return directory(
      this.root,
      [this.area, recordingId, participantId],
      create,
    );
  }
  async initialize(meta: RecordingMeta) {
    recordingMetaSchema.parse(meta);
    await writeJson(
      await this.participant(meta.recordingId, meta.participantId, true),
      "recording.json",
      meta,
    );
  }
  async initializeTrack(recording: RecordingMeta, track: TrackMeta) {
    trackMetaSchema.parse(track);
    const base = await this.participant(
      recording.recordingId,
      recording.participantId,
    );
    const dir = await directory(base, ["tracks", track.trackId], true);
    await writeJson(dir, "track.json", {
      formatVersion: 1,
      trackId: track.trackId,
      label: track.label,
      kind: track.kind,
    });
    await writeJson(
      await directory(dir, [track.epochId], true),
      "epoch.json",
      track,
    );
    await this.clock(recording, track.clock);
  }
  async clock(recording: RecordingMeta, mapping: ClockMapping) {
    const base = await this.participant(
      recording.recordingId,
      recording.participantId,
    );
    await writeJson(
      await directory(base, ["clocks"], true),
      `${mapping.id}.json`,
      mapping,
    );
  }
  async event(
    recording: RecordingMeta,
    event: { type: string; localMs: number; [key: string]: unknown },
  ) {
    const base = await this.participant(
      recording.recordingId,
      recording.participantId,
    );
    await writeJson(
      await directory(base, ["events"], true),
      `${crypto.randomUUID()}.json`,
      event,
    );
  }
  async commit(
    recording: RecordingMeta,
    track: TrackMeta,
    info: Omit<
      Segment,
      | "formatVersion"
      | "recordingId"
      | "participantId"
      | "trackId"
      | "epochId"
      | "sha256"
      | "byteLength"
      | "clockMappingId"
    >,
    bytes: ArrayBuffer,
  ): Promise<Segment> {
    if (!bytes.byteLength || bytes.byteLength > MAX_SEGMENT_BYTES)
      throw new Error("Segment überschreitet das Speicherbudget.");
    const base = await this.participant(
      recording.recordingId,
      recording.participantId,
    );
    const dir = await directory(base, ["tracks", track.trackId, track.epochId]);
    const hash = await sha256(bytes);
    const receipt = segmentSchema.parse({
      ...info,
      formatVersion: 1,
      recordingId: recording.recordingId,
      participantId: recording.participantId,
      trackId: track.trackId,
      epochId: track.epochId,
      sha256: hash,
      byteLength: bytes.byteLength,
      clockMappingId: track.clock.id,
    });
    await writeImmutable(dir, receipt.fileName, bytes);
    await writeJson(
      dir,
      receipt.fileName.replace(/\.(mp4|wav)$/, ".segment.json"),
      receipt,
    );
    return receipt;
  }
  async finish(recording: RecordingMeta, completion: Completion) {
    completionSchema.parse(completion);
    await writeJson(
      await this.participant(recording.recordingId, recording.participantId),
      "completion.json",
      completion,
    );
  }
  async segmentFile(segment: Segment): Promise<File> {
    segmentSchema.parse(segment);
    const dir = await directory(
      await this.participant(segment.recordingId, segment.participantId),
      ["tracks", segment.trackId, segment.epochId],
    );
    return retrying(
      async () => (await dir.getFileHandle(segment.fileName)).getFile(),
      `Lesen von ${segment.fileName}`,
    );
  }
  async segmentBytes(segment: Segment) {
    return this.fileBytes(
      {
        recordingId: segment.recordingId,
        participantId: segment.participantId,
      } as RecordingMeta,
      `tracks/${segment.trackId}/${segment.epochId}/${segment.fileName}`,
    );
  }
  async fileBytes(recording: RecordingMeta, path: string) {
    const parts = path.split("/");
    const name = parts.pop()!;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..")
      throw new Error("Ungültiger Dateiname.");
    const dir = await directory(
      await this.participant(recording.recordingId, recording.participantId),
      parts,
    );
    return (await readStableFile(dir, name)).bytes;
  }
  async transferReceipt(
    inventory: Inventory,
    destinationId: string,
    fingerprint: string,
    write = false,
  ) {
    idSchema.parse(destinationId);
    if (!/^[a-f0-9]{64}$/.test(fingerprint))
      throw new Error("Ungültiger Übertragungsbeleg.");
    if (!write) {
      const catalog = await this.catalogFor(inventory.recording, false);
      if (
        catalog?.type === "transfer" &&
        catalog.destinationId === destinationId &&
        catalog.fingerprint === fingerprint
      )
        return true;
    }
    const base = await this.participant(
      inventory.recording.recordingId,
      inventory.recording.participantId,
    );
    const name = `${destinationId}-${fingerprint}.json`;
    try {
      const dir = await directory(base, ["metadata", "transfers"], write);
      if (write) {
        await writeJson(dir, name, {
          destinationId,
          fingerprint,
          at: new Date().toISOString(),
        });
        return true;
      }
      const receipt = (await readJson(dir, name)) as {
        destinationId?: string;
        fingerprint?: string;
      };
      return (
        receipt.destinationId === destinationId &&
        receipt.fingerprint === fingerprint
      );
    } catch (error) {
      if (!write && (error as DOMException).name === "NotFoundError")
        return false;
      throw error;
    }
  }
  async file(recording: RecordingMeta, path: string): Promise<File> {
    const parts = path.split("/");
    const name = parts.pop()!;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..")
      throw new Error("Ungültiger Dateiname.");
    const dir = await directory(
      await this.participant(recording.recordingId, recording.participantId),
      parts,
    );
    return retrying(
      async () => (await dir.getFileHandle(name)).getFile(),
      `Lesen von ${name}`,
    );
  }
  async receive(
    recording: RecordingMeta,
    path: string,
    bytes: ArrayBuffer,
    hash: string,
  ) {
    if ((await sha256(bytes)) !== hash)
      throw new Error("Empfangene Datei hat eine falsche Prüfsumme.");
    const parts = path.split("/");
    const name = parts.pop()!;
    const dir = await directory(
      await this.participant(
        recording.recordingId,
        recording.participantId,
        true,
      ),
      parts,
      true,
    );
    await writeImmutable(dir, name, bytes);
  }
  async auxiliary(
    recording: RecordingMeta,
  ): Promise<{ path: string; file: File }[]> {
    const result: { path: string; file: File }[] = [];
    const base = await this.participant(
      recording.recordingId,
      recording.participantId,
    );
    for (const name of ["clocks", "events"]) {
      let dir: FileSystemDirectoryHandle;
      try {
        dir = await directory(base, [name]);
      } catch (error) {
        if ((error as DOMException).name === "NotFoundError") continue;
        throw error;
      }
      for await (const item of dir.values())
        if (item.kind === "file" && /^[a-f0-9-]{36}\.json$/.test(item.name))
          result.push({
            path: `${name}/${item.name}`,
            file: await retrying(
              async () => (await dir.getFileHandle(item.name)).getFile(),
              `Zusatzmetadaten ${item.name}`,
            ),
          });
    }
    return result;
  }
  // The session manifest is regenerable bookkeeping next to the participant
  // folders; it never replaces the per-participant originals and receipts.
  async writeSession(manifest: SessionManifest) {
    sessionManifestSchema.parse(manifest);
    const archived = (await this.catalogs(false)).find(
      (c) =>
        c.type === "archive" &&
        c.inventory.recording.recordingId === manifest.recordingId,
    );
    await replaceJson(
      await directory(
        this.root,
        archived
          ? [...archived.path, "metadata"]
          : [this.area, manifest.recordingId],
        true,
      ),
      archived ? "participants.json" : "session.json",
      manifest,
    );
  }
  async sessions(): Promise<SessionManifest[]> {
    const result: SessionManifest[] = [];
    for (const catalog of await this.catalogs(false)) {
      if (
        catalog.type !== "archive" ||
        result.some(
          (m) => m.recordingId === catalog.inventory.recording.recordingId,
        )
      )
        continue;
      try {
        result.push(
          sessionManifestSchema.parse(
            await readJson(
              await directory(this.root, [...catalog.path, "metadata"]),
              "participants.json",
            ),
          ),
        );
      } catch (error) {
        if ((error as DOMException).name !== "NotFoundError") throw error;
      }
    }
    let root: FileSystemDirectoryHandle;
    try {
      root = await directory(this.root, [this.area]);
    } catch (error) {
      if ((error as DOMException).name === "NotFoundError") return result;
      throw error;
    }
    for await (const entry of root.values()) {
      if (entry.kind !== "directory" || !idSchema.safeParse(entry.name).success)
        continue;
      try {
        const manifest = sessionManifestSchema.parse(
          await readJson(entry as FileSystemDirectoryHandle, "session.json"),
        );
        if (
          manifest.recordingId === entry.name &&
          !result.some((m) => m.recordingId === entry.name)
        )
          result.push(manifest);
      } catch {
        /* Only takes received as host have a manifest. */
      }
    }
    return result;
  }
  async list(verifyArchives = true): Promise<StoredInventory[]> {
    this.scanIssues.length = 0;
    this.leftoverChecks.length = 0;
    const result: StoredInventory[] = [];
    for (const catalog of await this.catalogs(verifyArchives)) {
      result.push({
        ...catalog.inventory,
        ...(catalog.type === "archive"
          ? { archive: catalog }
          : { transferredTo: catalog.destinationId }),
      });
    }
    let root: FileSystemDirectoryHandle;
    try {
      root = await directory(this.root, [this.area]);
    } catch (error) {
      if ((error as DOMException).name === "NotFoundError") return result;
      throw error;
    }
    for await (const entry of root.values()) {
      if (entry.kind !== "directory" || !idSchema.safeParse(entry.name).success)
        continue;
      for await (const participant of (
        entry as FileSystemDirectoryHandle
      ).values()) {
        if (
          participant.kind !== "directory" ||
          !idSchema.safeParse(participant.name).success
        )
          continue;
        try {
          const meta = recordingMetaSchema.safeParse(
            await readJson(
              participant as FileSystemDirectoryHandle,
              "recording.json",
            ).catch(() => null),
          );
          if (meta.success && meta.data.purpose === "check") {
            if (!this.leftoverChecks.some((c) => c.recordingId === entry.name))
              this.leftoverChecks.push({
                recordingId: entry.name,
                createdAt: meta.data.createdAt,
              });
            continue;
          }
          const inventory = await this.scan(entry.name, participant.name);
          const old = result.findIndex(
            (i) =>
              i.recording.recordingId === entry.name &&
              i.recording.participantId === participant.name,
          );
          if (old < 0) result.push(inventory);
          else if (
            (await inventoryFingerprint(result[old])) !==
            (await inventoryFingerprint(inventory))
          )
            result[old] = inventory;
        } catch (error) {
          this.addScanIssue(
            `${entry.name}/${participant.name}: ${String(error)}. Dateien bleiben unverändert erhalten.`,
          );
        }
      }
    }
    return result.sort((a, b) =>
      b.recording.createdAt.localeCompare(a.recording.createdAt),
    );
  }
  async scan(recordingId: string, participantId: string): Promise<Inventory> {
    const base = await this.participant(recordingId, participantId);
    const recording = recordingMetaSchema.parse(
      await readJson(base, "recording.json"),
    );
    if (
      recording.recordingId !== recordingId ||
      recording.participantId !== participantId
    )
      throw new Error("Aufnahmemetadaten passen nicht zum Ordner.");
    const result: Inventory = {
      recording,
      tracks: [],
      segments: [],
      complete: false,
      issues: [],
    };
    for (const trackId of recording.trackIds) {
      try {
        const trackDir = await directory(base, ["tracks", trackId]);
        for await (const epoch of trackDir.values()) {
          if (
            epoch.kind !== "directory" ||
            !idSchema.safeParse(epoch.name).success
          )
            continue;
          const epochDir = epoch as FileSystemDirectoryHandle;
          const track = trackMetaSchema.parse(
            await readJson(epochDir, "epoch.json"),
          );
          if (track.trackId !== trackId || track.epochId !== epoch.name)
            throw new Error("Spuridentität stimmt nicht.");
          result.tracks.push(track);
          const names = new Set<string>();
          const receipts: Segment[] = [];
          for await (const entry of epochDir.values()) {
            if (entry.kind !== "file") continue;
            names.add(entry.name);
            if (!entry.name.endsWith(".segment.json")) continue;
            try {
              const segment = segmentSchema.parse(
                await readJson(epochDir, entry.name),
              );
              if (
                segment.recordingId !== recordingId ||
                segment.participantId !== participantId ||
                segment.trackId !== trackId ||
                segment.epochId !== track.epochId ||
                entry.name !==
                  segment.fileName.replace(/\.(mp4|wav)$/, ".segment.json")
              )
                throw new Error("Segmentidentität stimmt nicht.");
              const media = await this.segmentBytes(segment);
              if (
                media.byteLength !== segment.byteLength ||
                (await sha256(media)) !== segment.sha256
              )
                throw new Error("Prüfsumme oder Dateigröße stimmt nicht.");
              receipts.push(segment);
            } catch (error) {
              result.issues.push(
                `${track.label}/${entry.name}: ${String(error)}`,
              );
            }
          }
          receipts.sort((a, b) => a.sequence - b.sequence);
          let next = 0,
            lastEnd: number | null = null;
          for (const segment of receipts) {
            if (segment.sequence !== next)
              result.issues.push(
                `${track.label}: Segmentlücke vor ${segment.sequence}.`,
              );
            if (
              lastEnd !== null &&
              Math.abs(segment.mediaStartUs - lastEnd) >
                (track.kind === "audio" ? 100 : 100_000)
            )
              (result.warnings ??= []).push(
                `${track.label}: Zeitlücke/Überlappung vor ${segment.sequence}.`,
              );
            next = segment.sequence + 1;
            lastEnd = segment.mediaStartUs + segment.mediaDurationUs;
          }
          for (const name of names)
            if (
              /\.(mp4|wav)$/.test(name) &&
              !receipts.some((s) => s.fileName === name)
            )
              result.issues.push(
                `${track.label}/${name}: Datei ohne gültigen Speicherbeleg, unverändert erhalten.`,
              );
          result.segments.push(...receipts);
          if (!receipts.length)
            result.issues.push(`${track.label}: keine bestätigten Segmente.`);
        }
        if (!result.tracks.some((t) => t.trackId === trackId))
          result.issues.push(`Spur ${trackId}: Metadaten fehlen.`);
      } catch (error) {
        result.issues.push(`Spur ${trackId}: ${String(error)}`);
      }
    }
    try {
      const completion = completionSchema.parse(
        await readJson(base, "completion.json"),
      );
      if (
        completion.recordingId !== recordingId ||
        completion.participantId !== participantId
      )
        throw new Error("Abschluss passt nicht zur Aufnahme.");
      result.issues.push(...(completion.issues ?? []));
      for (const trackId of recording.trackIds) {
        const source = completion.sources.find((s) => s.trackId === trackId);
        const segments = result.segments.filter((s) => s.trackId === trackId);
        if (source?.warning)
          (result.warnings ??= []).push(`${source.label}: ${source.warning}`);
        if (source?.error)
          result.issues.push(`${source.label}: ${source.error}`);
        if (
          !source ||
          source.state !== "saved" ||
          source.segments !== segments.length ||
          source.bytes !== segments.reduce((n, s) => n + s.byteLength, 0)
        )
          result.issues.push(`Spur ${trackId}: kein vollständiger Abschluss.`);
      }
      result.complete = result.issues.length === 0;
    } catch {
      result.issues.push(
        "Kein gültiger Aufnahmeabschluss: gesicherter Teilbestand.",
      );
    }
    return result;
  }

  // Versioned catalogs live with the cutter's files, so removing staging data
  // does not erase the library or invite another upload after a reconnect.
  async catalogs(verify = true): Promise<Catalog[]> {
    if (this.area === "temp") return [];
    const result: Catalog[] = [];
    for await (const room of this.root.values()) {
      if (
        room.kind !== "directory" ||
        ["local", "temp", "localtake"].includes(room.name)
      )
        continue;
      for await (const take of (room as FileSystemDirectoryHandle).values()) {
        if (
          take.kind !== "directory" ||
          !/^Aufnahme-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-f0-9-]{12}$/.test(
            take.name,
          )
        )
          continue;
        let metadata: FileSystemDirectoryHandle;
        try {
          metadata = await directory(take as FileSystemDirectoryHandle, [
            "metadata",
          ]);
        } catch (error) {
          if ((error as DOMException).name === "NotFoundError") continue;
          throw error;
        }
        for await (const entry of metadata.values()) {
          if (
            entry.kind !== "file" ||
            !/^[a-f0-9-]{36}\.(archive|transfer)\.json$/.test(entry.name)
          )
            continue;
          try {
            const catalog = (await readJson(
              metadata,
              entry.name,
              MAX_SEGMENT_BYTES,
            )) as Catalog;
            catalog.inventory = inventorySchema.parse(catalog.inventory);
            const recording = catalog.inventory.recording;
            const actualPath = [room.name, take.name];
            let samePath =
              JSON.stringify(catalog.path) === JSON.stringify(actualPath);
            if (
              !samePath &&
              Array.isArray(catalog.path) &&
              catalog.path.length === 2 &&
              catalog.path.every(
                (part) =>
                  typeof part === "string" &&
                  part !== "." &&
                  part !== ".." &&
                  !/[\\/]/.test(part),
              )
            ) {
              // Native Windows/macOS folders may preserve an earlier spelling.
              // Check filesystem identity, not lowercase strings: two different
              // folders on a case-sensitive filesystem must never share a receipt.
              const claimedRoom = await this.root.getDirectoryHandle(
                catalog.path[0],
              );
              const claimedTake = await claimedRoom.getDirectoryHandle(
                catalog.path[1],
              );
              samePath =
                (await (room as FileSystemDirectoryHandle).isSameEntry(
                  claimedRoom,
                )) &&
                (await (take as FileSystemDirectoryHandle).isSameEntry(
                  claimedTake,
                ));
            }
            if (
              catalog.formatVersion !== 1 ||
              !["archive", "transfer"].includes(catalog.type) ||
              entry.name !==
                `${recording.participantId}.${catalog.type}.json` ||
              !samePath ||
              catalog.fingerprint !==
                (await inventoryFingerprint(catalog.inventory)) ||
              !Array.isArray(catalog.files) ||
              !Array.isArray(catalog.originals) ||
              (catalog.type === "transfer" &&
                !idSchema.safeParse(catalog.destinationId).success)
            )
              throw new Error("Ungültiger Ablagebeleg.");
            catalog.path = [room.name, take.name];
            for (const file of catalog.files)
              if (
                !Number.isSafeInteger(file.bytes) ||
                file.bytes <= 0 ||
                !Array.isArray(file.chunks) ||
                file.chunks.length !== Math.ceil(file.bytes / CHUNK_BYTES) ||
                file.chunks.some((h) => !/^[a-f0-9]{64}$/.test(h))
              )
                throw new Error("Ungültiger Dateibeleg.");
            if (verify && catalog.type === "archive")
              await verifyExportFiles(
                take as FileSystemDirectoryHandle,
                catalog.files,
              );
            if (verify)
              for (const item of catalog.metadataFiles ?? []) {
                const actual = await readStableFile(metadata, item.file);
                if (
                  actual.bytes.byteLength !== item.bytes ||
                  (await sha256(actual.bytes)) !== item.hash
                )
                  throw new Error(`Metadaten verändert: ${item.file}.`);
              }
            result.push(catalog);
          } catch (error) {
            this.addScanIssue(
              `${room.name}/${take.name}/metadata/${entry.name}: ${String(error)}`,
            );
          }
        }
      }
    }
    return result;
  }
  async catalogFor(recording: RecordingMeta, verify = true) {
    return (await this.catalogs(verify)).find(
      (c) =>
        c.inventory.recording.recordingId === recording.recordingId &&
        c.inventory.recording.participantId === recording.participantId,
    );
  }
  async originalFiles(recording: RecordingMeta) {
    const result: Catalog["originals"] = [];
    const visit = async (folder: FileSystemDirectoryHandle, prefix = "") => {
      for await (const entry of folder.values()) {
        const path = prefix + entry.name;
        if (entry.kind === "directory") {
          if (prefix === "" && entry.name === "metadata") continue;
          await visit(entry as FileSystemDirectoryHandle, path + "/");
        } else {
          const bytes = (await readStableFile(folder, entry.name)).bytes;
          if (bytes.byteLength)
            result.push({
              path,
              bytes: bytes.byteLength,
              hash: await sha256(bytes),
            });
        }
      }
    };
    await visit(
      await this.participant(recording.recordingId, recording.participantId),
    );
    return result;
  }
  async saveCatalog(catalog: Catalog) {
    catalog = {
      ...catalog,
      inventory: inventorySchema.parse(catalog.inventory),
    };
    if ((await inventoryFingerprint(catalog.inventory)) !== catalog.fingerprint)
      throw new Error("Bestand hat sich vor der Ablage geändert.");
    const metadata = await directory(
      this.root,
      [...catalog.path, "metadata"],
      true,
    );
    const name = `${catalog.inventory.recording.participantId}.${catalog.type}.json`;
    await replaceJson(metadata, name, catalog);
    const saved = (await readJson(
      metadata,
      name,
      MAX_SEGMENT_BYTES,
    )) as Catalog;
    if (saved.fingerprint !== catalog.fingerprint)
      throw new Error("Ablagebeleg konnte nicht bestätigt werden.");
  }
  async copyMetadata(
    recording: RecordingMeta,
    target: FileSystemDirectoryHandle,
    originals: Catalog["originals"],
  ) {
    const result: NonNullable<Catalog["metadataFiles"]> = [];
    for (const entry of originals) {
      if (!entry.path.endsWith(".json")) continue;
      const name = `${recording.participantId}-${(await sha256(encoder.encode(entry.path).buffer)).slice(0, 12)}-${entry.path.split("/").at(-1)!.slice(0, -5).slice(0, 40)}.json`;
      const bytes = await this.fileBytes(recording, entry.path);
      if (
        bytes.byteLength !== entry.bytes ||
        (await sha256(bytes)) !== entry.hash
      )
        throw new Error(
          "Originalmetadaten haben sich vor der Ablage geändert.",
        );
      await writeImmutable(target, name, bytes);
      result.push({ ...entry, file: name });
    }
    return result;
  }
  async removeOriginals(inventory: Inventory) {
    await whenUnused(inventory.recording, async () => {
      const current = await this.scan(
        inventory.recording.recordingId,
        inventory.recording.participantId,
      );
      if (
        (await inventoryFingerprint(current)) !==
        (await inventoryFingerprint(inventory))
      )
        throw new Error(
          "Lokale Originale haben sich verändert und bleiben erhalten.",
        );
      await this.removeParticipant(inventory.recording);
    });
  }
  private async removeParticipant(recording: RecordingMeta) {
    const base = await directory(this.root, [this.area, recording.recordingId]);
    await retrying(
      () => base.removeEntry(recording.participantId, { recursive: true }),
      "Lokale Originale aufräumen",
    );
    const remaining = await entriesOf(base);
    if (remaining.every((e) => e.kind === "file" && e.name === "session.json"))
      await (
        await directory(this.root, [this.area])
      ).removeEntry(recording.recordingId, { recursive: true });
  }
  async retireTransferred(
    inventory: Inventory,
    destinationId: string,
    fingerprint: string,
  ) {
    if (!inventory.complete) return; // Partial recovery data expires only under the explicit seven-day rule.
    idSchema.parse(destinationId);
    if (!(await this.transferReceipt(inventory, destinationId, fingerprint)))
      throw new Error("Empfangsbestätigung fehlt.");
    await this.saveCatalog({
      formatVersion: 1,
      type: "transfer",
      path: takePath(inventory.recording),
      inventory,
      destinationId,
      fingerprint,
      files: [],
      originals: [],
    });
    await this.removeOriginals(inventory);
  }

  async housekeeping(now = Date.now()) {
    if (this.area !== "local") return false;
    let changed = await this.migrateLegacy();
    for (const area of ["temp", "local"] as const) {
      let base: FileSystemDirectoryHandle;
      try {
        base = await directory(this.root, [area]);
      } catch (error) {
        if ((error as DOMException).name === "NotFoundError") continue;
        throw error;
      }
      const scoped = new LocalStore(this.root, area);
      for (const take of await entriesOf(base)) {
        if (take.kind !== "directory" || !idSchema.safeParse(take.name).success)
          continue;
        for (const participant of await entriesOf(
          take as FileSystemDirectoryHandle,
        )) {
          if (
            participant.kind !== "directory" ||
            !idSchema.safeParse(participant.name).success
          )
            continue;
          let recording: RecordingMeta;
          try {
            recording = recordingMetaSchema.parse(
              await readJson(
                participant as FileSystemDirectoryHandle,
                "recording.json",
              ),
            );
          } catch {
            continue;
          } // Unknown user data is never a cleanup target.
          if (
            recording.recordingId !== take.name ||
            recording.participantId !== participant.name
          )
            continue;
          if (
            area === "temp"
              ? recording.purpose !== "check"
              : now - Date.parse(recording.createdAt) < LOCAL_RETENTION_MS
          )
            continue;
          if (
            await whenUnused(recording, () =>
              scoped.removeParticipant(recording),
            )
          )
            changed = true;
        }
      }
    }
    return changed;
  }
  private async migrateLegacy() {
    let legacy: FileSystemDirectoryHandle;
    try {
      legacy = await directory(this.root, ["localtake"]);
    } catch (error) {
      if ((error as DOMException).name === "NotFoundError") return false;
      throw error;
    }
    // Older clients do not hold the new per-take lease; do not move files while
    // any old or current recorder is active in this browser origin.
    if (
      typeof navigator !== "undefined" &&
      navigator.locks &&
      (await navigator.locks.query()).held?.some((l) =>
        l.name?.startsWith("localtake-recorder-"),
      )
    )
      return false;
    let changed = false;
    const copy = async (
      source: FileSystemDirectoryHandle,
      target: FileSystemDirectoryHandle,
    ) => {
      for await (const entry of source.values()) {
        if (entry.kind === "directory")
          await copy(
            entry as FileSystemDirectoryHandle,
            await directory(target, [entry.name], true),
          );
        else
          await writeImmutable(
            target,
            entry.name,
            (await readStableFile(source, entry.name)).bytes,
          );
      }
    };
    for (const take of await entriesOf(legacy)) {
      if (take.kind !== "directory" || !idSchema.safeParse(take.name).success)
        continue;
      for (const participant of await entriesOf(
        take as FileSystemDirectoryHandle,
      )) {
        if (
          participant.kind !== "directory" ||
          !idSchema.safeParse(participant.name).success
        )
          continue;
        const recording = recordingMetaSchema.safeParse(
          await readJson(
            participant as FileSystemDirectoryHandle,
            "recording.json",
          ).catch(() => null),
        );
        if (
          !recording.success ||
          recording.data.recordingId !== take.name ||
          recording.data.participantId !== participant.name
        )
          continue;
        if (
          await whenUnused(recording.data, async () => {
            if (recording.data.purpose !== "check") {
              const destination = await this.participant(
                take.name,
                participant.name,
                true,
              );
              await copy(participant as FileSystemDirectoryHandle, destination);
            }
            await (take as FileSystemDirectoryHandle).removeEntry(
              participant.name,
              { recursive: true },
            );
          })
        )
          changed = true;
      }
      const manifest = sessionManifestSchema.safeParse(
        await readJson(take as FileSystemDirectoryHandle, "session.json").catch(
          () => null,
        ),
      );
      if (manifest.success && manifest.data.recordingId === take.name) {
        await this.writeSession(manifest.data);
        await (take as FileSystemDirectoryHandle).removeEntry("session.json");
      }
      if (!(await entriesOf(take as FileSystemDirectoryHandle)).length)
        await legacy.removeEntry(take.name);
    }
    await legacy.removeEntry("checks", { recursive: true }).catch((error) => {
      if ((error as DOMException).name !== "NotFoundError") throw error;
    });
    if (!(await entriesOf(legacy)).length)
      await this.root.removeEntry("localtake");
    return changed;
  }
}
