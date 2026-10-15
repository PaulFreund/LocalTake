// Shared wire limits. Telemetry never contains media, chat or complete SDP.
export const TELEMETRY_BODY_BYTES = 12_288;
export const TELEMETRY_INTERVAL_MS = 30_000;
export const TELEMETRY_MIN_INTERVAL_MS = 5_000;
export const TELEMETRY_MAX_EVENTS = 24;
export type TelemetryEvent = {
  at: string;
  elapsedMs: number;
  scope: string;
  event: string;
  detail?: unknown;
};
export type TelemetryBatch = {
  version: 1;
  pageId: string;
  sequence: number;
  dropped: number;
  events: TelemetryEvent[];
  sample?: unknown;
};

export function redactDiagnosticText(value: string): string {
  return (
    value
      // LocalTake signs two-part tokens; also cover three-part JWTs.
      .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?\b/g, "[redacted]")
      .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
      .replace(/(a=ice-(?:pwd|ufrag):)[^\r\n]+/gi, "$1[redacted]")
      .replace(/(\bufrag\s+)\S+/gi, "$1[redacted]")
      .replace(/((?:https?|turns?):\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
      .replace(
        /([?#&](?:invite|token|credential|secret)=)[^&#\s]+/gi,
        "$1[redacted]",
      )
  );
}
export const diagnosticSecretKey =
  /^(?:.*token|.*secret|.*password|credential|authorization|cookie|username|usernameFragment|base64Certificate|icePwd|iceUfrag)$/i;

// Bound work and memory independently on both sides, even for a buggy client.
export function compactDiagnostic(value: unknown, depth = 0): unknown {
  if (typeof value === "string")
    return redactDiagnosticText(value).slice(0, 1024);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value == null) return value;
  if (depth >= 10) return "[truncated]";
  if (Array.isArray(value))
    return value.slice(0, 24).map((item) => compactDiagnostic(item, depth + 1));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 24)
        .map(([key, item]) => [
          key.slice(0, 80),
          diagnosticSecretKey.test(key)
            ? "[redacted]"
            : /^(?:sdp|chat|text|mediaData)$/i.test(key)
              ? "[omitted]"
              : compactDiagnostic(item, depth + 1),
        ]),
    );
  return undefined;
}
