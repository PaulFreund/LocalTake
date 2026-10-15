import {
  MP4,
  BlobSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
} from "mediabunny";
import {
  directory,
  sha256,
  inventoryFingerprint,
  replaceJson,
  readStableFile,
  retrying,
  describeExportFile,
  verifyExportFiles,
  holdOriginals,
  type StoredInventory,
  type ExportFile,
  type LocalStore,
} from "../storage/store.js";
import { safeFolderName, sessionStamp, takePath } from "../storage/layout.js";
export { safeFolderName, sessionStamp } from "../storage/layout.js";
import { wavHeader } from "../recorder/wav.js";
import type {
  Inventory,
  Segment,
  TrackMeta,
} from "../../../../packages/protocol/src/index.js";

// Export files can always be rebuilt from verified originals. Retry with a new
// writable and muxer: a stream whose close() failed cannot be reused safely.
async function writeExportFile(
  folder: FileSystemDirectoryHandle,
  name: string,
  write: (writable: FileSystemWritableFileStream) => Promise<void>,
) {
  await retrying(async () => {
    const writable = await (
      await folder.getFileHandle(name, { create: true })
    ).createWritable();
    try {
      await write(writable);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
  }, `Exportieren von ${name}`);
}

function exportFile(folder: FileSystemDirectoryHandle, name: string) {
  // Exported media can be several GiB; inspect metadata without buffering it.
  return retrying(
    async () => (await folder.getFileHandle(name)).getFile(),
    `Exportdatei ${name} lesen`,
  );
}

export async function exportRecording(
  store: LocalStore,
  inventory: Inventory,
  root: FileSystemDirectoryHandle,
  progress: (text: string) => void,
  folderName?: string,
  namespace = "",
) {
  const folder = await directory(
    root,
    folderName === undefined
      ? takePath(inventory.recording)
      : folderName
        ? [folderName]
        : [],
    true,
  );
  const metadata = await directory(folder, ["metadata"], true);
  const fingerprint = await inventoryFingerprint(inventory);
  try {
    const marker = JSON.parse(
      new TextDecoder().decode(
        (await readStableFile(metadata, `${namespace}export.json`)).bytes,
      ),
    );
    if (marker.fingerprint === fingerprint && Array.isArray(marker.files)) {
      await verifyExportFiles(folder, marker.files);
      await readStableFile(metadata, `${namespace}timeline.json`);
      return folder;
    }
  } catch (error) {
    if (
      (error as DOMException).name !== "NotFoundError" &&
      !(
        error instanceof Error &&
        error.message.startsWith("Exportdatei verändert oder unvollständig:")
      )
    )
      throw error;
  }
  const outputs: {
    file: string;
    trackId: string;
    epochId: string;
    mediaStartUs: number;
    localStartMs: number;
    durationUs: number;
  }[] = [];
  for (const track of inventory.tracks) {
    const segments = inventory.segments
      .filter((s) => s.trackId === track.trackId && s.epochId === track.epochId)
      .sort((a, b) => a.sequence - b.sequence);
    if (!segments.length) continue;
    progress(`${track.label} exportieren …`);
    const prefix = namespace
      ? `${safeFolderName(inventory.recording.participantName, 16)}-${track.kind}-${inventory.recording.participantId.replace(/-/g, "")}-${track.trackId.replace(/-/g, "")}-${track.epochId.replace(/-/g, "")}`
      : `${track.kind}-${track.trackId.slice(0, 8)}-${track.epochId.slice(0, 8)}`;
    if (track.kind === "audio") {
      const groups: Segment[][] = [];
      let group: Segment[] = [];
      for (const segment of segments) {
        const previous = group.at(-1);
        const samples = group.reduce((n, s) => n + (s.sampleCount ?? 0), 0);
        if (
          previous &&
          ((previous.sampleStart ?? 0) + (previous.sampleCount ?? 0) !==
            segment.sampleStart ||
            (samples + (segment.sampleCount ?? 0)) * track.channels! * 4 >
              0xffffffff - 48)
        ) {
          groups.push(group);
          group = [];
        }
        group.push(segment);
      }
      if (group.length) groups.push(group);
      for (let index = 0; index < groups.length; index++) {
        const parts = groups[index],
          name = `${prefix}-${String(index + 1).padStart(3, "0")}.wav`;
        await writeExportFile(folder, name, async (writable) => {
          await writable.write(
            wavHeader(
              track.sampleRate!,
              track.channels!,
              parts.reduce((n, s) => n + s.sampleCount!, 0),
            ),
          );
          for (const segment of parts) {
            const file = await verifiedSegment(store, segment),
              header = new DataView(await file.slice(0, 56).arrayBuffer());
            if (
              header.byteLength !== 56 ||
              header.getUint16(20, true) !== 3 ||
              header.getUint32(24, true) !== track.sampleRate ||
              header.getUint16(22, true) !== track.channels ||
              file.size !== 56 + segment.sampleCount! * track.channels! * 4
            )
              throw new Error("WAV-Format passt nicht zu den Spurmetadaten.");
            await file
              .slice(56)
              .stream()
              .pipeTo(writable, { preventClose: true });
          }
        });
        outputs.push(describe(name, track, parts));
      }
    } else {
      const name = `${prefix}.mp4`;
      await writeExportFile(folder, name, async (writable) => {
        const target = new StreamTarget(
          new WritableStream({
            write: (chunk) =>
              writable.write({
                type: "write",
                position: chunk.position,
                data: chunk.data,
              }),
            abort: (reason) => writable.abort(reason),
          }),
        );
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: "fragmented" }),
          target,
        });
        const source = new EncodedVideoPacketSource("avc");
        // Preserve capture timing, including jitter and gaps, during remuxing.
        output.addVideoTrack(source);
        try {
          await output.start();
          for (const segment of segments) {
            const input = new Input({
              formats: [MP4],
              source: new BlobSource(await verifiedSegment(store, segment)),
            });
            try {
              const video = await input.getPrimaryVideoTrack();
              if (!video) throw new Error("MP4 enthält keine Videospur.");
              const decoderConfig = await video.getDecoderConfig();
              if (!decoderConfig)
                throw new Error("Decoderkonfiguration fehlt.");
              const sink = new EncodedPacketSink(video);
              for await (const packet of sink.packets())
                await source.add(
                  packet.clone({
                    timestamp:
                      packet.timestamp +
                      (segment.mediaStartUs - segments[0].mediaStartUs) / 1e6,
                  }),
                  { decoderConfig },
                );
            } finally {
              input.dispose();
            }
          }
          source.close();
          await output.finalize();
        } catch (error) {
          await output.cancel().catch(() => undefined);
          throw error;
        }
      });
      outputs.push(describe(name, track, segments));
    }
  }
  const auxiliary: { path: string; data: unknown }[] = [];
  for (const entry of await store.auxiliary(inventory.recording)) {
    if (entry.file.size > 1_000_000)
      throw new Error("Zusatzmetadaten zu groß.");
    const data = await store.fileBytes(inventory.recording, entry.path);
    if (data.byteLength > 1_000_000)
      throw new Error("Zusatzmetadaten zu groß.");
    auxiliary.push({
      path: entry.path,
      data: JSON.parse(new TextDecoder().decode(data)),
    });
  }
  await replaceJson(metadata, `${namespace}timeline.json`, {
    formatVersion: 1,
    recording: inventory.recording,
    complete: inventory.complete,
    issues: inventory.issues,
    warnings: inventory.warnings ?? [],
    tracks: inventory.tracks,
    outputs,
    auxiliary,
    note: "Original-Zeitstempel, geschätzte Clock-Abbildungen. Eingangs-/Kameralatenz ist nicht automatisch kalibriert. Dateien enthalten weder automatischen Schnitt noch Driftkorrektur.",
  });
  const files: ExportFile[] = [];
  for (const output of outputs) {
    files.push(await describeExportFile(folder, output.file));
  }
  await replaceJson(metadata, `${namespace}export.json`, {
    fingerprint,
    files,
  });
  progress(
    `Export abgeschlossen: ${outputs.length} Mediendateien und metadata/timeline.json.`,
  );
  return folder;
}
async function verifiedSegment(store: LocalStore, segment: Segment) {
  const bytes = await store.segmentBytes(segment);
  if (
    bytes.byteLength !== segment.byteLength ||
    (await sha256(bytes)) !== segment.sha256
  )
    throw new Error(
      `Original wurde nach der Archivprüfung verändert: ${segment.fileName}. Export abgebrochen; Bestand erneut prüfen.`,
    );
  return new Blob([bytes]);
}
// A session is one take; its folder collects every participant's originals.
export async function exportSession(
  store: LocalStore,
  inventories: Inventory[],
  root: FileSystemDirectoryHandle,
  progress: (text: string) => void,
  retire = false,
  roomName?: string,
) {
  const operation = async () => {
    const releases: (() => void)[] = [];
    let folder: FileSystemDirectoryHandle;
    try {
      for (const inventory of inventories)
        releases.push(await holdOriginals(inventory.recording));
      folder = await exportSessionUnlocked(
        store,
        inventories,
        root,
        progress,
        roomName,
      );
    } finally {
      for (const release of releases) release();
    }
    if (retire)
      for (const inventory of inventories) {
        if (!inventory.complete) continue;
        const original = await store
          .participant(
            inventory.recording.recordingId,
            inventory.recording.participantId,
          )
          .catch((error) => {
            if ((error as DOMException).name === "NotFoundError") return null;
            throw error;
          });
        if (original) await store.removeOriginals(inventory);
      }
    return folder;
  };
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks
    ? locks.request(
        `localtake-export-${inventories[0]?.recording.recordingId}`,
        operation,
      )
    : operation();
}
async function exportSessionUnlocked(
  store: LocalStore,
  inventories: Inventory[],
  root: FileSystemDirectoryHandle,
  progress: (text: string) => void,
  roomName?: string,
) {
  if (!inventories.length)
    throw new Error("Keine Aufnahmen für den Export vorhanden.");
  const first = inventories[0].recording;
  const sessionId = first.recordingId;
  if (inventories.some((i) => i.recording.recordingId !== sessionId))
    throw new Error(
      "Aufnahmen aus verschiedenen Sitzungen getrennt exportieren.",
    );
  const manifests = await store.sessions();
  const manifest = manifests.find((m) => m.recordingId === sessionId);
  const existing = (await store.catalogs(false)).filter(
    (c) =>
      c.type === "archive" && c.inventory.recording.recordingId === sessionId,
  );
  const startedAt =
    first.sessionStartedAt ||
    manifest?.startedAt ||
    inventories.map((i) => i.recording.createdAt).sort()[0];
  const path =
    existing[0]?.path ??
    takePath({
      ...first,
      sessionName: first.sessionName || manifest?.roomName || roomName,
      sessionStartedAt: startedAt,
    });
  const folder = await directory(root, path, true);
  const entries = existing.map((c) => ({
    recording: c.inventory.recording,
    files: c.files.map((f) => f.name),
    metadataFiles: c.metadataFiles ?? [],
    complete: c.inventory.complete,
    issues: c.inventory.issues,
    warnings: c.inventory.warnings ?? [],
    bytes: c.inventory.segments.reduce((n, s) => n + s.byteLength, 0),
  }));
  const catalogs = [];
  for (const inventory of inventories) {
    const recording = inventory.recording;
    if ((inventory as StoredInventory).transferredTo)
      throw new Error(
        "Diese Originale wurden bereits an den Master übertragen. Der Cutter-Ordner liegt auf dem Master-PC.",
      );
    const fingerprint = await inventoryFingerprint(inventory);
    const previous = existing.find(
      (c) =>
        c.inventory.recording.participantId === recording.participantId &&
        c.fingerprint === fingerprint,
    );
    await exportRecording(
      store,
      inventory,
      folder,
      progress,
      "",
      `${recording.participantId}.`,
    );
    const marker = JSON.parse(
      new TextDecoder().decode(
        (
          await readStableFile(
            await directory(folder, ["metadata"]),
            `${recording.participantId}.export.json`,
          )
        ).bytes,
      ),
    );
    const catalog = {
      formatVersion: 1 as const,
      type: "archive" as const,
      inventory,
      path,
      fingerprint,
      files: marker.files as ExportFile[],
      originals: previous?.originals ?? (await store.originalFiles(recording)),
    };
    const metadataFolder = await directory(folder, ["metadata"]);
    const metadataFiles =
      previous?.metadataFiles ??
      (await store.copyMetadata(recording, metadataFolder, catalog.originals));
    if (!previous) {
      const file = `${recording.participantId}.timeline.json`;
      const data = await readStableFile(metadataFolder, file);
      metadataFiles.push({
        path: "derived/timeline.json",
        file,
        bytes: data.bytes.byteLength,
        hash: await sha256(data.bytes),
      });
    }
    const completeCatalog = { ...catalog, metadataFiles };
    await store.saveCatalog(completeCatalog);
    catalogs.push(completeCatalog);
    const before = entries.findIndex(
      (e) => e.recording.participantId === recording.participantId,
    );
    if (before >= 0) entries.splice(before, 1);
    entries.push({
      recording,
      files: catalog.files.map((f) => f.name),
      metadataFiles,
      complete: inventory.complete,
      issues: inventory.issues,
      warnings: inventory.warnings ?? [],
      bytes: inventory.segments.reduce((n, s) => n + s.byteLength, 0),
    });
  }
  await replaceJson(
    await directory(folder, ["metadata"], true),
    "session.json",
    {
      formatVersion: 3,
      sessionId,
      roomId: first.roomId,
      roomName: first.sessionName || manifest?.roomName,
      startedAt,
      updatedAt: new Date().toISOString(),
      recordings: entries,
      participants: manifest?.participants,
      pendingParticipants:
        manifest?.participants.filter(
          (p) =>
            !entries.some(
              (e) => e.recording.participantId === p.id && e.complete,
            ),
        ) ?? [],
      timing:
        "Die Dateien beginnen jeweils bei Null. metadata/*timeline.json enthält Original-Zeitstempel und Clock-Abbildungen aller Spuren; Eingangs- und Kameralatenz sind nicht automatisch kalibriert.",
    },
  );
  if (manifest)
    await replaceJson(
      await directory(folder, ["metadata"]),
      "participants.json",
      manifest,
    );
  await cleanupLegacyExports(store, sessionId, root);
  return folder;
}
// Remove only old application exports that are byte-identical to the verified
// cutter files. Unknown additions, edits, partial exports and other takes stay.
async function cleanupLegacyExports(
  store: LocalStore,
  sessionId: string,
  root: FileSystemDirectoryHandle,
) {
  const catalogs = (await store.catalogs(false)).filter(
    (c) =>
      c.type === "archive" && c.inventory.recording.recordingId === sessionId,
  );
  const entries = async (dir: FileSystemDirectoryHandle) => {
    const result: FileSystemHandle[] = [];
    for await (const entry of dir.values()) result.push(entry);
    return result;
  };
  for (const entry of await entries(root)) {
    if (
      entry.kind !== "directory" ||
      !/^LocalTake-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(?:-\d{2})?-[a-f0-9]{8}$/.test(
        entry.name,
      )
    )
      continue;
    const legacy = entry as FileSystemDirectoryHandle;
    try {
      const metadata = await directory(legacy, ["metadata"]);
      const read = async (dir: FileSystemDirectoryHandle, name: string) =>
        JSON.parse(
          new TextDecoder().decode((await readStableFile(dir, name)).bytes),
        );
      const session = await read(metadata, "session.json");
      if (
        session.formatVersion !== 2 ||
        session.sessionId !== sessionId ||
        !Array.isArray(session.recordings) ||
        !session.recordings.length
      )
        continue;
      if ((await entries(metadata)).some((e) => e.name !== "session.json"))
        continue;
      const allowed = new Set(["metadata"]);
      let matched = true;
      for (const old of session.recordings) {
        const catalog = catalogs.find(
          (c) =>
            c.inventory.recording.participantId ===
            old.recording?.participantId,
        );
        const parts =
          typeof old.folder === "string" ? old.folder.split("/") : [];
        if (!catalog || parts.length !== 2) {
          matched = false;
          break;
        }
        allowed.add(parts[0]);
        const participant = await directory(legacy, [parts[0]]);
        if ((await entries(participant)).some((e) => e.name !== parts[1])) {
          matched = false;
          break;
        }
        const take = await directory(participant, [parts[1]]),
          oldMetadata = await directory(take, ["metadata"]);
        const marker = await read(oldMetadata, "export.json"),
          timeline = await read(oldMetadata, "timeline.json");
        const target = await directory(root, catalog.path),
          newTimeline = await read(
            await directory(target, ["metadata"]),
            `${catalog.inventory.recording.participantId}.timeline.json`,
          );
        if (
          marker.fingerprint !== catalog.fingerprint ||
          !Array.isArray(marker.files) ||
          !Array.isArray(timeline.outputs) ||
          marker.files.length !== timeline.outputs.length ||
          !marker.files.every((f: { name: string }) =>
            timeline.outputs.some((o: { file: string }) => o.file === f.name),
          ) ||
          (await entries(oldMetadata)).some(
            (e) => !["timeline.json", "export.json"].includes(e.name),
          ) ||
          (await entries(take)).some(
            (e) =>
              e.name !== "metadata" &&
              !marker.files.some((f: { name: string }) => f.name === e.name),
          )
        ) {
          matched = false;
          break;
        }
        const expectedTimeline = {
          ...newTimeline,
          outputs: newTimeline.outputs.map(
            (n: {
              trackId: string;
              epochId: string;
              mediaStartUs: number;
              durationUs: number;
              file: string;
            }) => ({
              ...n,
              file: timeline.outputs.find(
                (o: typeof n) =>
                  o.trackId === n.trackId &&
                  o.epochId === n.epochId &&
                  o.mediaStartUs === n.mediaStartUs &&
                  o.durationUs === n.durationUs,
              )?.file,
            }),
          ),
        };
        if (
          JSON.stringify(timeline) !== JSON.stringify(expectedTimeline) ||
          Object.keys(session).some(
            (key) =>
              ![
                "formatVersion",
                "sessionId",
                "roomId",
                "startedAt",
                "updatedAt",
                "recordings",
              ].includes(key),
          )
        ) {
          matched = false;
          break;
        }
        for (const output of timeline.outputs) {
          const next = newTimeline.outputs.find(
            (n: typeof output) =>
              n.trackId === output.trackId &&
              n.epochId === output.epochId &&
              n.mediaStartUs === output.mediaStartUs &&
              n.durationUs === output.durationUs,
          );
          const actual = await describeExportFile(take, output.file),
            expected = catalog.files.find((f) => f.name === next?.file);
          if (
            !expected ||
            actual.bytes !== expected.bytes ||
            JSON.stringify(actual.chunks) !== JSON.stringify(expected.chunks)
          ) {
            matched = false;
            break;
          }
        }
        if (timeline.outputs.length !== catalog.files.length) matched = false;
        if (!matched) break;
      }
      if (
        matched &&
        (await entries(legacy)).every(
          (e) => e.kind === "directory" && allowed.has(e.name),
        )
      )
        await retrying(
          () => root.removeEntry(entry.name, { recursive: true }),
          "Vorherigen Sitzungsexport aufräumen",
        );
    } catch {
      /* An unreadable or modified old export is preserved. */
    }
  }
}
function describe(file: string, track: TrackMeta, segments: Segment[]) {
  const first = segments[0],
    last = segments.at(-1)!;
  return {
    file,
    trackId: track.trackId,
    epochId: track.epochId,
    mediaStartUs: first.mediaStartUs,
    localStartMs: track.localStartMs,
    durationUs: last.mediaStartUs + last.mediaDurationUs - first.mediaStartUs,
  };
}
