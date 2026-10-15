import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DiagnosticLog } from "../apps/client/src/core/diagnostics.js";
import { TelemetryUploader } from "../apps/client/src/core/telemetry.js";
import { TELEMETRY_BODY_BYTES } from "../packages/protocol/src/telemetry.js";
import { summarizeRtc } from "../apps/client/src/live/statistics.js";

const uploaders: TelemetryUploader[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  uploaders.splice(0).forEach((uploader) => uploader.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture(
  request = vi.fn(
    async () =>
      new Response(JSON.stringify({ accepted: true }), { status: 202 }),
  ),
) {
  const log = new DiagnosticLog();
  const context = {
    enabled: true,
    credentials: {
      roomId: randomUUID(),
      participantId: randomUUID(),
      token: "session-secret",
    },
  };
  const sample = vi.fn((): unknown => ({
    recording: { state: "recording", lag: 0 },
    rtc: { route: "direct" },
  }));
  const uploader = new TelemetryUploader(
    log,
    () => context,
    sample,
    request as typeof fetch,
  );
  uploaders.push(uploader);
  return { log, context, uploader, request, sample };
}

it("calls the browser fetch with its global receiver", async () => {
  const request = vi.fn(function (this: unknown) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(
      new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
  });
  vi.stubGlobal("fetch", request);
  const log = new DiagnosticLog();
  const uploader = new TelemetryUploader(
    log,
    () => ({
      enabled: true,
      credentials: {
        roomId: randomUUID(),
        participantId: randomUUID(),
        token: "test",
      },
    }),
    () => ({}),
  );
  uploaders.push(uploader);
  log.record("app", "started");
  await vi.advanceTimersByTimeAsync(5000);
  expect(request).toHaveBeenCalledTimes(1);
  expect(uploader.status().lastError).toBeNull();
  expect(uploader.status().lastAcceptedAt).not.toBeNull();
});

it("does no work until enabled, then sends compact diagnostics independently of room signaling", async () => {
  const f = fixture();
  f.context.enabled = false;
  f.log.record("app", "started");
  await vi.advanceTimersByTimeAsync(90_000);
  expect(f.request).not.toHaveBeenCalled();
  expect(f.sample).not.toHaveBeenCalled();
  f.context.enabled = true;
  f.log.record("live", "ice.candidate_error", { code: 701 });
  expect(f.request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.request).toHaveBeenCalledTimes(1);
  const [url, options] = f.request.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe("/api/telemetry");
  const batch = JSON.parse(options.body as string);
  expect(
    batch.events.some(
      (event: { event: string }) => event.event === "ice.candidate_error",
    ),
  ).toBe(true);
  expect(options.headers).toMatchObject({
    Authorization: "Bearer session-secret",
  });
  expect(f.uploader.status().lastAcceptedAt).not.toBeNull();
});

it("bounds an error storm, sends at most every five seconds and caps UTF-8 bodies", async () => {
  const f = fixture();
  f.sample.mockReturnValue({
    huge: Array.from({ length: 24 }, () => "ä".repeat(1024)),
  });
  for (let i = 0; i < 1000; i++)
    f.log.record("app", "error", { message: "ä".repeat(2000), sequence: i });
  expect(f.uploader.status().queued).toBeLessThanOrEqual(128);
  expect(f.uploader.status().dropped).toBeGreaterThan(800);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.request.mock.calls.length).toBeLessThanOrEqual(4);
  for (const call of f.request.mock.calls) {
    const options = (call as unknown as [string, RequestInit])[1];
    expect(
      new TextEncoder().encode(options.body as string).length,
    ).toBeLessThanOrEqual(TELEMETRY_BODY_BYTES);
  }
});

it("times out a stalled upload, keeps only one in flight and backs off without new samples", async () => {
  const request = vi.fn(() => new Promise<Response>(() => undefined));
  const f = fixture(request);
  f.log.record("live", "failed");
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.uploader.status().sending).toBe(true);
  void f.uploader.flush();
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.uploader.status()).toMatchObject({ sending: false, failures: 1 });
  for (let i = 0; i < 300; i++) f.log.record("live", "error");
  await vi.advanceTimersByTimeAsync(9000);
  expect(request).toHaveBeenCalledTimes(1);
  expect(f.sample).toHaveBeenCalledTimes(1);
});

it("retries identical batches for deduplication and drops stale data after repeated failures", async () => {
  const request = vi.fn(
    async () =>
      new Response(JSON.stringify({ accepted: false }), { status: 202 }),
  );
  const f = fixture(request);
  f.log.record("live", "error");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.uploader.status().dropped).toBeGreaterThan(0);
  expect(f.uploader.status().lastError).toContain("Server verwirft");
  const calls = request.mock.calls as unknown as [string, RequestInit][];
  expect(calls[0][1].body).toBe(calls[1][1].body);
  expect(calls[1][1].body).toBe(calls[2][1].body);
});

it("clears old room events and ignores an in-flight completion after identity changes", async () => {
  let finish!: (response: Response) => void;
  const request = vi.fn(
    () =>
      new Promise<Response>((done) => {
        finish = done;
      }),
  );
  const f = fixture(request);
  f.log.record("live", "old-room-error");
  await vi.advanceTimersByTimeAsync(5000);
  const original = f.context.credentials;
  f.context.credentials = { ...original, roomId: randomUUID() };
  f.log.record("live", "new-room-error");
  finish(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
  await Promise.resolve();
  expect(f.uploader.status().lastAcceptedAt).toBeNull();
  await vi.advanceTimersByTimeAsync(5000);
  const batch = JSON.parse(
    (request.mock.calls as unknown as [string, RequestInit][])[1][1]
      .body as string,
  );
  expect(JSON.stringify(batch)).not.toContain("old-room-error");
  expect(JSON.stringify(batch)).toContain("new-room-error");
});

it("uses cached WebRTC reports and prefers the transport's selected pair", () => {
  const report = new Map([
    [
      "other",
      {
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        localCandidateId: "local",
      },
    ],
    [
      "local",
      { type: "local-candidate", candidateType: "srflx", protocol: "udp" },
    ],
    [
      "relay",
      { type: "remote-candidate", candidateType: "relay", protocol: "tcp" },
    ],
    [
      "selected",
      {
        type: "candidate-pair",
        state: "succeeded",
        localCandidateId: "local",
        remoteCandidateId: "relay",
      },
    ],
    ["transport", { type: "transport", selectedCandidatePairId: "selected" }],
    [
      "audio",
      {
        type: "inbound-rtp",
        kind: "audio",
        packetsLost: 3,
        jitter: 0.02,
        concealedSamples: 10,
      },
    ],
  ]);
  const sample = summarizeRtc(report as unknown as RTCStatsReport);
  expect(sample.selectedPair?.route).toBe("TURN");
  expect(sample.media[0]).toMatchObject({
    packetsLost: 3,
    jitter: 0.02,
    concealedSamples: 10,
  });
  expect(sample.media[0].framesDropped).toBeUndefined();
});
