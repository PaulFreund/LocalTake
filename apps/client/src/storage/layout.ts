import type { RecordingMeta } from "../../../../packages/protocol/src/index.js";

export const LOCAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
export function safeFolderName(value: string, limit = 32) {
  const name =
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, limit)
      .replace(/[.-]+$/g, "") || "Raum";
  return /^(temp|local|localtake|con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(
    name,
  )
    ? `Raum-${name}`
    : name;
}
// A shared UTC take date and explicit time zone keep all guests, delayed uploads
// and computers in different time zones in the same folder.
export function sessionStamp(iso: string) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}_${part("hour")}-${part("minute")}-${part("second")}`;
}
export function takePath(recording: RecordingMeta): [string, string] {
  return [
    safeFolderName(
      recording.sessionName ||
        (recording.roomId
          ? `Raum-${recording.roomId.slice(0, 8)}`
          : "Lokale-Aufnahmen"),
    ),
    `Aufnahme-${sessionStamp(recording.sessionStartedAt || recording.createdAt)}-${recording.recordingId.slice(0, 12)}`,
  ];
}
