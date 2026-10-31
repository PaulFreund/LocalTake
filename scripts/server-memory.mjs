import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

// Measure only the coordinator process. The load generator is a separate process.
// Usage: node scripts/server-memory.mjs <executable> [arguments...]
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Pass the server executable and its arguments");
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const app = spawn(command, args, {
  env: {
    ...process.env,
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_ORIGIN: origin,
    ROOM_SIGNING_SECRET: "memory-benchmark-secret".repeat(3),
    TURN_ENABLED: "false",
    ICE_TRANSPORT_POLICY: "all",
    TELEMETRY_DIR: "",
  },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});
let errors = "";
app.stderr.on("data", (data) => (errors += data));
const sockets = [];
function memory() {
  if (process.platform === "win32") {
    return JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$p = Get-Process -Id ${app.pid}; @{rss=$p.WorkingSet64; private=$p.PrivateMemorySize64; peakRss=$p.PeakWorkingSet64} | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true, encoding: "utf8" },
      ),
    );
  }
  const rss =
    Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(app.pid)], {
        encoding: "utf8",
      }).trim(),
    ) * 1024;
  return { rss };
}
async function post(path, body) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (app.exitCode !== null) throw new Error(errors);
    try {
      ready = (await fetch(origin + "/healthz")).ok;
    } catch {}
    if (ready) break;
    await delay(50);
  }
  if (!ready) throw new Error("Server did not start: " + errors);
  await delay(1000);
  const idle = memory();
  for (let room = 0; room < 12; room++) {
    const host = await post("/api/rooms", { name: "Memory host" });
    for (let peer = 0; peer < 4; peer++) {
      const credentials =
        peer === 0
          ? host
          : await post("/api/rooms/join", {
              name: "Guest",
              inviteToken: host.inviteToken,
            });
      const socket = new WebSocket(origin.replace("http", "ws") + "/ws", {
        origin,
      });
      sockets.push(socket);
      const welcome = new Promise((resolve, reject) => {
        socket.on("message", (raw) => {
          if (JSON.parse(raw.toString()).type === "welcome") resolve();
        });
        socket.once("error", reject);
      });
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          type: "auth",
          version: 1,
          token: credentials.token,
          name: "Memory peer",
        }),
      );
      await welcome;
    }
  }
  await delay(1000);
  const connected = memory();
  const sources = Array.from({ length: 16 }, () => ({
    trackId: crypto.randomUUID(),
    label: "x".repeat(120),
    kind: "video",
    state: "recording",
    savedSeconds: 1,
    capturedSeconds: 1,
    bytes: 1000000,
    segments: 1,
    warning: "w".repeat(300),
  }));
  const recordingId = crypto.randomUUID();
  for (let round = 0; round < 40; round++) {
    for (const socket of sockets)
      socket.send(
        JSON.stringify({
          type: "record.status",
          status: { recordingId, state: "recording", sources },
        }),
      );
    await delay(30);
  }
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            socket.off("message", receive);
            reject(new Error("Clock reply missing after load"));
          }, 5000);
          function receive(raw) {
            const message = JSON.parse(raw.toString());
            if (message.type === "clock.reply" && message.t1 === 987654321) {
              clearTimeout(timer);
              socket.off("message", receive);
              resolve();
            }
          }
          socket.on("message", receive);
          socket.send(JSON.stringify({ type: "clock.probe", t1: 987654321 }));
        }),
    ),
  );
  await delay(1000);
  const loaded = memory();
  for (const socket of sockets) socket.close();
  await delay(1000);
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        rooms: 12,
        participants: 48,
        statusUpdates: 1920,
        idle,
        connected,
        loaded,
        disconnected: memory(),
      },
      null,
      2,
    ),
  );
} finally {
  for (const socket of sockets) socket.terminate();
  if (app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill("SIGTERM");
    await exited;
  }
}
