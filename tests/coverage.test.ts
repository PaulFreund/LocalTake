import { expect, it } from "vitest";
import {
  coverageIssue,
  inventoryCoverage,
  takeCoverage,
} from "../packages/protocol/src/coverage.js";
import { buildSessions } from "../apps/client/src/core/sessions.js";
import type { Inventory } from "../packages/protocol/src/index.js";

const window = { startMs: 1000, stopMs: 5000 };
it.each([
  { startMs: 4900, endMs: 4933, savedMs: 33 },
  { startMs: 1000, endMs: 1300, savedMs: 300 },
  { startMs: 1000, endMs: 5000, savedMs: 2000 },
  { savedMs: 4000 },
])("rejects missing capture time despite certified bytes: %j", (media) => {
  expect(coverageIssue({ label: "Camera", ...media }, window)).toBeTruthy();
});
it("tolerates capture scheduling jitter without counting slow file closure as missing media", () => {
  expect(
    coverageIssue(
      {
        label: "Camera",
        startMs: 1040,
        endMs: 4970,
        savedMs: 3930,
        frameRate: 30,
      },
      window,
    ),
  ).toBeUndefined();
});

function inventory(durationMs: number): Inventory {
  const recordingId = crypto.randomUUID(),
    participantId = crypto.randomUUID(),
    trackId = crypto.randomUUID(),
    epochId = crypto.randomUUID(),
    clockId = crypto.randomUUID();
  return {
    recording: {
      formatVersion: 1,
      recordingId,
      participantId,
      participantName: "Guest",
      createdAt: new Date().toISOString(),
      appVersion: "test",
      trackIds: [trackId],
      roomId: crypto.randomUUID(),
    },
    tracks: [
      {
        formatVersion: 1,
        trackId,
        epochId,
        label: "Camera",
        kind: "video",
        codec: "avc",
        width: 640,
        height: 360,
        frameRate: 30,
        localStartMs: 1000,
        clock: {
          id: clockId,
          epoch: "test",
          localMs: 1000,
          offsetMs: 0,
          drift: 1,
          uncertaintyMs: 1,
          samples: 1,
        },
        settings: {},
      },
    ],
    segments: [
      {
        formatVersion: 1,
        recordingId,
        participantId,
        trackId,
        epochId,
        sequence: 0,
        fileName: "000000_000000000000us.mp4",
        byteLength: 100,
        sha256: "0".repeat(64),
        mediaStartUs: 0,
        mediaDurationUs: durationMs * 1000,
        clockMappingId: clockId,
      },
    ],
    complete: true,
    issues: [],
  };
}
it("recognizes an old one-frame clip as partial beside the other originals without changing source metadata", () => {
  const host = inventory(4000),
    phone = inventory(33);
  phone.recording.recordingId = host.recording.recordingId;
  phone.recording.roomId = host.recording.roomId;
  const checked = takeCoverage([host, phone]);
  expect(checked[0].complete).toBe(true);
  expect(checked[1].complete).toBe(false);
  expect(checked[1].issues[0]).toContain("Aufnahme unvollständig");
  expect(phone.complete).toBe(true);
  const view = buildSessions({
    library: [host, phone],
    manifests: [],
    room: null,
    selfFor: () => host.recording.participantId,
    transfers: [],
    sync: [],
    local: [],
  })[0];
  expect(
    view.participants.find((p) => p.id === phone.recording.participantId)
      ?.state,
  ).toBe("partial");
  expect(
    view.recordings.find(
      (i) => i.recording.participantId === phone.recording.participantId,
    )?.complete,
  ).toBe(false);
});
it("checks a known take duration even when all sources of a late participant are equally short", () => {
  const phone = inventory(33);
  expect(takeCoverage([phone], 4000)[0].complete).toBe(false);
});
it("labels legacy bytes as duration-unverified when no shared window can be established", () => {
  const old = inventory(4000);
  const view = buildSessions({
    library: [old],
    manifests: [],
    room: null,
    selfFor: () => old.recording.participantId,
    transfers: [],
    sync: [],
    local: [],
  })[0];
  expect(view.participants[0].state).toBe("unverified");
  expect(view.settled).toBe(true);
});
it("combines consecutive epochs of a source instead of treating each epoch as a whole take", () => {
  const take = inventory(2000),
    first = take.tracks[0],
    segment = take.segments[0];
  const epochId = crypto.randomUUID();
  take.tracks.push({ ...first, epochId, localStartMs: 3000 });
  take.segments.push({ ...segment, epochId });
  const media = inventoryCoverage(take)[0];
  expect(media).toMatchObject({ startMs: 1000, endMs: 5000, savedMs: 4000 });
  expect(coverageIssue(media, window)).toBeUndefined();
  expect(takeCoverage([take], 4000)[0].complete).toBe(true);
});
