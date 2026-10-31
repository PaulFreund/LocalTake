import { writeFile } from "node:fs/promises";
import { clientMessageSchema } from "../packages/protocol/src/index.ts";

// Regenerate only when deliberately changing the shared browser wire contract.
const id = "10000000-0000-4000-8000-000000000001";
const source = {
  trackId: id,
  label: "Kamera",
  kind: "video",
  state: "saved",
  savedSeconds: 1.5,
  capturedSeconds: 2,
  bytes: 100,
  segments: 1,
};
const messages = [
  { type: "auth", version: 1, token: "token", name: "  Host  " },
  { type: "auth", version: 1, token: "", name: "\ufeff\u00a0Host\u00a0" },
  { type: "clock.probe", t1: 0 },
  { type: "clock.probe", t1: 1e100 },
  { type: "peer.signal", to: id },
  {
    type: "peer.signal",
    to: id,
    linkId: id,
    restart: true,
    description: { type: "offer", sdp: "v=0", ignored: true },
    candidate: null,
  },
  {
    type: "peer.signal",
    to: id,
    candidate: {
      candidate: "",
      sdpMid: null,
      sdpMLineIndex: 64,
      usernameFragment: null,
      ignored: true,
    },
  },
  {
    type: "media",
    media: { micMuted: false, camMuted: true, sharing: false, ignored: true },
  },
  { type: "ready", ready: true },
  { type: "ready", ready: false, reason: "", archiveReady: false },
  { type: "room.quality", quality: "2160" },
  {
    type: "archive.status",
    status: {
      pending: 1,
      bytes: 1.5,
      total: 1e100,
      state: "waiting",
      reason: "",
    },
  },
  { type: "record.prepare", commandId: id },
  { type: "record.ready", recordingId: id, ready: false, reason: "Speicher" },
  { type: "record.stop", recordingId: id, commandId: id },
  {
    type: "record.status",
    status: { recordingId: id, state: "saved", sources: [source] },
  },
  { type: "chat", text: "  Hallo 🌍  " },
  { type: "peer.signal", to: "00000000-0000-0000-0000-000000000000" },
  { type: "peer.signal", to: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
  ...["host", "guest", "unknown"].map((type) => ({ type })),
  null,
  [],
  "chat",
  {},
  { type: "auth", version: 2, token: "token", name: "Host" },
  { type: "auth", version: 1, token: "token", name: " " },
  { type: "auth", version: 1, token: "token", name: "😀".repeat(31) },
  { type: "clock.probe", t1: -1 },
  { type: "clock.probe", t1: "1" },
  { type: "peer.signal", to: id, restart: false },
  { type: "peer.signal", to: id, description: null },
  {
    type: "peer.signal",
    to: id,
    candidate: { candidate: "x", sdpMLineIndex: 1.5 },
  },
  {
    type: "peer.signal",
    to: id,
    candidate: { candidate: "x", sdpMLineIndex: -1 },
  },
  {
    type: "peer.signal",
    to: id,
    candidate: { candidate: "x", sdpMLineIndex: 65 },
  },
  { type: "peer.signal", to: id.replace("-4000-", "-0000-") },
  { type: "peer.signal", to: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" },
  { type: "peer.signal", to: id.replaceAll("-", "") },
  { type: "media", media: { micMuted: false, camMuted: false } },
  {
    type: "media",
    media: {
      micMuted: false,
      camMuted: false,
      sharing: false,
      livePaused: null,
    },
  },
  { type: "ready", ready: true, reason: null },
  { type: "ready", ready: 1 },
  { type: "room.quality", quality: 1080 },
  { type: "room.quality", quality: "480" },
  {
    type: "archive.status",
    status: { pending: 0.5, bytes: 0, total: 0, state: "idle" },
  },
  {
    type: "archive.status",
    status: { pending: 9007199254740992, bytes: 0, total: 0, state: "idle" },
  },
  {
    type: "record.status",
    status: {
      recordingId: id,
      state: "saved",
      sources: [{ ...source, bytes: -1 }],
    },
  },
  {
    type: "record.status",
    status: {
      recordingId: id,
      state: "saved",
      sources: [{ ...source, capturedSeconds: -1 }],
    },
  },
  {
    type: "record.status",
    status: {
      recordingId: id,
      state: "saved",
      sources: Array(17).fill(source),
    },
  },
  { type: "chat", text: " \t\r\n " },
  { type: "chat", text: "😀".repeat(1001) },
];
const fixtures = messages.map((input, index) => {
  const candidate =
    input && typeof input === "object" && !Array.isArray(input)
      ? { ...input, ignored: "strip this field" }
      : input;
  const parsed = clientMessageSchema.safeParse(candidate);
  return {
    name: `${index}: ${input?.type ?? typeof input}`,
    input: candidate,
    expected: parsed.success ? parsed.data : null,
  };
});
await writeFile(
  new URL("../tests/fixtures/protocol.json", import.meta.url),
  JSON.stringify(fixtures, null, 2) + "\n",
);
