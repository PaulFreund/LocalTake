import { expect, it } from "vitest";
import {
  rememberRoom,
  roomFromLink,
  savedRooms,
  sessionLink,
} from "../apps/client/src/room/session-link.js";

it("reopens the right room after other rooms without putting host credentials in the URL", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const room = {
    name: "Host",
    credentials: {
      roomId: crypto.randomUUID(),
      participantId: crypto.randomUUID(),
      token: "private-host-token",
      inviteToken: "public-invitation",
    },
  };
  rememberRoom(room, storage);
  rememberRoom(
    {
      ...room,
      credentials: { ...room.credentials, roomId: crypto.randomUUID() },
    },
    storage,
  );
  const link = sessionLink("https://record.example", "/", room.credentials);
  expect(link).not.toContain("private-host-token");
  expect(link).not.toContain(room.credentials.participantId);
  expect(roomFromLink(new URL(link).hash)).toEqual({
    roomId: room.credentials.roomId,
    invite: "public-invitation",
  });
  expect(savedRooms(storage)[room.credentials.roomId]).toEqual(room);
});
it("recognizes older invitation links for returning participants", () => {
  const roomId = crypto.randomUUID();
  const token =
    Buffer.from(JSON.stringify({ roomId })).toString("base64url") +
    ".signature";
  expect(roomFromLink(`#invite=${token}`).roomId).toBe(roomId);
  expect(roomFromLink("#invite=broken").roomId).toBe("");
});

it("keeps the existing participant identity when reopening a link after an upgrade", () => {
  const room = {
    name: "Guest",
    credentials: {
      roomId: crypto.randomUUID(),
      participantId: crypto.randomUUID(),
      token: "old-private-token",
    },
  };
  const values = new Map([["localtake-session", JSON.stringify(room)]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null };
  expect(savedRooms(storage)[room.credentials.roomId]).toEqual(room);
  const updated = {
    ...room,
    credentials: { ...room.credentials, token: "current-token" },
  };
  values.set(
    "localtake-rooms",
    JSON.stringify({ [room.credentials.roomId]: updated }),
  );
  expect(savedRooms(storage)[room.credentials.roomId]).toEqual(updated);
});

it("rejects a link whose explicit room and invitation identify different rooms", () => {
  const roomId = crypto.randomUUID();
  const invite =
    Buffer.from(JSON.stringify({ roomId: crypto.randomUUID() })).toString(
      "base64url",
    ) + ".signature";
  expect(roomFromLink(`#room=${roomId}&invite=${invite}`).error).toContain(
    "unterschiedlichen Räumen",
  );
});

it("never reuses credentials saved under another room's key", () => {
  const oldId = crypto.randomUUID(),
    newId = crypto.randomUUID();
  const old = {
    name: "Guest",
    credentials: {
      roomId: oldId,
      participantId: crypto.randomUUID(),
      token: "old-private-token",
    },
  };
  const values = new Map([
    ["localtake-session", JSON.stringify(old)],
    ["localtake-rooms", JSON.stringify({ [newId]: old, broken: null })],
  ]);
  const rooms = savedRooms({ getItem: (key) => values.get(key) ?? null });
  expect(rooms[newId]).toBeUndefined();
  expect(rooms.broken).toBeUndefined();
  expect(rooms[oldId]).toEqual(old);
});
