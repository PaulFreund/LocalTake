import { z } from "zod";

// Zod probes `new Function` for faster object parsing; the studio's CSP forbids
// eval, and the blocked probe surfaces as a browser security issue. Must run
// before any schema below is constructed.
z.config({ jitless: true });

export const PROTOCOL_VERSION = 1 as const;
export const idSchema = z.string().uuid();
export const nameSchema = z.string().trim().min(1).max(60);
export const qualitySchema = z.enum(["720", "1080", "2160"]);
export type Quality = z.infer<typeof qualitySchema>;
export const mediaSchema = z.object({
  micMuted: z.boolean(),
  camMuted: z.boolean(),
  sharing: z.boolean(),
  livePaused: z.boolean().default(false),
});
export const sourceStatusSchema = z.object({
  trackId: idSchema,
  label: z.string().max(120),
  kind: z.enum(["video", "audio", "screen"]),
  state: z.enum(["recording", "finalizing", "saved", "failed", "partial"]),
  savedSeconds: z.number().finite().min(0),
  capturedSeconds: z.number().finite().min(0),
  bytes: z.number().int().nonnegative(),
  segments: z.number().int().nonnegative(),
  error: z.string().max(300).optional(),
  warning: z.string().max(300).optional(),
});
export const recordingStatusSchema = z.object({
  recordingId: idSchema,
  state: z.enum(["recording", "finalizing", "saved", "partial", "failed"]),
  sources: z.array(sourceStatusSchema).max(16),
});
export type RecordingStatus = z.infer<typeof recordingStatusSchema>;
export type SourceStatus = z.infer<typeof sourceStatusSchema>;
export type MediaState = z.infer<typeof mediaSchema>;
export type Credentials = {
  roomId: string;
  participantId: string;
  token: string;
  inviteToken?: string;
  telemetry?: { enabled: boolean };
};
export type Peer = {
  id: string;
  name: string;
  role: "host" | "guest";
  connected: boolean;
  connectionId?: string;
  media: MediaState;
  ready: boolean;
  readyReason?: string;
  archiveReady?: boolean;
  upload?: UploadStatus;
  recording: RecordingStatus | null;
};
export type RoomTake = {
  id: string;
  createdAt?: string;
  commandId: string;
  phase: "preparing" | "recording" | "stopping" | "done" | "cancelled";
  participants: string[];
  ready: string[];
  startAt?: number;
  reason?: string;
};
// The host is the session master: it sets the recording quality for everyone
// and receives all originals (archiveDestinationId is always the host).
export type RoomState = {
  roomId: string;
  name?: string;
  peers: Peer[];
  take: RoomTake | null;
  archiveDestinationId?: string | null;
  quality?: Quality;
};
export const uploadStatusSchema = z.object({
  pending: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
  total: z.number().nonnegative(),
  state: z.enum(["idle", "waiting", "uploading", "done", "error"]),
  reason: z.string().max(300).optional(),
});
export type UploadStatus = z.infer<typeof uploadStatusSchema>;
export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};
export type IceTransportPolicy = "all" | "relay";

const description = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().max(48_000),
});
const candidate = z.object({
  candidate: z.string().max(4096),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    version: z.literal(PROTOCOL_VERSION),
    token: z.string().max(4096),
    name: nameSchema,
  }),
  z.object({
    type: z.literal("clock.probe"),
    t1: z.number().finite().nonnegative(),
  }),
  z.object({
    type: z.literal("peer.signal"),
    to: idSchema,
    linkId: idSchema.optional(),
    restart: z.literal(true).optional(),
    description: description.optional(),
    candidate: candidate.nullable().optional(),
  }),
  z.object({ type: z.literal("media"), media: mediaSchema }),
  z.object({
    type: z.literal("ready"),
    ready: z.boolean(),
    reason: z.string().max(300).optional(),
    archiveReady: z.boolean().optional(),
  }),
  z.object({ type: z.literal("room.quality"), quality: qualitySchema }),
  z.object({ type: z.literal("archive.status"), status: uploadStatusSchema }),
  z.object({ type: z.literal("record.prepare"), commandId: idSchema }),
  z.object({
    type: z.literal("record.ready"),
    recordingId: idSchema,
    ready: z.boolean(),
    reason: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("record.stop"),
    commandId: idSchema,
    recordingId: idSchema,
  }),
  z.object({ type: z.literal("record.status"), status: recordingStatusSchema }),
  z.object({
    type: z.literal("chat"),
    text: z.string().trim().min(1).max(2000),
  }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage =
  | {
      type: "welcome";
      participantId: string;
      iceServers: IceServer[];
      iceTransportPolicy?: IceTransportPolicy;
      serverEpoch: string;
      telemetry?: { enabled: boolean };
      state: RoomState;
    }
  | { type: "room.state"; state: RoomState }
  | { type: "clock.reply"; t1: number; t2: number; t3: number; epoch: string }
  | {
      type: "peer.signal";
      from: string;
      connectionId?: string;
      linkId?: string;
      restart?: true;
      description?: { type: "offer" | "answer"; sdp: string };
      candidate?: z.infer<typeof candidate> | null;
    }
  | { type: "record.prepare"; take: RoomTake }
  | { type: "record.start"; take: RoomTake }
  | { type: "record.stop"; recordingId: string; commandId: string }
  | { type: "chat"; from: string; name: string; text: string; id: string }
  | { type: "error"; message: string; code: string };

export const recordingMetaSchema = z.object({
  formatVersion: z.literal(1),
  recordingId: idSchema,
  participantId: idSchema,
  participantName: nameSchema,
  createdAt: z.string().datetime(),
  appVersion: z.string().max(40),
  trackIds: z.array(idSchema).min(1).max(16),
  roomId: idSchema.optional(),
  sessionName: z.string().max(80).optional(),
  sessionStartedAt: z.string().datetime().optional(),
  purpose: z.enum(["recording", "check"]).optional(),
});
export type RecordingMeta = z.infer<typeof recordingMetaSchema>;
export const clockMappingSchema = z.object({
  id: idSchema,
  epoch: z.string().max(100),
  localMs: z.number().finite(),
  offsetMs: z.number().finite(),
  drift: z.number().finite(),
  uncertaintyMs: z.number().finite().nonnegative(),
  samples: z.number().int().nonnegative(),
});
export type ClockMapping = z.infer<typeof clockMappingSchema>;
export const trackMetaSchema = z.object({
  formatVersion: z.literal(1),
  trackId: idSchema,
  epochId: idSchema,
  label: z.string().max(120),
  kind: z.enum(["video", "audio", "screen"]),
  codec: z.enum(["avc", "pcm-f32"]),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: z.number().positive().optional(),
  bitrate: z.number().positive().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().min(1).max(32).optional(),
  localStartMs: z.number().finite(),
  clock: clockMappingSchema,
  settings: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
});
export type TrackMeta = z.infer<typeof trackMetaSchema>;
export const segmentSchema = z.object({
  formatVersion: z.literal(1),
  recordingId: idSchema,
  participantId: idSchema,
  trackId: idSchema,
  epochId: idSchema,
  sequence: z.number().int().min(0).max(10_000_000),
  fileName: z.string().regex(/^\d+_\d+us\.(mp4|wav)$/),
  byteLength: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaStartUs: z.number().int().nonnegative(),
  mediaDurationUs: z.number().int().positive(),
  sampleStart: z.number().int().nonnegative().optional(),
  sampleCount: z.number().int().positive().optional(),
  frameCount: z.number().int().positive().optional(),
  firstFrameIsKey: z.boolean().optional(),
  clockMappingId: idSchema,
});
export type Segment = z.infer<typeof segmentSchema>;
export type Inventory = {
  recording: RecordingMeta;
  tracks: TrackMeta[];
  segments: Segment[];
  complete: boolean;
  issues: string[];
  warnings?: string[];
};
export const completionSchema = z.object({
  formatVersion: z.literal(1),
  recordingId: idSchema,
  participantId: idSchema,
  finishedAt: z.string().datetime(),
  sources: z.array(sourceStatusSchema).max(16),
  issues: z.array(z.string().max(500)).max(1000).optional(),
});
export type Completion = z.infer<typeof completionSchema>;
// Written by the receiving host per take (one press of record until stop), so
// participants who have not delivered their originals yet remain visible.
export const sessionManifestSchema = z.object({
  formatVersion: z.literal(1),
  recordingId: idSchema,
  roomId: idSchema.optional(),
  startedAt: z.string().datetime(),
  roomName: nameSchema.optional(),
  participants: z
    .array(
      z.object({
        id: idSchema,
        name: z.string().max(60),
        role: z.enum(["host", "guest"]),
        state: recordingStatusSchema.shape.state.optional(),
        bytes: z.number().int().nonnegative().optional(),
      }),
    )
    .max(32),
});
export type SessionManifest = z.infer<typeof sessionManifestSchema>;
export const inventorySchema = z.object({
  recording: recordingMetaSchema,
  tracks: z.array(trackMetaSchema).max(64),
  segments: z.array(segmentSchema).max(100_000),
  complete: z.boolean(),
  issues: z.array(z.string().max(500)).max(1000),
  warnings: z.array(z.string().max(500)).max(1000).optional(),
});
export function segmentKey(
  segment: Pick<Segment, "trackId" | "epochId" | "sequence">,
): string {
  return `${segment.trackId}/${segment.epochId}/${segment.sequence}`;
}
