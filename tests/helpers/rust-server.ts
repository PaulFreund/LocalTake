import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type Config = {
  secret: string;
  origin: string;
  maxParticipants?: number;
  turnEnabled?: boolean;
  turnUrls?: string[];
  turnSecret?: string;
  iceTransportPolicy?: "all" | "relay";
  clientDir?: string;
  telemetry?: boolean;
};

// Keep the existing coordinator scenarios, but execute every HTTP request and
// WebSocket exchange against the actual Rust executable in its own process.
export async function createApp(config: Config) {
  const directory = await mkdtemp(join(tmpdir(), "localtake-rust-test-"));
  const telemetryDir = join(directory, "telemetry");
  if (config.telemetry) await mkdir(telemetryDir);
  const executable =
    process.env.LOCALTAKE_TEST_SERVER ??
    resolve(
      "target/debug/localtake-server" +
        (process.platform === "win32" ? ".exe" : ""),
    );
  const child = spawn(executable, [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: "0",
      PUBLIC_ORIGIN: config.origin,
      ROOM_SIGNING_SECRET: config.secret,
      MAX_PARTICIPANTS: String(config.maxParticipants ?? 4),
      TURN_ENABLED: String(config.turnEnabled ?? true),
      TURN_URLS: (config.turnUrls ?? []).join(","),
      TURN_SHARED_SECRET: config.turnSecret ?? "",
      ICE_TRANSPORT_POLICY: config.iceTransportPolicy ?? "all",
      CLIENT_DIR: config.clientDir ?? join(directory, "no-client"),
      TELEMETRY_DIR: config.telemetry ? telemetryDir : "",
      TELEMETRY_MAX_BYTES: "900000000",
    },
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  async function cleanup() {
    if (
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    const resolved = resolve(directory);
    if (
      !resolved.startsWith(
        resolve(tmpdir()) +
          (process.platform === "win32" ? "\\" : "/") +
          "localtake-rust-test-",
      )
    )
      throw new Error("Unexpected test directory");
    await rm(resolved, { recursive: true, force: true });
  }
  let address: string;
  try {
    address = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Rust server startup timed out: " + errors)),
        10_000,
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/LocalTake listening on (http:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Rust server failed: " + errors));
      });
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    address,
    telemetryDir,
    listen: async (_options: { host: string; port: number }) => address,
    close: cleanup,
    async inject(
      options:
        | string
        | {
            method?: string;
            url: string;
            payload?: unknown;
            headers?: Record<string, string>;
          },
    ) {
      const request = typeof options === "string" ? { url: options } : options;
      const result = await fetch(address + request.url, {
        method: request.method ?? "GET",
        headers: {
          ...(request.payload === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...request.headers,
        },
        body:
          request.payload === undefined
            ? undefined
            : JSON.stringify(request.payload),
      });
      const body = await result.text();
      return {
        statusCode: result.status,
        headers: Object.fromEntries(result.headers),
        body,
        json: <T = any>(): T => JSON.parse(body) as T,
      };
    },
    async failTelemetry() {
      // Exact child of the verified temporary fixture directory, never a user
      // configured log directory. A file in its place makes appends fail.
      if (resolve(telemetryDir) !== join(resolve(directory), "telemetry"))
        throw new Error("Unexpected telemetry directory");
      await rm(telemetryDir, { recursive: true, force: true });
      await writeFile(telemetryDir, "disk unavailable");
    },
    async telemetryRows() {
      const names = await readdir(telemetryDir);
      const rows: Record<string, any>[] = [];
      for (const name of names
        .filter((n) => /^telemetry-\d{13}-[a-f0-9-]{36}\.jsonl$/.test(n))
        .sort()) {
        const text = await readFile(join(telemetryDir, name), "utf8");
        for (const line of text.split("\n")) {
          try {
            rows.push(JSON.parse(line));
          } catch {
            /* concurrent append */
          }
        }
      }
      return rows;
    },
    async waitForTelemetry(count: number) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = (await this.telemetryRows()).filter(
          (r) => r.source === "client",
        );
        if (rows.length >= count) return rows;
        await delay(10);
      }
      throw new Error("Telemetry was not persisted");
    },
  };
}
