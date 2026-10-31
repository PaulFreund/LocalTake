import { describe, expect, it } from "vitest";
import { reconnectedRecordingStatus } from "../apps/client/src/room/recovery.js";
import type { RecordingStatus } from "../packages/protocol/src/index.js";

const active: RecordingStatus = {
  recordingId: crypto.randomUUID(),
  state: "recording",
  sources: [
    {
      trackId: crypto.randomUUID(),
      label: "Camera",
      kind: "video",
      state: "recording",
      savedSeconds: 4,
      capturedSeconds: 5,
      bytes: 1024,
      segments: 2,
    },
  ],
};
describe("recording status after reconnect", () => {
  it("preserves a running local recorder through a signaling outage", () => {
    expect(
      reconnectedRecordingStatus(active, { ...active, state: "partial" }),
    ).toBe(active);
  });
  it("preserves a finalized local recording while reconnecting for transfer", () => {
    const saved = { ...active, state: "saved" as const };
    expect(reconnectedRecordingStatus(saved, active)).toBe(saved);
  });
  it.each(["recording", "finalizing"] as const)(
    "marks a %s report with no local recorder as interrupted",
    (state) => {
      const result = reconnectedRecordingStatus(undefined, {
        ...active,
        state,
      });
      expect(result).toMatchObject({
        recordingId: active.recordingId,
        state: "partial",
        sources: [{ state: "partial", bytes: 1024, segments: 2 }],
      });
      expect(result!.sources[0].warning).toMatch(/Neuladen unterbrochen/);
      expect(active.state).toBe("recording");
      expect(active.sources[0].state).toBe("recording");
    },
  );
  it("leaves durable source failures and completed reports intact", () => {
    const failure = {
      ...active.sources[0],
      state: "failed" as const,
      error: "Device ended",
    };
    expect(
      reconnectedRecordingStatus(undefined, { ...active, sources: [failure] })!
        .sources[0],
    ).toBe(failure);
    expect(
      reconnectedRecordingStatus(undefined, { ...active, state: "saved" }),
    ).toBeNull();
    expect(reconnectedRecordingStatus(undefined, undefined)).toBeNull();
  });
});
