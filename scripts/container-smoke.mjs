import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Run inside the built image; no published ports or external services required.
const origin = process.env.PUBLIC_ORIGIN;
assert(origin?.startsWith("https://"));
const app = spawn(process.execPath, ["dist/apps/server/src/main.js"], {
  stdio: "inherit",
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app.exitCode !== null)
      throw new Error(`Server exited: ${app.exitCode}`);
    try {
      ready = (await fetch("http://127.0.0.1:3000/healthz")).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, "Container health check failed");
  const page = await fetch("http://127.0.0.1:3000/");
  assert.equal(page.status, 200);
  assert((await page.text()).includes("LocalTake"));
  assert(page.headers.get("content-security-policy")?.includes("default-src"));
  const room = await fetch("http://127.0.0.1:3000/api/rooms", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Container verification" }),
  });
  assert.equal(room.status, 200);
  const credentials = await room.json();
  assert(credentials.roomId && credentials.token && credentials.inviteToken);
  if (process.env.TELEMETRY_DIR) {
    assert.equal(credentials.telemetry?.enabled, true);
    const telemetry = await fetch("http://127.0.0.1:3000/api/telemetry", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.token}`,
      },
      body: JSON.stringify({
        version: 1,
        pageId: crypto.randomUUID(),
        sequence: 1,
        dropped: 0,
        events: [
          {
            at: new Date().toISOString(),
            elapsedMs: 0,
            scope: "smoke",
            event: "container.test",
            detail: { message: `Credential redaction ${credentials.token}` },
          },
        ],
      }),
    });
    assert.equal(telemetry.status, 202);
    assert.equal((await telemetry.json()).accepted, true);
    let persisted = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      for (const file of await readdir(process.env.TELEMETRY_DIR)) {
        const text = await readFile(
          join(process.env.TELEMETRY_DIR, file),
          "utf8",
        );
        assert(!text.includes(credentials.token));
        if (text.includes("container.test")) persisted = true;
      }
      if (persisted) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(persisted, "Telemetry was accepted but not persisted");
  }
  const rejected = await fetch("http://127.0.0.1:3000/api/rooms", {
    method: "POST",
    headers: {
      Origin: "https://wrong.invalid",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Invalid origin" }),
  });
  assert.equal(rejected.status, 403);
  console.log(
    "Container smoke passed: health, static client, CSP, room API, origin rejection.",
  );
} finally {
  if (app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill("SIGTERM");
    await exited;
  }
}
