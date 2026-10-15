import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoomClient } from "../apps/client/src/room/client.js";
import { savedRooms } from "../apps/client/src/room/session-link.js";
import type { Credentials } from "../packages/protocol/src/index.js";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (message: { data: string }) => void;
  onerror?: () => void;
  onclose?: (event: {
    code: number;
    reason: string;
    wasClean: boolean;
  }) => void;
  sent: unknown[] = [];
  constructor() {
    Socket.instances.push(this);
  }
  send(message: string) {
    this.sent.push(JSON.parse(message));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

let room: RoomClient;
const credentials = (): Credentials => ({
  roomId: crypto.randomUUID(),
  participantId: crypto.randomUUID(),
  token: crypto.randomUUID(),
});
const welcome = (value: Credentials) => ({
  type: "welcome",
  participantId: value.participantId,
  state: { roomId: value.roomId, peers: [], take: null },
  iceServers: [],
});
const response = (value: Credentials) =>
  ({ ok: true, status: 200, json: async () => value }) as Response;

beforeEach(() => {
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("location", {
    href: "https://record.example.test/",
    protocol: "https:",
  });
  vi.stubGlobal("WebSocket", Socket);
  Socket.instances = [];
  room = new RoomClient();
});
afterEach(() => {
  room.leave();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("disconnects the old room and remembers each identity under its own room", () => {
  const old = credentials(),
    next = credentials();
  room.join(old, "Guest");
  const oldSocket = Socket.instances[0];
  oldSocket.open();
  oldSocket.message(welcome(old));
  room.join(next, "Guest");
  const nextSocket = Socket.instances[1];
  nextSocket.open();
  nextSocket.message(welcome(next));
  expect(oldSocket.readyState).toBe(3);
  expect(room.state?.roomId).toBe(next.roomId);
  expect(savedRooms()[old.roomId].credentials).toEqual(old);
  expect(savedRooms()[next.roomId].credentials).toEqual(next);
});

it("ignores late events from the previous room after a link switch", () => {
  const old = credentials(),
    next = credentials();
  room.join(old, "Guest");
  const oldSocket = Socket.instances[0];
  room.join(next, "Guest");
  const nextSocket = Socket.instances[1];
  nextSocket.open();
  nextSocket.message(welcome(next));
  const messages = vi.fn();
  room.addEventListener("message", messages);
  const sent = nextSocket.sent.length;
  oldSocket.onopen?.();
  oldSocket.message(welcome(old));
  oldSocket.onclose?.({
    code: 1008,
    reason: "Old room rejected",
    wasClean: true,
  });
  expect(nextSocket.sent).toHaveLength(sent);
  expect(messages).not.toHaveBeenCalled();
  expect(room.credentials).toEqual(next);
  expect(room.state?.roomId).toBe(next.roomId);
  expect(room.connected).toBe(true);
});

it("does not let a slower previous invitation replace the newer room", async () => {
  const old = credentials(),
    next = credentials();
  let finishOld!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce(response(next)),
  );
  const pending = room.accept("old-invitation", "Guest", old.roomId);
  const cancelled = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await room.accept("new-invitation", "Guest", next.roomId);
  finishOld(response(old));
  await cancelled;
  expect(room.credentials).toEqual(next);
  expect(Socket.instances).toHaveLength(1);
});

it("does not join an invitation that finishes after leaving its page", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const pending = room.accept("invitation", "Guest");
  const cancelled = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  room.leave();
  finish(response(credentials()));
  await cancelled;
  expect(room.credentials).toBeNull();
  expect(Socket.instances).toHaveLength(0);
});

it("keeps a response for a different room out of the linked room", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(credentials())));
  await expect(
    room.accept("invitation", "Guest", crypto.randomUUID()),
  ).rejects.toThrow("nicht zum Raum");
  expect(room.credentials).toBeNull();
  expect(Socket.instances).toHaveLength(0);
});

it("discards a failed old request instead of reporting it for the new room", async () => {
  const next = credentials();
  let fail!: (reason: Error) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValueOnce(response(next)),
  );
  const pending = room.accept("old-invitation", "Guest");
  const cancelled = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await room.accept("new-invitation", "Guest", next.roomId);
  fail(new Error("Old network failed"));
  await cancelled;
  expect(room.credentials).toEqual(next);
});
