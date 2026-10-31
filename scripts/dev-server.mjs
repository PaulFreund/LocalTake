import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";

const executable = resolve(
  "target/debug/localtake-server" +
    (process.platform === "win32" ? ".exe" : ""),
);
let server;
let build;
let pending = false;
let running = false;
let closing = false;
let debounce;
async function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
}
async function rebuild() {
  pending = true;
  if (running || closing) return;
  running = true;
  try {
    while (pending && !closing) {
      pending = false;
      await stop(server);
      build = spawn(
        "cargo",
        ["build", "--locked", "--bin", "localtake-server"],
        { stdio: "inherit", windowsHide: true },
      );
      const [code] = await once(build, "exit");
      if (code === 0 && !closing && !pending) {
        server = spawn(executable, [], { stdio: "inherit", windowsHide: true });
        server.on("error", (error) => console.error(error.message));
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    running = false;
  }
}
const watchers = [
  watch("apps/server/src", { recursive: true }, (_event, filename) => {
    if (filename?.endsWith(".rs")) schedule();
  }),
  ...["Cargo.toml", "Cargo.lock", "apps/server/Cargo.toml", ".env"].flatMap(
    (path) => {
      try {
        return [watch(path, schedule)];
      } catch {
        return [];
      }
    },
  ),
];
function schedule() {
  clearTimeout(debounce);
  debounce = setTimeout(() => void rebuild(), 150);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    closing = true;
    clearTimeout(debounce);
    for (const watcher of watchers) watcher.close();
    await Promise.all([stop(server), stop(build)]);
  });
await rebuild();
