import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalStore,
  holdOriginals,
  writeJson,
} from "../apps/client/src/storage/store.js";
import {
  LOCAL_RETENTION_MS,
  safeFolderName,
  sessionStamp,
} from "../apps/client/src/storage/layout.js";
import { MemoryDirectory } from "./helpers/memory-files.js";
import type { RecordingMeta } from "../packages/protocol/src/index.js";

afterEach(() => vi.unstubAllGlobals());
const now = Date.parse("2026-10-09T10:00:00Z");
function meta(age = 0): RecordingMeta {
  return {
    formatVersion: 1,
    recordingId: crypto.randomUUID(),
    participantId: crypto.randomUUID(),
    participantName: "Host",
    createdAt: new Date(now - age).toISOString(),
    appVersion: "test",
    trackIds: [crypto.randomUUID()],
    purpose: "recording",
  };
}
function fixture() {
  const root = new MemoryDirectory();
  const handle = root as unknown as FileSystemDirectoryHandle;
  return { root, handle, store: new LocalStore(handle) };
}
describe("output lifecycle", () => {
  it("deletes stale local data exactly at seven days and leaves cutter folders and unknown files alone", async () => {
    const f = fixture();
    const expired = meta(LOCAL_RETENTION_MS),
      recent = meta(LOCAL_RETENTION_MS - 1);
    await f.store.initialize(expired);
    await f.store.initialize(recent);
    const local = await f.root.getDirectoryHandle("local");
    const unknown = await local.getDirectoryHandle(crypto.randomUUID(), {
      create: true,
    });
    await unknown.getFileHandle("my-file.json", { create: true });
    const cutter = await f.handle.getDirectoryHandle("Podcast", {
      create: true,
    });
    const take = await cutter.getDirectoryHandle(
      "Aufnahme-2020-01-01_10-00-00-0123456789ab",
      { create: true },
    );
    await take.getFileHandle("video.mp4", { create: true });
    await f.store.housekeeping(now);
    await expect(
      f.store.participant(expired.recordingId, expired.participantId),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    expect(
      await f.store.participant(recent.recordingId, recent.participantId),
    ).toBeTruthy();
    expect(await local.getDirectoryHandle(unknown.name)).toBeTruthy();
    expect(await take.getFileHandle("video.mp4")).toBeTruthy();
  });
  it("uses temp at the real recording depth and removes abandoned checks immediately", async () => {
    const f = fixture(),
      check = { ...meta(), purpose: "check" as const };
    const temp = new LocalStore(f.handle, "temp");
    await f.store.preflight();
    await temp.initialize(check);
    expect(await f.store.list()).toEqual([]);
    expect(
      await temp.participant(check.recordingId, check.participantId),
    ).toBeTruthy();
    await f.store.housekeeping(now);
    expect(
      await Array.fromAsync((await f.root.getDirectoryHandle("temp")).values()),
    ).toEqual([]);
  });
  it("does not remove a check or old originals while another tab records or transfers them", async () => {
    const held = new Set<string>();
    vi.stubGlobal("navigator", {
      locks: {
        query: async () => ({ held: [...held].map((name) => ({ name })) }),
        request: async (
          name: string,
          options:
            { ifAvailable?: boolean } | ((lock: unknown) => Promise<unknown>),
          callback?: (lock: unknown) => Promise<unknown>,
        ) => {
          const call = typeof options === "function" ? options : callback!;
          if (
            typeof options !== "function" &&
            options.ifAvailable &&
            held.has(name)
          )
            return call(null);
          held.add(name);
          try {
            return await call({ name });
          } finally {
            held.delete(name);
          }
        },
      },
    });
    const f = fixture(),
      old = meta(LOCAL_RETENTION_MS + 1),
      check = { ...meta(), purpose: "check" as const };
    const temp = new LocalStore(f.handle, "temp");
    await f.store.initialize(old);
    await temp.initialize(check);
    const releaseOld = await holdOriginals(old),
      releaseCheck = await holdOriginals(check);
    await f.store.housekeeping(now);
    expect(
      await f.store.participant(old.recordingId, old.participantId),
    ).toBeTruthy();
    expect(
      await temp.participant(check.recordingId, check.participantId),
    ).toBeTruthy();
    releaseOld();
    releaseCheck();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.store.housekeeping(now);
    await expect(
      f.store.participant(old.recordingId, old.participantId),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(
      temp.participant(check.recordingId, check.participantId),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("migrates verified originals from the previous layout without adding a fourth root folder", async () => {
    const f = fixture(),
      recording = meta();
    await f.store.initialize(recording);
    const original = await f.store.participant(
      recording.recordingId,
      recording.participantId,
    );
    await writeJson(original, "completion.json", { preserved: true });
    f.root.entries.set("localtake", f.root.entries.get("local")!);
    f.root.entries.delete("local");
    await f.store.housekeeping(now);
    expect([...f.root.entries.keys()]).toEqual(["local"]);
    const migrated = await f.store.participant(
      recording.recordingId,
      recording.participantId,
    );
    expect(
      await (
        await (await migrated.getFileHandle("completion.json")).getFile()
      ).text(),
    ).toContain('"preserved": true');
  });
  it("preserves both copies when legacy migration meets a conflicting destination", async () => {
    const f = fixture(),
      recording = meta();
    await f.store.initialize(recording);
    const original = await f.store.participant(
      recording.recordingId,
      recording.participantId,
    );
    await writeJson(original, "completion.json", { original: true });
    f.root.entries.set("localtake", f.root.entries.get("local")!);
    f.root.entries.delete("local");
    await f.store.initialize(recording);
    await writeJson(
      await f.store.participant(recording.recordingId, recording.participantId),
      "completion.json",
      { other: true },
    );
    await expect(f.store.housekeeping(now)).rejects.toThrow("Dateikonflikt");
    expect(
      await (
        await (await original.getFileHandle("completion.json")).getFile()
      ).text(),
    ).toContain('"original": true');
    expect(f.root.entries.has("localtake")).toBe(true);
  });
  it("uses one explicit time zone and protects Windows-reserved or staging folder names", () => {
    expect(sessionStamp("2026-10-09T08:00:01Z")).toBe("2026-10-09_10-00-01");
    for (const value of ["temp", "local", "con", "NUL.txt"])
      expect(safeFolderName(value)).toMatch(/^Raum-/);
    expect(safeFolderName("Podcast / Gäste")).toBe("Podcast-Gaste");
    expect(safeFolderName("..\\../../")).toBe("Raum");
  });
});
