import type { Credentials } from "../../../../packages/protocol/src/index.js";

export type SavedRoom = { credentials: Credentials; name: string };
const key = "localtake-rooms";
const isSavedRoom = (value: unknown): value is SavedRoom => {
  const room = value as SavedRoom | null;
  return Boolean(
    room &&
    typeof room.name === "string" &&
    typeof room.credentials?.roomId === "string" &&
    room.credentials.roomId &&
    typeof room.credentials.participantId === "string" &&
    room.credentials.participantId &&
    typeof room.credentials.token === "string" &&
    room.credentials.token,
  );
};
export function savedRooms(
  storage: Pick<Storage, "getItem"> = localStorage,
): Record<string, SavedRoom> {
  let rooms: Record<string, SavedRoom> = {};
  try {
    const value = JSON.parse(storage.getItem(key) || "{}");
    if (value && typeof value === "object" && !Array.isArray(value))
      rooms = Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, SavedRoom] =>
            isSavedRoom(entry[1]) && entry[1].credentials.roomId === entry[0],
        ),
      );
  } catch {
    /* optional preferences */
  }
  try {
    const legacy = JSON.parse(storage.getItem("localtake-session") || "null");
    if (isSavedRoom(legacy) && !rooms[legacy.credentials.roomId])
      rooms[legacy.credentials.roomId] = legacy;
  } catch {
    /* preserve the current room map if the legacy entry is invalid */
  }
  return rooms;
}
export function rememberRoom(
  room: SavedRoom,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
) {
  storage.setItem(
    key,
    JSON.stringify({ ...savedRooms(storage), [room.credentials.roomId]: room }),
  );
}
export function roomFromLink(hash: string) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const invite = params.get("invite") || "";
  let roomId = params.get("room") || "";
  if (invite) {
    try {
      const value = JSON.parse(
        atob(invite.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")),
      );
      const invitedRoom = typeof value.roomId === "string" ? value.roomId : "";
      if (roomId && invitedRoom && roomId !== invitedRoom)
        return {
          roomId,
          invite,
          error:
            "Raumlink und Einladung gehören zu unterschiedlichen Räumen. Bitte den vollständigen Einladungslink öffnen.",
        };
      roomId ||= invitedRoom;
    } catch {
      /* authentication still happens on the server */
    }
  }
  return { roomId, invite };
}
export function sessionLink(
  origin: string,
  pathname: string,
  credentials: Credentials,
) {
  const url = new URL(pathname, origin);
  const params = new URLSearchParams({ room: credentials.roomId });
  if (credentials.inviteToken) params.set("invite", credentials.inviteToken);
  url.hash = params.toString();
  return url.toString();
}
