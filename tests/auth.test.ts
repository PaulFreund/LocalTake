import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { signToken, verifyToken } from "../apps/server/src/auth.js";
describe("room capabilities", () => {
  const secret = "test-secret-with-at-least-32-characters";
  const claims = {
    purpose: "session" as const,
    roomId: randomUUID(),
    participantId: randomUUID(),
    role: "host" as const,
    exp: 2000,
  };
  it("binds role, room, identity, expiry and purpose to a signature", () => {
    const token = signToken(claims, secret);
    expect(verifyToken(token, secret, "session", 1000_000)).toEqual(claims);
    expect(() => verifyToken(token, secret, "invite", 1000_000)).toThrow();
    expect(() => verifyToken(token, secret, "session", 2000_000)).toThrow();
    expect(() =>
      verifyToken(token, "wrong secret", "session", 1000_000),
    ).toThrow();
    const forged =
      Buffer.from(
        JSON.stringify({ ...claims, participantId: randomUUID() }),
      ).toString("base64url") +
      "." +
      token.split(".")[1];
    expect(() => verifyToken(forged, secret, "session", 1000_000)).toThrow();
  });
});
