import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { TelemetryStore } from "./telemetry-store.js";
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const production = process.env.NODE_ENV === "production";
const secret =
  process.env.ROOM_SIGNING_SECRET ||
  (production ? "" : randomBytes(32).toString("hex"));
if (secret.length < 32)
  throw new Error("ROOM_SIGNING_SECRET muss mindestens 32 Zeichen lang sein.");
if (production && secret.startsWith("replace-with-"))
  throw new Error("ROOM_SIGNING_SECRET ist noch ein Beispielwert.");
const port = Number(process.env.PORT || (production ? 3000 : 43170));
const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
if (production && !origin.startsWith("https://"))
  throw new Error("PUBLIC_ORIGIN muss in Produktion HTTPS verwenden.");
const turnEnabledValue = process.env.TURN_ENABLED ?? "true";
if (turnEnabledValue !== "true" && turnEnabledValue !== "false")
  throw new Error("TURN_ENABLED muss true oder false sein.");
const turnEnabled = turnEnabledValue === "true";
const iceTransportPolicy = process.env.ICE_TRANSPORT_POLICY ?? "all";
if (iceTransportPolicy !== "all" && iceTransportPolicy !== "relay")
  throw new Error("ICE_TRANSPORT_POLICY muss all oder relay sein.");
if (
  turnEnabled &&
  (process.env.TURN_URLS || "")
    .split(",")
    .some((url) => /^turns?:/.test(url.trim())) &&
  (!process.env.TURN_SHARED_SECRET ||
    process.env.TURN_SHARED_SECRET.startsWith("replace-with-"))
)
  throw new Error("TURN-URLs erfordern ein echtes TURN_SHARED_SECRET.");
let telemetry: TelemetryStore | undefined;
if (process.env.TELEMETRY_DIR) {
  try {
    telemetry = await TelemetryStore.open({
      directory: process.env.TELEMETRY_DIR,
      maxBytes: Number(process.env.TELEMETRY_MAX_BYTES || 900_000_000),
    });
  } catch {
    console.warn(
      "Telemetrie konnte nicht geöffnet werden; der Dienst läuft ohne Diagnoseprotokoll weiter.",
    );
  }
}
const app = await createApp({
  secret,
  origin,
  maxParticipants: Number(process.env.MAX_PARTICIPANTS || 4),
  turnEnabled,
  iceTransportPolicy,
  turnUrls: (process.env.TURN_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
  turnSecret: process.env.TURN_SHARED_SECRET,
  clientDir: resolve("dist/client"),
  logger: true,
  telemetry,
});
await app.listen({ port, host: process.env.HOST || "127.0.0.1" });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
