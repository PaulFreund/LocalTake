import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { idSchema, nameSchema } from "../../../packages/protocol/src/index.js";

const claimsSchema = z.object({
  purpose: z.enum(["session", "invite"]),
  roomId: idSchema,
  roomName: nameSchema.optional(),
  participantId: idSchema.optional(),
  role: z.enum(["host", "guest"]),
  exp: z.number().int().positive(),
});
export type Claims = z.infer<typeof claimsSchema>;
export function signToken(claims: Claims, secret: string): string {
  const data = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
export function verifyToken(
  token: string,
  secret: string,
  purpose: Claims["purpose"],
  now = Date.now(),
): Claims {
  const parts = token.split(".");
  if (parts.length !== 2 || token.length > 4096)
    throw new Error("Ungültiger Zugang.");
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  const actual = Buffer.from(parts[1], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("Ungültiger Zugang.");
  const claims = claimsSchema.parse(
    JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
  );
  if (
    claims.exp <= now / 1000 ||
    claims.purpose !== purpose ||
    (purpose === "session" && !claims.participantId)
  )
    throw new Error("Zugang abgelaufen oder ungültig.");
  if (purpose === "invite" && claims.role !== "guest")
    throw new Error("Ungültige Einladung.");
  return claims;
}
