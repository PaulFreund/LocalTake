import type { CaptureSource } from "./manager.js";

const key = (kind: "video" | "audio") => `localtake-device-${kind}`;

export function preferredDevice(
  kind: "video" | "audio",
  storage?: Pick<Storage, "getItem">,
) {
  try {
    return (storage ?? localStorage).getItem(key(kind)) || "";
  } catch {
    return "";
  }
}

export function rememberDevice(
  source: CaptureSource,
  storage?: Pick<Storage, "setItem">,
) {
  const deviceId = source.settings.deviceId;
  if (source.kind === "screen" || source.synthetic || !deviceId) return;
  try {
    (storage ?? localStorage).setItem(key(source.kind), deviceId);
  } catch {
    // Recording must remain usable when optional preferences cannot be saved.
  }
}
