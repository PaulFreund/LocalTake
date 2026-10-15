import { request } from "node:https";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";

// Isolated test network with Caddy's disposable internal CA; never use this setting in production.
const origin = "https://localtake.invalid";
function fetchProxy(path, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      origin + path,
      {
        rejectUnauthorized: false,
        method: body ? "POST" : "GET",
        headers: { Origin: origin, "Content-Type": "application/json" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("HTTPS timeout")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
let health;
for (let attempt = 0; attempt < 50; attempt++) {
  try {
    health = await fetchProxy("/healthz");
    if (health.status === 200) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(health?.status, 200);
assert((await fetchProxy("/")).body.includes("LocalTake"));
const room = await fetchProxy("/api/rooms", { name: "Proxy verification" });
assert.equal(room.status, 200);
const { token } = JSON.parse(room.body);
const socket = new WebSocket("wss://localtake.invalid/ws", {
  origin,
  rejectUnauthorized: false,
});
const timeout = setTimeout(() => socket.terminate(), 5000);
const welcome = new Promise((resolve, reject) => {
  socket.once("message", resolve);
  socket.once("close", () => reject(new Error("WSS closed before welcome")));
  socket.once("error", reject);
});
// Observe early failures while the separate open handshake is still pending.
void welcome.catch(() => {});
try {
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "auth",
      version: 1,
      token,
      name: "Proxy verification",
    }),
  );
  const raw = await welcome;
  assert.equal(JSON.parse(raw.toString()).type, "welcome");
  console.log(
    "Caddy smoke passed: HTTPS health, static client, room creation and authenticated WSS upgrade.",
  );
} finally {
  clearTimeout(timeout);
  socket.close();
}
