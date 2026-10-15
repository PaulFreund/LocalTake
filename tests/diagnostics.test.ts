import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  collectDiagnostics,
  connectionDiagnosis,
  DiagnosticLog,
  redactDiagnostics,
  selectedIcePair,
} from "../apps/client/src/core/diagnostics.js";
import type { StudioRuntime } from "../apps/client/src/core/runtime.js";
import type { Remote } from "../apps/client/src/live/mesh.js";

beforeEach(() => {
  vi.stubGlobal("navigator", {
    userAgent: "Chrome on macOS",
    platform: "MacIntel",
    languages: ["de-DE"],
    onLine: true,
    hardwareConcurrency: 4,
    storage: { estimate: async () => ({ usage: 1024, quota: 4096 }) },
  });
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("location", {
    origin: "https://record.example.test",
    pathname: "/",
    hash: "#invite=DO_NOT_EXPORT_INVITATION",
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const stats = [
  {
    id: "local",
    type: "local-candidate",
    candidateType: "srflx",
    address: "192.0.2.10",
    port: 1234,
    protocol: "udp",
  },
  {
    id: "remote",
    type: "remote-candidate",
    candidateType: "srflx",
    address: "198.51.100.20",
    port: 5678,
    protocol: "udp",
  },
  {
    id: "pair",
    type: "candidate-pair",
    localCandidateId: "local",
    remoteCandidateId: "remote",
    state: "succeeded",
    nominated: true,
  },
  {
    id: "transport",
    type: "transport",
    selectedCandidatePairId: "pair",
    dtlsState: "connected",
  },
];
const description = (type: RTCSdpType) => ({
  type,
  toJSON: () => ({
    type,
    sdp: "v=0\r\na=ice-pwd:DO_NOT_EXPORT_ICE_PASSWORD\r\na=ice-ufrag:PRIVATE_FRAGMENT\r\na=candidate:1 1 udp 123 192.0.2.10 1234 typ srflx\r\n",
  }),
});
function fixture() {
  const remote = {
    id: "b",
    peer: { id: "b", name: "Gegenstelle", connectionId: "remote-connection" },
    linkId: "link",
    pc: {
      connectionState: "failed",
      iceConnectionState: "failed",
      iceGatheringState: "complete",
      signalingState: "stable",
      localDescription: description("offer"),
      remoteDescription: description("answer"),
      pendingLocalDescription: null,
      pendingRemoteDescription: null,
      getTransceivers: () => [],
      getStats: vi.fn(
        async () => new Map(stats.map((stat) => [stat.id, stat])),
      ),
      restartIce: vi.fn(),
    },
    candidates: [],
    control: null,
    files: null,
    makingOffer: false,
    ignoreOffer: false,
    settingAnswer: false,
    stats: { bitrate: 0, rtt: 0, quality: 0 },
  } as unknown as Remote;
  const studio = {
    diagnostics: new DiagnosticLog(),
    mesh: {
      remotes: new Map([[remote.id, remote]]),
      paused: false,
      diagnosticIceTransportPolicy: () => "relay",
      diagnosticIceServers: () => [
        { urls: "stun:stun.example.test:3478", credentialsConfigured: false },
        {
          urls: "turn:turn.example.test:3478",
          credentialsConfigured: true,
          credential: "DO_NOT_EXPORT_TURN_PASSWORD",
        },
      ],
    },
    room: {
      credentials: {
        roomId: "room",
        participantId: "a",
        token: "DO_NOT_EXPORT_ACCESS_TOKEN",
        inviteToken: "DO_NOT_EXPORT_INVITATION",
      },
      state: {
        peers: [{ id: "a", role: "host", name: "Host", connected: true }],
      },
      diagnosticState: () => ({
        authenticated: true,
        socket: "open",
        reconnectAttempts: 0,
      }),
      clock: { snapshot: () => ({ offsetMs: 0, uncertaintyMs: 2 }) },
      send: vi.fn(),
    },
    capture: { sources: [], context: null, micMuted: false, camMuted: false },
    quality: "1080",
    sourceErrors: {},
    error: "",
    recording: null,
    lastRecording: null,
    folderSupported: true,
    browserStorageSupported: true,
    storageKind: "folder",
    store: {},
  } as unknown as StudioRuntime;
  return { studio, remote };
}

it("redacts credentials and invitations while preserving diagnostic network addresses", () => {
  const sanitized = JSON.stringify(
    redactDiagnostics({
      credential: "private-turn-secret",
      token: "private-access-token",
      nested: {
        usernameFragment: "private-fragment",
        address: "192.0.2.10",
        port: 1234,
      },
      message:
        "https://record.example.test/#invite=private-invitation&token=another-token a=ice-pwd:private-ice-secret\r\n",
      candidate:
        "candidate:1 1 udp 123 192.0.2.10 1234 typ srflx ufrag private-fragment",
    }),
  );
  for (const secret of [
    "private-turn-secret",
    "private-access-token",
    "private-fragment",
    "private-invitation",
    "another-token",
    "private-ice-secret",
  ])
    expect(sanitized).not.toContain(secret);
  expect(sanitized).toContain("192.0.2.10");
  expect(sanitized).toContain("1234");
});

it("keeps only the bounded recent history, with secrets removed before storage", () => {
  const log = new DiagnosticLog(3);
  for (let n = 0; n < 5; n++)
    log.record("live", `event-${n}`, { credential: "private-secret" });
  expect(log.entries.map((entry) => entry.event)).toEqual([
    "event-2",
    "event-3",
    "event-4",
  ]);
  expect(log.dropped).toBe(2);
  expect(JSON.stringify(log.entries)).not.toContain("private-secret");
});

it("uses the transport's selected ICE pair instead of an older nominated pair", () => {
  const selected = selectedIcePair([
    {
      id: "old-pair",
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      localCandidateId: "old-local",
      remoteCandidateId: "remote",
    },
    ...stats,
  ]);
  expect(selected?.pair.id).toBe("pair");
  expect(selected?.route).toBe("direct");
  expect(selected?.local?.address).toBe("192.0.2.10");
});

it("detects TURN when the remote endpoint uses a relay", () => {
  expect(
    selectedIcePair(
      stats.map((stat) =>
        stat.id === "remote" ? { ...stat, candidateType: "relay" } : stat,
      ),
    )?.route,
  ).toBe("TURN");
});

it("distinguishes a missing answer from failed ICE after SDP was exchanged", () => {
  const { remote } = fixture();
  expect(connectionDiagnosis(remote)).toContain("ICE fehlgeschlagen");
  Object.assign(remote.pc, { remoteDescription: null });
  expect(connectionDiagnosis(remote)).toBe("Antwort der Gegenstelle fehlt");
});

it("collects failed connections and their history without sending probes or exporting access secrets", async () => {
  const { studio, remote } = fixture();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  studio.diagnostics.record("live", "ice.candidate_error", {
    code: 701,
    url: "stun:stun.example.test:3478",
  });
  const report = await collectDiagnostics(studio);
  const json = JSON.stringify(report);
  expect(report.peers[0].ice).toBe("failed");
  expect(report.peers[0].rtcStats).toHaveLength(4);
  expect(report.peers[0].descriptions.local?.sdp).toContain("[redacted]");
  expect(report.events[0].event).toBe("ice.candidate_error");
  expect(report.room.role).toBe("host");
  expect(report.iceTransportPolicy).toBe("relay");
  for (const secret of [
    "DO_NOT_EXPORT_ACCESS_TOKEN",
    "DO_NOT_EXPORT_INVITATION",
    "DO_NOT_EXPORT_ICE_PASSWORD",
    "DO_NOT_EXPORT_TURN_PASSWORD",
    "PRIVATE_FRAGMENT",
  ])
    expect(json).not.toContain(secret);
  expect(fetch).not.toHaveBeenCalled();
  expect(studio.room.send).not.toHaveBeenCalled();
  expect(remote.pc.restartIce).not.toHaveBeenCalled();
});

it("still exports states and SDP if the browser cannot return RTC statistics", async () => {
  const { studio, remote } = fixture();
  vi.mocked(remote.pc.getStats).mockRejectedValue(
    new Error("connection unavailable"),
  );
  const report = await collectDiagnostics(studio);
  expect(report.peers[0].statsError).toBe("connection unavailable");
  expect(report.peers[0].signaling).toBe("stable");
  expect(report.peers[0].descriptions.remote?.type).toBe("answer");
});

it("does not leave the diagnostic panel blocked by a hanging statistics request", async () => {
  vi.useFakeTimers();
  const { studio, remote } = fixture();
  vi.mocked(remote.pc.getStats).mockReturnValue(new Promise(() => {}));
  const pending = collectDiagnostics(studio);
  await vi.advanceTimersByTimeAsync(1500);
  const report = await pending;
  expect(report.peers[0].statsError).toContain("zeitlich abgebrochen");
  expect(report.browser.online).toBe(true);
});
