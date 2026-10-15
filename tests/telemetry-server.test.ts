import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../apps/server/src/app.js";
import { TELEMETRY_BODY_BYTES } from "../packages/protocol/src/telemetry.js";
import type { Credentials } from "../packages/protocol/src/index.js";
import type { TelemetrySink } from "../apps/server/src/telemetry-store.js";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});
async function fixture(sink?: TelemetrySink) {
  const rows: Record<string, unknown>[] = [];
  const telemetry = sink ?? {
    enqueue: (row: Record<string, unknown>) => {
      rows.push(row);
      return true;
    },
    status: () => ({ enabled: true, dropped: 0 }),
    close: async () => undefined,
  };
  const app = await createApp({
    secret: "a".repeat(64),
    origin: "https://record.example.test",
    telemetry,
  });
  apps.push(app);
  const host = (
    await app.inject({
      method: "POST",
      url: "/api/rooms",
      payload: { name: "Host" },
    })
  ).json<Credentials>();
  const batch = {
    version: 1,
    pageId: randomUUID(),
    sequence: 1,
    dropped: 0,
    events: [
      {
        at: new Date().toISOString(),
        elapsedMs: 123,
        scope: "live",
        event: "ice.failed",
      },
    ],
    sample: { signaling: { socket: "closed" } },
  };
  const upload = (
    payload: unknown = batch,
    token: string | undefined = host.token,
  ) =>
    app.inject({
      method: "POST",
      url: "/api/telemetry",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });
  return { app, host, rows, batch, upload };
}

it("advertises telemetry and accepts reports with trusted identities even when WSS cannot connect", async () => {
  const f = await fixture();
  expect(f.host.telemetry?.enabled).toBe(true);
  expect((await f.upload()).json()).toEqual({ accepted: true });
  expect(f.rows[0]).toMatchObject({
    source: "client",
    roomId: f.host.roomId,
    participantId: f.host.participantId,
    batch: f.batch,
  });
  expect(f.rows[0]).not.toHaveProperty("token");
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/rooms/join",
        payload: { name: "Guest", inviteToken: f.host.inviteToken },
      })
    ).json().telemetry.enabled,
  ).toBe(true);
});

it("rejects absent, invitation or invalid credentials and forged identities", async () => {
  const f = await fixture();
  expect((await f.upload(f.batch, "")).statusCode).toBe(401);
  expect((await f.upload(f.batch, f.host.inviteToken)).statusCode).toBe(401);
  expect((await f.upload(f.batch, "invalid")).statusCode).toBe(401);
  expect(
    (await f.upload({ ...f.batch, participantId: randomUUID() })).statusCode,
  ).toBe(400);
  expect(f.rows).toHaveLength(0);
});

it("rejects oversized and malformed requests before persistence", async () => {
  const f = await fixture();
  expect(
    (await f.upload({ ...f.batch, sample: "x".repeat(TELEMETRY_BODY_BYTES) }))
      .statusCode,
  ).toBe(413);
  expect(
    (
      await f.upload({
        ...f.batch,
        events: Array.from({ length: 25 }, () => f.batch.events[0]),
      })
    ).statusCode,
  ).toBe(400);
  expect((await f.upload({ ...f.batch, sequence: -1 })).statusCode).toBe(400);
  expect(f.rows).toHaveLength(0);
});

it("rejects a declared oversized body without closing a proxy's upstream connection", async () => {
  const f = await fixture();
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(address + "/api/telemetry", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${f.host.token}`,
    },
    body: JSON.stringify({
      ...f.batch,
      sample: "x".repeat(TELEMETRY_BODY_BYTES),
    }),
  });
  expect(response.status).toBe(413);
  expect(response.headers.get("connection")).toBe("keep-alive");
  expect((await response.json()).error).toBe("Diagnose ist zu groß.");
  expect((await fetch(address + "/healthz")).status).toBe(200);
  expect(f.rows).toHaveLength(0);
});

it("deduplicates retries while rate-limiting a new batch per participant", async () => {
  const f = await fixture();
  expect((await f.upload()).statusCode).toBe(202);
  expect((await f.upload()).json()).toEqual({
    accepted: true,
    duplicate: true,
  });
  expect(f.rows).toHaveLength(1);
  expect((await f.upload({ ...f.batch, sequence: 2 })).statusCode).toBe(429);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 5001);
  expect((await f.upload({ ...f.batch, sequence: 2 })).statusCode).toBe(202);
  expect(f.rows).toHaveLength(2);
});

it.each([false, "throw"])(
  "discarding telemetry (%s) keeps the server and room API healthy",
  async (failure) => {
    const f = await fixture({
      enqueue: () => {
        if (failure === "throw") throw new Error("Disk unavailable");
        return false;
      },
      status: () => ({ enabled: true, dropped: 1 }),
      close: async () => undefined,
    });
    expect((await f.upload()).json()).toEqual({ accepted: false });
    expect((await f.app.inject("/healthz")).json().ok).toBe(true);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/rooms",
          payload: { name: "Another room" },
        })
      ).statusCode,
    ).toBe(200);
  },
);

it("telemetry flooding uses a separate rate-limit bucket from normal operation", async () => {
  const f = await fixture();
  for (let i = 0; i < 241; i++) await f.upload();
  expect((await f.upload()).statusCode).toBe(429);
  expect((await f.app.inject("/healthz")).statusCode).toBe(200);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/rooms",
        payload: { name: "Normal room" },
      })
    ).statusCode,
  ).toBe(200);
});
