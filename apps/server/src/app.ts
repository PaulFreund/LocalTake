import Fastify, { LogController } from "fastify";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { WebSocket } from "ws";
import { z } from "zod";
import {
  clientMessageSchema,
  nameSchema,
  type ClientMessage,
  type Peer,
  type Quality,
  type RoomState,
  type RoomTake,
  type ServerMessage,
  type IceServer,
  type IceTransportPolicy,
} from "../../../packages/protocol/src/index.js";
import { signToken, verifyToken } from "./auth.js";
import {
  TELEMETRY_BODY_BYTES,
  TELEMETRY_MAX_EVENTS,
  TELEMETRY_MIN_INTERVAL_MS,
} from "../../../packages/protocol/src/telemetry.js";
import type { TelemetrySink } from "./telemetry-store.js";

export type Config = {
  secret: string;
  origin: string;
  maxParticipants?: number;
  turnEnabled?: boolean;
  turnUrls?: string[];
  turnSecret?: string;
  iceTransportPolicy?: IceTransportPolicy;
  clientDir?: string;
  logger?: boolean;
  telemetry?: TelemetrySink;
};
type Member = {
  peer: Peer;
  socket: WebSocket | null;
  loggedStatus?: string;
  lastStatusLog?: number;
};
type Room = {
  id: string;
  name: string;
  members: Map<string, Member>;
  take: RoomTake | null;
  touched: number;
  commands: Set<string>;
  archiveDestinationId: string | null;
  quality: Quality;
  timer?: ReturnType<typeof setTimeout>;
  loggedTake?: string;
};
const send = (ws: WebSocket, message: ServerMessage) => {
  if (ws.readyState === 1 && ws.bufferedAmount < 256_000) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
};

export async function createApp(config: Config) {
  const iceTransportPolicy = config.iceTransportPolicy ?? "all";
  if (
    iceTransportPolicy === "relay" &&
    (config.turnEnabled === false ||
      !config.turnSecret ||
      !config.turnUrls?.some((url) => /^turns?:/.test(url)))
  )
    throw new Error("ICE-Relay-Testmodus erfordert einen aktiven TURN-Dienst.");
  const app = Fastify({
    logger: config.logger ?? false,
    bodyLimit: 16_384,
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 65_536 } });
  const rooms = new Map<string, Room>();
  const epoch = randomUUID();
  const telemetry = { enabled: config.telemetry?.status().enabled ?? false };
  // Observability failures must never propagate into a session command.
  const log = (
    event: string,
    detail?: unknown,
    room?: Room,
    member?: Member,
  ) => {
    try {
      config.telemetry?.enqueue({
        version: 1,
        at: new Date().toISOString(),
        source: "server",
        serverEpoch: epoch,
        event,
        roomId: room?.id,
        participantId: member?.peer.id,
        connectionId: member?.peer.connectionId,
        recordingId: room?.take?.id,
        detail,
      });
    } catch {
      /* optional telemetry */
    }
  };
  const uploads = new Map<
    string,
    { lastAt: number; pages: Map<string, number> }
  >();
  const batchSchema = z
    .object({
      version: z.literal(1),
      pageId: z.string().uuid(),
      sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      dropped: z.number().int().nonnegative(),
      events: z
        .array(
          z
            .object({
              at: z.string().datetime(),
              elapsedMs: z.number().finite().nonnegative(),
              scope: z.string().max(40),
              event: z.string().max(80),
              detail: z.unknown().optional(),
            })
            .strict(),
        )
        .max(TELEMETRY_MAX_EVENTS),
      sample: z.unknown().optional(),
    })
    .strict();
  const maxParticipants = Math.min(4, Math.max(2, config.maxParticipants ?? 4));
  const expires = () => Math.floor(Date.now() / 1000) + 365 * 86400;
  function getRoom(id: string, name = "Raum"): Room {
    let room = rooms.get(id);
    if (!room) {
      if (rooms.size >= 256)
        throw new Error(
          "Der Dienst ist ausgelastet. Bitte später erneut versuchen.",
        );
      room = {
        id,
        name,
        members: new Map(),
        take: null,
        touched: Date.now(),
        commands: new Set(),
        archiveDestinationId: null,
        quality: "1080",
      };
      rooms.set(id, room);
    }
    room.touched = Date.now();
    return room;
  }
  const state = (room: Room): RoomState => ({
    roomId: room.id,
    name: room.name,
    peers: [...room.members.values()].map((m) => m.peer),
    take: room.take,
    archiveDestinationId: room.archiveDestinationId,
    quality: room.quality,
  });
  function broadcast(room: Room, message: ServerMessage) {
    for (const m of room.members.values())
      if (m.socket) send(m.socket, message);
  }
  function publish(room: Room) {
    const key = `${room.take?.id}/${room.take?.phase}`;
    if (key !== room.loggedTake) {
      room.loggedTake = key;
      if (room.take) log("record.phase", { take: room.take }, room);
    }
    broadcast(room, { type: "room.state", state: state(room) });
  }
  // A stopping take ends once every reachable participant has reported its final
  // state. An offline participant cannot be waited for: it stops on reconnect.
  function settle(room: Room) {
    const take = room.take;
    if (take?.phase !== "stopping") return;
    if (
      take.participants.every((id) => {
        const member = room.members.get(id);
        const status = member?.peer.recording;
        return (
          !member?.socket ||
          (status?.recordingId === take.id &&
            ["saved", "partial", "failed"].includes(status.state))
        );
      })
    )
      take.phase = "done";
  }
  function remember(room: Room, id: string): boolean {
    if (room.commands.has(id)) return false;
    room.commands.add(id);
    if (room.commands.size > 256)
      room.commands.delete(room.commands.values().next().value!);
    return true;
  }
  function iceServers(participantId: string): IceServer[] {
    const urls = config.turnUrls ?? [];
    const stun = urls.filter(
      (url) => url.startsWith("stun:") || url.startsWith("stuns:"),
    );
    const turn = urls.filter(
      (url) => url.startsWith("turn:") || url.startsWith("turns:"),
    );
    const result: IceServer[] =
      iceTransportPolicy === "all" && stun.length ? [{ urls: stun }] : [];
    if (config.turnEnabled !== false && turn.length && config.turnSecret) {
      const username = `${Math.floor(Date.now() / 1000) + 86400}:${participantId}`;
      result.push({
        urls: turn,
        username,
        credential: createHmac("sha1", config.turnSecret)
          .update(username)
          .digest("base64"),
      });
    }
    return result;
  }
  app.addHook("onRequest", async (request, reply) => {
    if (
      request.method === "POST" &&
      request.headers.origin &&
      request.headers.origin !== config.origin
    )
      return reply.code(403).send({ error: "Origin nicht erlaubt." });
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Permissions-Policy",
      "camera=(self), microphone=(self), display-capture=(self)",
    );
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
    );
  });
  app.get("/healthz", async () => ({ ok: true, version: "0.1.0" }));
  app.post(
    "/api/rooms",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = z
        .object({ name: nameSchema, roomName: nameSchema.optional() })
        .safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "Bitte einen Namen angeben." });
      const roomId = randomUUID(),
        participantId = randomUUID();
      const roomName = body.data.roomName ?? body.data.name;
      getRoom(roomId, roomName);
      return {
        roomId,
        participantId,
        telemetry,
        token: signToken(
          {
            purpose: "session",
            roomId,
            roomName,
            participantId,
            role: "host",
            exp: expires(),
          },
          config.secret,
        ),
        inviteToken: signToken(
          {
            purpose: "invite",
            roomId,
            roomName,
            role: "guest",
            exp: expires(),
          },
          config.secret,
        ),
      };
    },
  );
  app.post("/api/rooms/join", async (request, reply) => {
    const body = z
      .object({ name: nameSchema, inviteToken: z.string().max(4096) })
      .safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "Name oder Einladung fehlt." });
    try {
      const claims = verifyToken(
        body.data.inviteToken,
        config.secret,
        "invite",
      );
      const room = getRoom(claims.roomId, claims.roomName);
      if (
        [...room.members.values()].filter((m) => m.socket).length >=
        maxParticipants
      )
        return reply
          .code(409)
          .send({ error: "Der Raum ist voll (maximal vier Teilnehmer)." });
      const participantId = randomUUID();
      return {
        roomId: room.id,
        participantId,
        inviteToken: body.data.inviteToken,
        telemetry,
        token: signToken(
          {
            purpose: "session",
            roomId: room.id,
            roomName: room.name,
            participantId,
            role: "guest",
            exp: expires(),
          },
          config.secret,
        ),
      };
    } catch {
      return reply
        .code(401)
        .send({ error: "Einladung ungültig oder abgelaufen." });
    }
  });
  app.post(
    "/api/telemetry",
    {
      bodyLimit: TELEMETRY_BODY_BYTES,
      // Fastify's parser closes the connection on a known oversized body.
      // Reject its declared length without closing Caddy's upstream mid-write.
      preParsing: async (request, reply, payload) => {
        if (Number(request.headers["content-length"]) > TELEMETRY_BODY_BYTES) {
          reply.code(413).send({ error: "Diagnose ist zu groß." });
          return;
        }
        return payload;
      },
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!config.telemetry) return reply.code(204).send();
      let claims;
      try {
        const auth = request.headers.authorization;
        if (!auth?.startsWith("Bearer ")) throw new Error("Missing token");
        claims = verifyToken(auth.slice(7), config.secret, "session");
      } catch {
        return reply.code(401).send({ error: "Anmeldung erforderlich." });
      }
      const body = batchSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "Ungültige Diagnose." });
      const now = Date.now();
      const key = `${claims.roomId}/${claims.participantId}`;
      let previous = uploads.get(key);
      const sequence = previous?.pages.get(body.data.pageId);
      if (sequence !== undefined && sequence >= body.data.sequence)
        return reply.code(202).send({ accepted: true, duplicate: true });
      if (previous && now - previous.lastAt < TELEMETRY_MIN_INTERVAL_MS)
        return reply
          .header("Retry-After", "5")
          .code(429)
          .send({ error: "Diagnose wird zu häufig gesendet." });
      if (!previous) previous = { lastAt: 0, pages: new Map() };
      previous.lastAt = now;
      uploads.delete(key);
      uploads.set(key, previous);
      if (uploads.size > 2048) uploads.delete(uploads.keys().next().value!);
      let accepted = false;
      try {
        accepted = config.telemetry.enqueue({
          version: 1,
          at: new Date(now).toISOString(),
          source: "client",
          serverEpoch: epoch,
          roomId: claims.roomId,
          participantId: claims.participantId,
          batch: body.data,
        });
      } catch {
        /* telemetry is optional */
      }
      if (accepted) {
        previous.pages.delete(body.data.pageId);
        previous.pages.set(body.data.pageId, body.data.sequence);
        if (previous.pages.size > 4)
          previous.pages.delete(previous.pages.keys().next().value!);
      }
      return reply.code(202).send({ accepted });
    },
  );
  app.get("/ws", { websocket: true }, (socket, request) => {
    if (request.headers.origin !== config.origin) {
      socket.close(1008, "Origin rejected");
      return;
    }
    let room: Room | undefined, member: Member | undefined;
    let count = 0,
      windowStart = Date.now();
    let lastFailureLog = -Infinity;
    const failureLog = (event: string, detail?: unknown) => {
      if (Date.now() - lastFailureLog < 5000) return;
      lastFailureLog = Date.now();
      log(event, detail, room, member);
    };
    const authTimer = setTimeout(
      () => socket.close(1008, "Authentication required"),
      5000,
    );
    let alive = true;
    socket.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 20_000);
    socket.on("error", (error) => {
      failureLog("socket.error", { message: error.message });
    });
    socket.on("message", (raw) => {
      const now = performance.now();
      try {
        if (Date.now() - windowStart > 10_000) {
          count = 0;
          windowStart = Date.now();
        }
        if (++count > 300) {
          failureLog("socket.rate_limit");
          socket.close(1008, "Rate limit");
          return;
        }
        const parsed = clientMessageSchema.safeParse(
          JSON.parse(raw.toString()),
        );
        if (!parsed.success) {
          failureLog("message.invalid");
          send(socket, {
            type: "error",
            code: "invalid_message",
            message: "Ungültige Nachricht.",
          });
          return;
        }
        const message = parsed.data;
        if (!member || !room) {
          if (message.type !== "auth")
            throw new Error("Bitte zuerst anmelden.");
          const claims = verifyToken(message.token, config.secret, "session");
          room = getRoom(claims.roomId, claims.roomName);
          const previous = room.members.get(claims.participantId!);
          if (
            !previous?.socket &&
            [...room.members.values()].filter((m) => m.socket).length >=
              maxParticipants
          )
            throw new Error("Der Raum ist voll.");
          if (!previous && room.members.size >= 32)
            throw new Error(
              "Zu viele Raumidentitäten. Bitte neuen Raum öffnen.",
            );
          const peer: Peer = previous?.peer ?? {
            id: claims.participantId!,
            name: message.name,
            role: claims.role,
            connected: true,
            media: {
              micMuted: false,
              camMuted: false,
              sharing: false,
              livePaused: false,
            },
            ready: false,
            recording: null,
          };
          peer.name = message.name;
          peer.connected = true;
          peer.connectionId = randomUUID();
          peer.role = claims.role;
          peer.ready = false;
          peer.archiveReady = false;
          peer.readyReason = "Quellen und Speicher werden geprüft.";
          if (peer.role === "host") room.archiveDestinationId = peer.id;
          member = { peer, socket };
          room.members.set(peer.id, member);
          previous?.socket?.close(4001, "Replaced by reconnect");
          clearTimeout(authTimer);
          send(socket, {
            type: "welcome",
            participantId: peer.id,
            iceServers: iceServers(peer.id),
            iceTransportPolicy,
            serverEpoch: epoch,
            telemetry,
            state: state(room),
          });
          log(
            previous ? "participant.reconnected" : "participant.connected",
            { role: peer.role },
            room,
            member,
          );
          publish(room);
          return;
        }
        room.touched = Date.now();
        handle(room, member, message, now);
      } catch (error) {
        failureLog("message.rejected", {
          message: error instanceof Error ? error.message : String(error),
        });
        send(socket, {
          type: "error",
          code: "rejected",
          message:
            error instanceof Error
              ? error.message.slice(0, 200)
              : "Nachricht abgelehnt.",
        });
        if (!member) socket.close(1008, "Authentication rejected");
      }
    });
    socket.on("close", (code, reason) => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      log(
        "participant.closed",
        { code, reason: reason.toString().slice(0, 200) },
        room,
        member,
      );
      if (room && member && room.members.get(member.peer.id) === member) {
        member.socket = null;
        member.peer.connected = false;
        member.peer.ready = false;
        member.peer.archiveReady = false;
        if (
          !room.take?.participants.includes(member.peer.id) &&
          !member.peer.recording
        )
          room.members.delete(member.peer.id);
        settle(room);
        publish(room);
      }
    });
  });
  function handle(
    room: Room,
    member: Member,
    message: ClientMessage,
    t2: number,
  ) {
    const ws = member.socket!;
    switch (message.type) {
      case "auth":
        return;
      case "clock.probe":
        send(ws, {
          type: "clock.reply",
          t1: message.t1,
          t2,
          t3: performance.now(),
          epoch,
        });
        return;
      case "peer.signal": {
        const target = room.members.get(message.to)?.socket;
        const forwarded =
          target &&
          message.to !== member.peer.id &&
          send(target, {
            type: "peer.signal",
            from: member.peer.id,
            connectionId: member.peer.connectionId,
            linkId: message.linkId,
            restart: message.restart,
            description: message.description,
            candidate: message.candidate,
          });
        if (message.description || message.restart)
          log(
            "signal.forwarded",
            {
              to: message.to,
              linkId: message.linkId,
              description: message.description?.type,
              restart: message.restart,
              forwarded: Boolean(forwarded),
              targetState: target?.readyState,
              bufferedAmount: target?.bufferedAmount,
            },
            room,
            member,
          );
        return;
      }
      case "media":
        member.peer.media = message.media;
        publish(room);
        return;
      case "ready":
        member.peer.ready = message.ready;
        member.peer.readyReason = message.reason;
        member.peer.archiveReady = message.archiveReady ?? message.ready;
        publish(room);
        return;
      case "room.quality": {
        if (member.peer.role !== "host")
          throw new Error("Nur der Host bestimmt die Aufnahmequalität.");
        if (room.take && ["preparing", "recording"].includes(room.take.phase))
          throw new Error("Qualität erst nach Ende der Aufnahme ändern.");
        room.quality = message.quality;
        publish(room);
        return;
      }
      case "archive.status":
        member.peer.upload = message.status;
        publish(room);
        return;
      case "chat":
        broadcast(room, {
          type: "chat",
          from: member.peer.id,
          name: member.peer.name,
          text: message.text,
          id: randomUUID(),
        });
        return;
      case "record.prepare": {
        if (member.peer.role !== "host")
          throw new Error(
            "Nur der Host kann eine gemeinsame Aufnahme starten.",
          );
        if (!remember(room, message.commandId)) return;
        if (room.take && !["done", "cancelled"].includes(room.take.phase))
          throw new Error("Eine Aufnahme ist bereits aktiv.");
        const peers = [...room.members.values()].filter((m) => m.socket);
        if (!peers.every((m) => m.peer.ready))
          throw new Error(
            peers
              .filter((m) => !m.peer.ready)
              .map(
                (m) =>
                  `${m.peer.name}: ${m.peer.readyReason || "Quellen und Speicher noch nicht bereit"}`,
              )
              .join(" · "),
          );
        const destination = room.archiveDestinationId
          ? room.members.get(room.archiveDestinationId)
          : undefined;
        if (!destination?.socket || !destination.peer.archiveReady)
          throw new Error(
            `Ziel-PC ${destination?.peer.name || "für Originale"}: Empfangsordner freigeben und Schreibzugriff prüfen.`,
          );
        room.take = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          commandId: message.commandId,
          phase: "preparing",
          participants: peers.map((m) => m.peer.id),
          ready: [],
        };
        room.timer = setTimeout(() => {
          if (room.take?.phase === "preparing") {
            room.take.phase = "cancelled";
            room.take.reason =
              "Nicht alle Teilnehmer haben rechtzeitig bestätigt.";
            publish(room);
          }
        }, 10_000);
        broadcast(room, { type: "record.prepare", take: room.take });
        publish(room);
        return;
      }
      case "record.ready": {
        const take = room.take;
        if (
          !take ||
          take.id !== message.recordingId ||
          take.phase !== "preparing" ||
          !take.participants.includes(member.peer.id)
        )
          return;
        if (!message.ready) {
          take.phase = "cancelled";
          take.reason = `${member.peer.name}: ${message.reason || "Aufnahme noch nicht bereit."}`;
          clearTimeout(room.timer);
          publish(room);
          return;
        }
        if (!take.ready.includes(member.peer.id))
          take.ready.push(member.peer.id);
        if (take.participants.every((id) => take.ready.includes(id))) {
          clearTimeout(room.timer);
          take.phase = "recording";
          take.startAt = performance.now() + 1000;
          broadcast(room, { type: "record.start", take });
        }
        publish(room);
        return;
      }
      case "record.stop": {
        if (member.peer.role !== "host")
          throw new Error("Nur der Host kann alle Aufnahmen stoppen.");
        if (!remember(room, message.commandId)) return;
        if (!room.take || room.take.id !== message.recordingId) return;
        clearTimeout(room.timer);
        if (room.take.phase === "preparing") room.take.phase = "cancelled";
        else if (room.take.phase === "recording") room.take.phase = "stopping";
        settle(room);
        broadcast(room, {
          type: "record.stop",
          recordingId: message.recordingId,
          commandId: message.commandId,
        });
        publish(room);
        return;
      }
      case "record.status": {
        const key = `${message.status.recordingId}/${message.status.state}/${message.status.sources.map((s) => `${s.state}/${s.error}/${s.warning}`).join(";")}`;
        if (
          key !== member.loggedStatus ||
          Date.now() - (member.lastStatusLog ?? 0) >= 30_000
        ) {
          log("record.status", message.status, room, member);
          member.loggedStatus = key;
          member.lastStatusLog = Date.now();
        }
        member.peer.recording = message.status;
        if (
          room.take?.phase === "recording" &&
          room.take.id === message.status.recordingId &&
          room.take.participants.every((id) => {
            const status = room.members.get(id)?.peer.recording;
            return (
              status?.recordingId === room.take!.id &&
              ["saved", "partial", "failed"].includes(status.state)
            );
          })
        )
          room.take.phase = "done";
        settle(room);
        publish(room);
        return;
      }
    }
  }
  const cleanup = setInterval(() => {
    log("telemetry.status", config.telemetry?.status());
    for (const [key, value] of uploads)
      if (Date.now() - value.lastAt > 3600_000) uploads.delete(key);
    for (const [id, room] of rooms)
      if (
        Date.now() - room.touched > 3600_000 &&
        [...room.members.values()].every((m) => !m.socket)
      ) {
        clearTimeout(room.timer);
        rooms.delete(id);
      }
  }, 60_000);
  cleanup.unref();
  app.addHook("onClose", async () => {
    clearInterval(cleanup);
    for (const room of rooms.values()) {
      clearTimeout(room.timer);
      for (const member of room.members.values()) member.socket?.terminate();
    }
    await config.telemetry?.close().catch(() => undefined);
  });
  if (config.clientDir && existsSync(config.clientDir)) {
    await app.register(staticFiles, {
      root: config.clientDir,
      index: ["index.html"],
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        !request.url.includes(".")
      )
        return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Nicht gefunden." });
    });
  }
  app.setErrorHandler((error, request, reply) => {
    if ((error as { statusCode?: number }).statusCode === undefined)
      log("http.error", {
        requestId: request.id,
        method: request.method,
        path: request.url.split("?")[0],
        message: (error as Error).message,
      });
    reply
      .code((error as { statusCode?: number }).statusCode ?? 500)
      .send({ error: "Anfrage konnte nicht verarbeitet werden." });
  });
  return app;
}
