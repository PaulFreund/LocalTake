import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createApp, type Config } from "./helpers/rust-server.js";
import type {
  Credentials,
  ServerMessage,
} from "../packages/protocol/src/index.js";

const opened: {
  app: Awaited<ReturnType<typeof createApp>>;
  sockets: WebSocket[];
}[] = [];
afterEach(async () => {
  for (const { app, sockets } of opened.splice(0)) {
    sockets.forEach((s) => s.terminate());
    await app.close();
  }
});
async function fixture(config: Partial<Config> = {}) {
  const app = await createApp({
    secret: "a".repeat(64),
    origin: "http://localhost:5173",
    ...config,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const sockets: WebSocket[] = [];
  opened.push({ app, sockets });
  const host = (
    await app.inject({
      method: "POST",
      url: "/api/rooms",
      payload: { name: "Host", roomName: "Podcast" },
    })
  ).json<Credentials>();
  async function connect(credentials: Credentials, name: string) {
    const ws = new WebSocket(address.replace("http", "ws") + "/ws", {
      origin: "http://localhost:5173",
    });
    sockets.push(ws);
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    const wait = async (predicate: (m: ServerMessage) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(
        "Expected websocket message not received: " + JSON.stringify(messages),
      );
    };
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({
        type: "auth",
        version: 1,
        token: credentials.token,
        name,
      }),
    );
    const welcome = await wait((m) => m.type === "welcome");
    return {
      ws,
      welcome,
      wait,
      send: (message: unknown) => ws.send(JSON.stringify(message)),
    };
  }
  const join = async () =>
    (
      await app.inject({
        method: "POST",
        url: "/api/rooms/join",
        payload: { name: "Guest", inviteToken: host.inviteToken },
      })
    ).json<Credentials>();
  return { app, host, connect, join };
}
describe("coordinator over real WebSockets", () => {
  it("reconnects a long-lived room whose retained recording state exceeds the ordinary send budget", async () => {
    const f = await fixture();
    const host = await f.connect(f.host, "Host");
    const recordingId = randomUUID();
    const sources = Array.from({ length: 16 }, () => ({
      trackId: randomUUID(),
      label: "x".repeat(120),
      kind: "video",
      state: "saved",
      savedSeconds: 10,
      capturedSeconds: 10,
      bytes: 1000,
      segments: 1,
      error: "e".repeat(300),
      warning: "w".repeat(300),
    }));
    for (let i = 0; i < 31; i++) {
      const credentials = await f.join();
      const guest = await f.connect(credentials, `Gast ${i}`);
      guest.send({
        type: "record.status",
        status: { recordingId, state: "saved", sources },
      });
      await host.wait(
        (m) =>
          m.type === "room.state" &&
          m.state.peers.some(
            (p) =>
              p.id === credentials.participantId &&
              p.recording?.recordingId === recordingId,
          ),
      );
      guest.ws.close();
      await host.wait(
        (m) =>
          m.type === "room.state" &&
          m.state.peers.some(
            (p) => p.id === credentials.participantId && !p.connected,
          ),
      );
    }
    const replacement = await f.connect(f.host, "Host reconnect");
    expect(
      Buffer.byteLength(JSON.stringify(replacement.welcome)),
    ).toBeGreaterThan(256_000);
    expect(
      replacement.welcome.type === "welcome" && replacement.welcome.state.peers,
    ).toHaveLength(32);
    replacement.send({ type: "clock.probe", t1: 123 });
    expect(
      await replacement.wait((m) => m.type === "clock.reply"),
    ).toMatchObject({ t1: 123 });
  });
  it("issues Node-compatible HMAC tokens and accepts previously issued Node tokens", async () => {
    const f = await fixture();
    const [data, signature] = f.host.token.split(".");
    expect(signature).toBe(
      createHmac("sha256", "a".repeat(64)).update(data).digest("base64url"),
    );
    const claims = JSON.parse(Buffer.from(data, "base64url").toString());
    expect(claims).toMatchObject({
      purpose: "session",
      role: "host",
      roomId: f.host.roomId,
      participantId: f.host.participantId,
    });
    const nodeData = Buffer.from(
      JSON.stringify({ ...claims, roomName: "  Podcast  " }),
    ).toString("base64url");
    const token = `${nodeData}.${createHmac("sha256", "a".repeat(64)).update(nodeData).digest("base64url")}`;
    expect(
      (await f.connect({ ...f.host, token }, "Alter Node-Zugang")).welcome,
    ).toMatchObject({
      participantId: f.host.participantId,
      state: { roomId: f.host.roomId, name: "Podcast" },
    });
  });
  it("reopens existing rooms and invitations after a coordinator restart", async () => {
    const old = await fixture();
    await old.app.close();
    const next = await fixture();
    const host = await next.connect(old.host, "Host nach Neustart");
    expect(host.welcome).toMatchObject({
      state: {
        roomId: old.host.roomId,
        name: "Podcast",
        archiveDestinationId: old.host.participantId,
      },
    });
    const joined = await next.app.inject({
      method: "POST",
      url: "/api/rooms/join",
      payload: { name: "Guest", inviteToken: old.host.inviteToken },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().roomId).toBe(old.host.roomId);
  });
  it("rejects missing or foreign WebSocket origins with the original close code", async () => {
    const f = await fixture();
    for (const origin of [undefined, "https://attacker.invalid"]) {
      const ws = new WebSocket(f.app.address.replace("http", "ws") + "/ws", {
        origin,
      });
      opened.find((o) => o.app === f.app)!.sockets.push(ws);
      const closed = once(ws, "close");
      const [code, reason] = await closed;
      expect(code).toBe(1008);
      expect(reason.toString()).toBe("Origin rejected");
    }
  });
  it("closes unauthenticated sockets after five seconds", async () => {
    const f = await fixture();
    const ws = new WebSocket(f.app.address.replace("http", "ws") + "/ws", {
      origin: "http://localhost:5173",
    });
    opened.find((o) => o.app === f.app)!.sockets.push(ws);
    const [code, reason] = await once(ws, "close");
    expect(code).toBe(1008);
    expect(reason.toString()).toBe("Authentication required");
  });
  it("limits message size and floods while preserving the existing close codes", async () => {
    const f = await fixture();
    const oversized = await f.connect(f.host, "Host");
    const tooLarge = once(oversized.ws, "close");
    // Valid-sized frames isolate the message limit from an early frame-header
    // rejection, where TCP shutdown can hide the close frame on Windows.
    oversized.ws.send("x".repeat(65_536), { fin: false });
    oversized.ws.send("x", { fin: true });
    expect((await tooLarge)[0]).toBe(1009);
    const invalidUtf8 = await f.connect(f.host, "Host");
    const badEncoding = once(invalidUtf8.ws, "close");
    invalidUtf8.ws.send(Buffer.from([0xff]), { binary: false });
    expect((await badEncoding)[0]).toBe(1007);
    const flood = await f.connect(f.host, "Host");
    const closed = once(flood.ws, "close");
    for (let i = 0; i < 301; i++) flood.send({ type: "clock.probe", t1: i });
    const [code, reason] = await closed;
    expect(code).toBe(1008);
    expect(reason.toString()).toBe("Rate limit");
  });
  it("normalizes media, forwards explicit null ICE candidates, and keeps clocks responsive after invalid messages", async () => {
    const f = await fixture();
    const host = await f.connect(f.host, "Host");
    const credentials = await f.join();
    const guest = await f.connect(credentials, "Guest");
    host.send({
      type: "media",
      media: {
        micMuted: true,
        camMuted: false,
        sharing: true,
        ignored: "strip",
      },
    });
    const state = await guest.wait(
      (m) =>
        m.type === "room.state" && m.state.peers.some((p) => p.media.sharing),
    );
    expect(state.type === "room.state" && state.state.peers[0].media).toEqual({
      micMuted: true,
      camMuted: false,
      sharing: true,
      livePaused: false,
    });
    host.send({
      type: "peer.signal",
      to: credentials.participantId,
      candidate: null,
      ignored: true,
    });
    expect(await guest.wait((m) => m.type === "peer.signal")).toMatchObject({
      candidate: null,
    });
    host.send({
      type: "record.ready",
      recordingId: "bad",
      ready: true,
      prepared: true,
    });
    expect(await host.wait((m) => m.type === "error")).toMatchObject({
      code: "invalid_message",
    });
    host.send({ type: "clock.probe", t1: 123.5 });
    const clock = await host.wait((m) => m.type === "clock.reply");
    expect(clock).toMatchObject({ t1: 123.5 });
    if (clock.type !== "clock.reply" || host.welcome.type !== "welcome")
      throw new Error("Wrong message");
    expect(clock.t3).toBeGreaterThanOrEqual(clock.t2);
    expect(clock.epoch).toBe(host.welcome.serverEpoch);
  });
  it("keeps signaling and recording commands responsive when telemetry storage fails", async () => {
    const f = await fixture({ telemetry: true });
    await f.app.failTelemetry();
    const host = await f.connect(f.host, "Host");
    const guestCredentials = await f.join();
    const guest = await f.connect(guestCredentials, "Guest");
    expect(host.welcome).toMatchObject({ telemetry: { enabled: true } });
    host.send({
      type: "peer.signal",
      to: guestCredentials.participantId,
      description: { type: "offer", sdp: "v=0" },
    });
    expect(await guest.wait((m) => m.type === "peer.signal")).toMatchObject({
      description: { type: "offer" },
    });
    host.send({ type: "ready", ready: true, archiveReady: true });
    guest.send({ type: "ready", ready: true });
    await host.wait(
      (m) => m.type === "room.state" && m.state.peers.every((p) => p.ready),
    );
    host.send({ type: "record.prepare", commandId: randomUUID() });
    const prepare = await host.wait((m) => m.type === "record.prepare");
    if (prepare.type !== "record.prepare") throw new Error("Expected prepare");
    host.send({
      type: "record.ready",
      recordingId: prepare.take.id,
      ready: true,
      prepared: true,
    });
    guest.send({
      type: "record.ready",
      recordingId: prepare.take.id,
      ready: true,
      prepared: true,
    });
    expect(await host.wait((m) => m.type === "record.start")).toMatchObject({
      take: { phase: "recording" },
    });
    host.send({
      type: "record.stop",
      recordingId: prepare.take.id,
      commandId: randomUUID(),
    });
    expect(await guest.wait((m) => m.type === "record.stop")).toMatchObject({
      recordingId: prepare.take.id,
    });
  });
  it("makes the host the receiver, lets only the host set the quality and reports a participant's blocking reason", async () => {
    const f = await fixture();
    const host = await f.connect(f.host, "Host");
    const credentials = await f.join();
    const guest = await f.connect(credentials, "Guest");
    expect(guest.welcome).toMatchObject({
      state: {
        name: "Podcast",
        archiveDestinationId: f.host.participantId,
        quality: "1080",
      },
    });
    guest.send({ type: "room.quality", quality: "720" });
    expect(await guest.wait((m) => m.type === "error")).toMatchObject({
      message: "Nur der Host bestimmt die Aufnahmequalität.",
    });
    // The former destination choice no longer exists: the host is the master.
    guest.send({
      type: "archive.destination",
      participantId: credentials.participantId,
    });
    expect(await guest.wait((m) => m.type === "error")).toMatchObject({
      message: "Ungültige Nachricht.",
    });
    host.send({ type: "room.quality", quality: "2160" });
    expect(
      await guest.wait(
        (m) => m.type === "room.state" && m.state.quality === "2160",
      ),
    ).toMatchObject({
      state: { archiveDestinationId: f.host.participantId },
    });
    host.send({ type: "ready", ready: true, archiveReady: true });
    guest.send({
      type: "ready",
      ready: false,
      archiveReady: false,
      reason: "Speicherordner nicht freigegeben",
    });
    await host.wait(
      (m) =>
        m.type === "room.state" &&
        m.state.peers.some(
          (p) => p.readyReason === "Speicherordner nicht freigegeben",
        ),
    );
    host.send({ type: "record.prepare", commandId: randomUUID() });
    expect(await host.wait((m) => m.type === "error")).toMatchObject({
      message: "Guest: Speicherordner nicht freigegeben",
    });
  });
  it("ends a stopping take when an offline participant cannot report back", async () => {
    const f = await fixture(),
      host = await f.connect(f.host, "Host"),
      guestCredentials = await f.join(),
      guest = await f.connect(guestCredentials, "Guest");
    host.send({ type: "ready", ready: true, archiveReady: true });
    guest.send({ type: "ready", ready: true, archiveReady: true });
    await host.wait(
      (m) =>
        m.type === "room.state" &&
        m.state.peers.length === 2 &&
        m.state.peers.every((p) => p.ready),
    );
    host.send({ type: "record.prepare", commandId: randomUUID() });
    const prepare = await host.wait((m) => m.type === "record.prepare");
    if (prepare.type !== "record.prepare") throw new Error("Wrong message");
    const recordingId = prepare.take.id;
    expect(prepare.take.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const peer of [host, guest])
      peer.send({
        type: "record.ready",
        recordingId,
        ready: true,
        prepared: true,
      });
    await host.wait((m) => m.type === "record.start");
    const status = (state: "recording" | "saved") => ({
      type: "record.status",
      status: { recordingId, state, sources: [] },
    });
    guest.send(status("recording"));
    await host.wait(
      (m) =>
        m.type === "room.state" &&
        m.state.peers.some((p) => p.recording?.state === "recording"),
    );
    guest.ws.close();
    await host.wait(
      (m) =>
        m.type === "room.state" &&
        m.state.peers.some(
          (p) => p.id === guestCredentials.participantId && !p.connected,
        ),
    );
    host.send({ type: "record.stop", commandId: randomUUID(), recordingId });
    await host.wait(
      (m) => m.type === "room.state" && m.state.take?.phase === "stopping",
    );
    host.send(status("saved"));
    const done = await host.wait(
      (m) => m.type === "room.state" && m.state.take?.phase === "done",
    );
    // The offline guest stays listed for the session and stops on reconnect.
    expect(
      done.type === "room.state" &&
        done.state.peers.find((p) => p.id === guestCredentials.participantId),
    ).toMatchObject({ connected: false, recording: { state: "recording" } });
  });
  it("withholds TURN URLs and credentials when disabled while preserving STUN", async () => {
    const f = await fixture({
      turnEnabled: false,
      turnUrls: [
        "stun:stun.example.com:3478",
        "turn:relay.example.com:3478",
        "turns:relay.example.com:5349",
      ],
      turnSecret: "test-relay-secret",
    });
    const host = await f.connect(f.host, "Host");
    expect(host.welcome).toMatchObject({
      type: "welcome",
      iceServers: [{ urls: ["stun:stun.example.com:3478"] }],
    });
    if (host.welcome.type !== "welcome") throw new Error("Wrong message");
    expect(host.welcome.iceServers).toHaveLength(1);
    expect(host.welcome.iceServers[0]).not.toHaveProperty("credential");
  });
  it("can re-enable TURN without removing the STUN configuration", async () => {
    const f = await fixture({
      turnEnabled: true,
      turnUrls: ["stun:stun.example.com:3478", "turn:relay.example.com:3478"],
      turnSecret: "test-relay-secret",
    });
    const host = await f.connect(f.host, "Host");
    if (host.welcome.type !== "welcome") throw new Error("Wrong message");
    expect(host.welcome.iceServers).toEqual([
      { urls: ["stun:stun.example.com:3478"] },
      {
        urls: ["turn:relay.example.com:3478"],
        username: expect.stringContaining(`:${f.host.participantId}`),
        credential: expect.any(String),
      },
    ]);
  });
  it("forces relay testing, omits STUN and issues authenticated expiring TURN credentials", async () => {
    const f = await fixture({
      turnEnabled: true,
      iceTransportPolicy: "relay",
      turnUrls: [
        "stun:stun.example.com:3478",
        "turn:relay.example.com:3478?transport=udp",
        "turn:relay.example.com:3478?transport=tcp",
      ],
      turnSecret: "test-relay-secret",
    });
    const host = await f.connect(f.host, "Host");
    if (host.welcome.type !== "welcome") throw new Error("Wrong message");
    expect(host.welcome.iceTransportPolicy).toBe("relay");
    expect(host.welcome.iceServers).toHaveLength(1);
    const relay = host.welcome.iceServers[0];
    expect(relay.urls).toEqual([
      "turn:relay.example.com:3478?transport=udp",
      "turn:relay.example.com:3478?transport=tcp",
    ]);
    const [expires, participant] = relay.username!.split(":");
    expect(participant).toBe(f.host.participantId);
    expect(Number(expires)).toBeGreaterThan(Date.now() / 1000);
    expect(Number(expires)).toBeLessThanOrEqual(Date.now() / 1000 + 86400);
    expect(relay.credential).toBe(
      createHmac("sha1", "test-relay-secret")
        .update(relay.username!)
        .digest("base64"),
    );
  });
  it.each([
    {
      turnEnabled: false,
      turnUrls: ["turn:relay.example.test:3478"],
      turnSecret: "secret",
    },
    { turnEnabled: true, turnUrls: ["turn:relay.example.test:3478"] },
    {
      turnEnabled: true,
      turnUrls: ["stun:stun.example.test:3478"],
      turnSecret: "secret",
    },
  ])(
    "rejects relay-only startup without usable TURN configuration: %j",
    async (config) => {
      await expect(
        fixture({ ...config, iceTransportPolicy: "relay" }),
      ).rejects.toThrow("erfordert einen aktiven TURN-Dienst");
    },
  );
  it("relays SDP and ICE and retains a participant after an old socket is replaced", async () => {
    const f = await fixture();
    const host = await f.connect(f.host, "Host");
    const credentials = await f.join();
    const guest = await f.connect(credentials, "Guest");
    const candidate = {
      candidate: "candidate:1 1 udp 2113937151 example.local 12345 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "test",
    };
    host.send({
      type: "peer.signal",
      to: credentials.participantId,
      candidate,
    });
    expect(await guest.wait((m) => m.type === "peer.signal")).toMatchObject({
      type: "peer.signal",
      from: f.host.participantId,
      candidate,
    });
    guest.send({
      type: "peer.signal",
      to: f.host.participantId,
      description: { type: "offer", sdp: "test-sdp" },
    });
    expect(await host.wait((m) => m.type === "peer.signal")).toMatchObject({
      from: credentials.participantId,
      description: { type: "offer", sdp: "test-sdp" },
    });
    guest.send({
      type: "peer.signal",
      to: f.host.participantId,
      restart: true,
    });
    expect(await host.wait((m) => m.type === "peer.signal")).toMatchObject({
      from: credentials.participantId,
      restart: true,
    });
    const replacement = await f.connect(credentials, "Guest reconnected");
    if (
      guest.welcome.type !== "welcome" ||
      replacement.welcome.type !== "welcome"
    )
      throw new Error("Wrong message");
    const originalConnection = guest.welcome.state.peers.find(
      (p) => p.id === credentials.participantId,
    )?.connectionId;
    const nextConnection = replacement.welcome.state.peers.find(
      (p) => p.id === credentials.participantId,
    )?.connectionId;
    expect(originalConnection).toBeTruthy();
    expect(nextConnection).toBeTruthy();
    expect(nextConnection).not.toBe(originalConnection);
    replacement.send({ type: "ready", ready: true });
    const state = await host.wait(
      (m) =>
        m.type === "room.state" &&
        m.state.peers.some(
          (p) => p.id === credentials.participantId && p.ready,
        ),
    );
    expect(
      state.type === "room.state" &&
        state.state.peers.filter((p) => p.id === credentials.participantId),
    ).toHaveLength(1);
  });
  it("requires every participant to approve before one deduplicated start and rejects guest control", async () => {
    const f = await fixture(),
      host = await f.connect(f.host, "Host"),
      guestCredentials = await f.join(),
      guest = await f.connect(guestCredentials, "Guest");
    guest.send({ type: "record.prepare", commandId: randomUUID() });
    expect((await guest.wait((m) => m.type === "error")).type).toBe("error");
    host.send({ type: "ready", ready: true });
    guest.send({ type: "ready", ready: true });
    await host.wait(
      (m) =>
        m.type === "room.state" &&
        m.state.peers.length === 2 &&
        m.state.peers.every((p) => p.ready),
    );
    const commandId = randomUUID();
    host.send({ type: "record.prepare", commandId });
    const prepare = await host.wait((m) => m.type === "record.prepare");
    if (prepare.type !== "record.prepare") throw new Error("Wrong message");
    host.send({
      type: "record.ready",
      recordingId: prepare.take.id,
      ready: true,
      prepared: true,
    });
    guest.send({
      type: "record.ready",
      recordingId: prepare.take.id,
      ready: true,
      prepared: true,
    });
    const start = await guest.wait((m) => m.type === "record.start");
    expect(
      start.type === "record.start" && start.take.participants.length,
    ).toBe(2);
    host.send({ type: "record.prepare", commandId });
    host.send({
      type: "record.stop",
      commandId: randomUUID(),
      recordingId: prepare.take.id,
    });
    expect((await guest.wait((m) => m.type === "record.stop")).type).toBe(
      "record.stop",
    );
  });
  it("enforces capacity and isolates signaling across rooms", async () => {
    const f = await fixture(),
      host = await f.connect(f.host, "Host");
    for (let i = 0; i < 3; i++) await f.connect(await f.join(), `Guest ${i}`);
    const full = await f.app.inject({
      method: "POST",
      url: "/api/rooms/join",
      payload: { name: "Fifth", inviteToken: f.host.inviteToken },
    });
    expect(full.statusCode).toBe(409);
    host.send({
      type: "peer.signal",
      to: randomUUID(),
      description: { type: "offer", sdp: "not delivered" },
    });
    const origin = await f.app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { origin: "https://attacker.invalid" },
      payload: { name: "No" },
    });
    expect(origin.statusCode).toBe(403);
  });
});
