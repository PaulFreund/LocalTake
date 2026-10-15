import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  TelemetryStore,
  TELEMETRY_DISK_LIMIT,
} from "../apps/server/src/telemetry-store.js";
import { signToken } from "../apps/server/src/auth.js";

const stores: TelemetryStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    expect(
      resolve(directory).startsWith(
        resolve(tmpdir()) + "\\localtake-telemetry-",
      ) ||
        resolve(directory).startsWith(
          resolve(tmpdir()) + "/localtake-telemetry-",
        ),
    ).toBe(true);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function directory() {
  const path = await fs.mkdtemp(join(tmpdir(), "localtake-telemetry-"));
  directories.push(path);
  return path;
}
async function open(
  options: Partial<Parameters<typeof TelemetryStore.open>[0]> = {},
) {
  const store = await TelemetryStore.open({
    directory: await directory(),
    minFreeBytes: 0,
    ...options,
  });
  stores.push(store);
  return store;
}
async function logs(path: string) {
  const names = (await fs.readdir(path)).filter((name) =>
    name.startsWith("telemetry-"),
  );
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      data: await fs.readFile(join(path, name), "utf8"),
      bytes: (await fs.stat(join(path, name))).size,
    })),
  );
  return {
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    rows: files.flatMap((file) =>
      file.data
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ),
    files,
  };
}

it("deletes oldest files before append, keeps the latest data and survives restart", async () => {
  const store = await open({ maxBytes: 1000, segmentBytes: 300 });
  for (let sequence = 0; sequence < 24; sequence++) {
    expect(store.enqueue({ sequence, value: "x".repeat(100) })).toBe(true);
    await store.flush();
    expect((await logs(store.directory)).bytes).toBeLessThanOrEqual(1000);
  }
  const data = await logs(store.directory);
  expect(Math.max(...data.rows.map((row) => row.sequence))).toBe(23);
  expect(Math.min(...data.rows.map((row) => row.sequence))).toBeGreaterThan(0);
  await store.close();
  const restarted = await open({
    directory: store.directory,
    maxBytes: 500,
    segmentBytes: 300,
  });
  expect((await logs(store.directory)).bytes).toBeLessThanOrEqual(500);
  restarted.enqueue({ sequence: 24 });
  await restarted.flush();
  expect(
    (await logs(store.directory)).rows.some((row) => row.sequence === 24),
  ).toBe(true);
});

it("enforces retention and an existing oversized log budget without deleting other files", async () => {
  const path = await directory();
  const stale = `telemetry-${Date.now() - 8 * 86400_000}-${randomUUID()}.jsonl`;
  const large = `telemetry-${Date.now()}-${randomUUID()}.jsonl`;
  await fs.writeFile(join(path, stale), "old");
  await fs.writeFile(join(path, large), "x".repeat(1200));
  await fs.writeFile(join(path, "keep.txt"), "untouched");
  await open({ directory: path, maxBytes: 1000 });
  expect((await logs(path)).bytes).toBe(0);
  expect(await fs.readFile(join(path, "keep.txt"), "utf8")).toBe("untouched");
});

it("rotates a low traffic file after a day so recent records do not age with an old segment", async () => {
  const store = await open();
  store.enqueue({ first: true });
  await store.flush();
  const realNow = Date.now();
  const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 86400_001);
  try {
    store.enqueue({ second: true });
    await store.flush();
    expect((await logs(store.directory)).files).toHaveLength(2);
  } finally {
    spy.mockRestore();
  }
});

it("bounds queued memory while disk writes are stalled and enqueue never waits for them", async () => {
  let resume!: () => void;
  const stalled = new Promise<void>((done) => {
    resume = done;
  });
  const append = vi.fn(async (...args: Parameters<typeof fs.appendFile>) => {
    await stalled;
    return fs.appendFile(...args);
  });
  const store = await open({
    queueBytes: 400,
    io: { ...fs, appendFile: append },
  });
  expect(store.enqueue({ value: "x".repeat(150) })).toBe(true);
  const flush = store.flush();
  await vi.waitFor(() => expect(append).toHaveBeenCalled());
  for (let i = 0; i < 1000; i++) store.enqueue({ value: "x".repeat(150) });
  expect(store.status().queuedBytes).toBeLessThanOrEqual(400);
  expect(store.status().dropped).toBeGreaterThan(990);
  resume();
  await flush;
  expect(store.status().queuedBytes).toBe(0);
});

it.each(["ENOSPC", "EROFS"])(
  "discards logs and backs off on %s without throwing into the caller",
  async (code) => {
    const append = vi.fn(async () => {
      throw Object.assign(new Error(code), { code });
    });
    const store = await open({ io: { ...fs, appendFile: append } });
    expect(store.enqueue({ event: "first" })).toBe(true);
    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.status().retryAt).toBeGreaterThan(Date.now());
    expect(store.enqueue({ event: "later" })).toBe(false);
    expect(append).toHaveBeenCalledTimes(1);
  },
);

it("stops writing when free disk space is low", async () => {
  const append = vi.fn(fs.appendFile);
  const store = await open({
    minFreeBytes: 1024,
    io: {
      ...fs,
      appendFile: append,
      statfs: vi.fn(async () => ({
        bavail: 1,
        bsize: 1,
      })) as unknown as typeof fs.statfs,
    },
  });
  store.enqueue({ event: "test" });
  await store.flush();
  expect(append).not.toHaveBeenCalled();
  expect(store.status().dropped).toBeGreaterThan(0);
});

it("redacts actual two-part session tokens, credentials and SDP even when bypassing the client", async () => {
  const token = signToken(
    {
      purpose: "session",
      roomId: randomUUID(),
      participantId: randomUUID(),
      role: "host",
      exp: 9999999999,
    },
    "x".repeat(64),
  );
  const store = await open();
  store.enqueue({
    event: "error",
    detail: {
      message: `Failed with ${token}`,
      authorization: `Bearer ${token}`,
      credential: "PRIVATE",
      sdp: "v=0 PRIVATE",
      chat: "PRIVATE",
    },
  });
  await store.flush();
  const data = (await logs(store.directory)).files[0].data;
  expect(data).not.toContain(token);
  expect(data).not.toContain("PRIVATE");
  expect(data).toContain("[redacted]");
});

it("cannot configure a budget beyond 900 MB or write an oversized record", async () => {
  const store = await open({ maxBytes: Infinity });
  expect(store.maxBytes).toBe(TELEMETRY_DISK_LIMIT);
  const raised = await open({ maxBytes: 10_000_000_000 });
  expect(raised.maxBytes).toBe(TELEMETRY_DISK_LIMIT);
  expect(
    raised.enqueue({
      detail: Array.from({ length: 24 }, () => "x".repeat(1024)),
    }),
  ).toBe(false);
});
