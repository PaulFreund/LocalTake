import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { serviceWorkerSource } from "./service-worker.mjs";
const root = resolve("dist/client");
const files = (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter((file) => file.isFile() && file.name !== "sw.js")
  .sort((a, b) =>
    resolve(a.parentPath, a.name).localeCompare(resolve(b.parentPath, b.name)),
  );
const urls = files.map(
  (file) =>
    "/" +
    resolve(file.parentPath, file.name)
      .slice(root.length + 1)
      .replaceAll("\\", "/"),
);
const digest = createHash("sha256");
digest.update(await readFile(new URL("./service-worker.mjs", import.meta.url)));
for (const file of files)
  digest.update(await readFile(resolve(file.parentPath, file.name)));
const cache = `localtake-${digest.digest("hex").slice(0, 16)}`;
await writeFile(resolve(root, "sw.js"), serviceWorkerSource(cache, urls));
console.log(`Offline recovery cache: ${urls.length} assets (${cache}).`);
