import type { RecordingStatus } from "../../../../packages/protocol/src/index.js";

// A signaling reconnect keeps its actual recorder; a new page has no recorder
// to back an old "recording" status. Never imply a seamless capture resume.
export function reconnectedRecordingStatus(
  local: RecordingStatus | undefined,
  previous: RecordingStatus | null | undefined,
): RecordingStatus | null {
  if (local) return local;
  if (!previous || !["recording", "finalizing"].includes(previous.state))
    return null;
  return {
    ...previous,
    state: "partial",
    sources: previous.sources.map((source) =>
      ["recording", "finalizing"].includes(source.state)
        ? {
            ...source,
            state: "partial",
            warning:
              "Aufnahme durch Neuladen unterbrochen. Gesicherte Segmente bleiben im Aufnahmeordner erhalten.",
          }
        : source,
    ),
  };
}
