// Compare media timestamps with the requested recording window, never the time
// spent closing files. Small capture/stop scheduling delays are tolerated.
import type { Inventory } from "./index.js";
export type CaptureWindow = { startMs: number; stopMs: number };
export type MediaCoverage = {
  label: string;
  startMs?: number;
  endMs?: number;
  savedMs: number;
  frameRate?: number;
};
export function inventoryCoverage(inventory: Inventory): MediaCoverage[] {
  const result = new Map<string, MediaCoverage>();
  const tracks = new Map(
    inventory.tracks.map((track) => [
      `${track.trackId}/${track.epochId}`,
      track,
    ]),
  );
  for (const track of inventory.tracks) {
    if (!result.has(track.trackId))
      result.set(track.trackId, {
        label: track.label,
        frameRate: track.frameRate,
        savedMs: 0,
      });
  }
  for (const segment of inventory.segments) {
    const track = tracks.get(`${segment.trackId}/${segment.epochId}`);
    if (!track) continue;
    const media = result.get(track.trackId)!;
    media.startMs = Math.min(
      media.startMs ?? Infinity,
      track.localStartMs + segment.mediaStartUs / 1000,
    );
    media.endMs = Math.max(
      media.endMs ?? -Infinity,
      track.localStartMs +
        (segment.mediaStartUs + segment.mediaDurationUs) / 1000,
    );
    media.savedMs += segment.mediaDurationUs / 1000;
  }
  return [...result.values()];
}
export function coverageIssue(
  media: MediaCoverage,
  window: CaptureWindow,
): string | undefined {
  const tolerance = Math.max(250, media.frameRate ? 2000 / media.frameRate : 0);
  if (media.startMs === undefined || media.endMs === undefined)
    return `${media.label}: Aufnahmezeitraum ist nicht nachgewiesen.`;
  const missingStart = Math.max(0, media.startMs - window.startMs);
  const missingEnd = Math.max(0, window.stopMs - media.endMs);
  const missingMedia = Math.max(
    0,
    window.stopMs - window.startMs - media.savedMs,
  );
  if (
    missingStart > tolerance ||
    missingEnd > tolerance ||
    missingMedia > tolerance
  )
    return `${media.label}: Aufnahme unvollständig (Anfang fehlt: ${(missingStart / 1000).toFixed(2)} s; Ende fehlt: ${(missingEnd / 1000).toFixed(2)} s; fehlende Mediendauer: ${(missingMedia / 1000).toFixed(2)} s).`;
}

// Old recordings have no requested time window. Compare available sources of
// the same take as well, so an old one-frame clip cannot stay green beside a
// four-second recording. Keep original metadata and media unchanged.
export function takeCoverage<T extends Inventory>(
  inventories: T[],
  expectedMs = 0,
): T[] {
  const durations = inventories.flatMap((inventory) =>
    inventoryCoverage(inventory).map((media) => ({
      inventory,
      track: media,
      ms: media.savedMs,
    })),
  );
  const reference = Math.max(expectedMs, 0, ...durations.map((d) => d.ms));
  return inventories.map((inventory) => {
    const issues = durations
      .filter(
        (d) =>
          d.inventory === inventory &&
          reference - d.ms >
            Math.max(500, d.track.frameRate ? 2000 / d.track.frameRate : 0),
      )
      .map(
        (d) =>
          `${d.track.label}: Aufnahme unvollständig – ${(d.ms / 1000).toFixed(2)} s vorhanden; dieser Take umfasst mindestens ${(reference / 1000).toFixed(2)} s.`,
      );
    return issues.length
      ? {
          ...inventory,
          complete: false,
          issues: [...new Set([...inventory.issues, ...issues])],
        }
      : inventory;
  });
}
