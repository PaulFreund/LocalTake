import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Check a running container via LOCALTAKE_SMOKE_URL, or launch a local Rust
// release binary. Node is only used by this test driver, never by the image.
const origin = process.env.PUBLIC_ORIGIN;
assert(origin?.startsWith("https://"));
const base =
  process.env.LOCALTAKE_SMOKE_URL ??
  `http://127.0.0.1:${process.env.PORT || 3000}`;
const executable =
  process.env.LOCALTAKE_SERVER_BIN ??
  resolve(
    "target/release/localtake-server" +
      (process.platform === "win32" ? ".exe" : ""),
  );
const app = process.env.LOCALTAKE_SMOKE_URL
  ? null
  : spawn(executable, [], { stdio: "inherit", windowsHide: true });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app && app.exitCode !== null)
      throw new Error(`Server exited: ${app.exitCode}`);
    try {
      ready = (await fetch(base + "/healthz")).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, "Container health check failed");
  if (app) execFileSync(executable, ["healthcheck"], { windowsHide: true });
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert((await page.text()).includes("LocalTake"));
  assert(page.headers.get("content-security-policy")?.includes("default-src"));
  const room = await fetch(base + "/api/rooms", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Container verification" }),
  });
  assert.equal(room.status, 200);
  const credentials = await room.json();
  assert(credentials.roomId && credentials.token && credentials.inviteToken);
  if (process.env.TELEMETRY_DIR) {
    assert.equal(credentials.telemetry?.enabled, true);
    const telemetry = await fetch(base + "/api/telemetry", {
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
    // A remote container's volume is checked separately by the operator.
    if (!app) persisted = true;
    for (let attempt = 0; app && attempt < 50; attempt++) {
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
    if (app) {
      const output = execFileSync(
        executable,
        ["telemetry-read", "--room", credentials.roomId],
        { encoding: "utf8", windowsHide: true },
      );
      assert(output.includes("container.test"));
      assert(!output.includes(credentials.token));
    }
  }
  const rejected = await fetch(base + "/api/rooms", {
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
  if (app && app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill("SIGTERM");
    await exited;
  }
}
