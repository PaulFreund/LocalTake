import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const root = resolve(".");
const archive = resolve(process.argv[2] ?? "work/localtake-source.tar.gz");
if (!archive.startsWith(root + sep + "work" + sep))
  throw new Error("Archive must be inside this workspace's work directory");
await mkdir(dirname(archive), { recursive: true });
const candidates = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const files = [];
for (const path of candidates) {
  if (
    path.includes("\n") ||
    path.includes("\r") ||
    path.split("/").some((p) => p.startsWith(".env") && p !== ".env.example")
  )
    throw new Error("Unexpected archive entry");
  const absolute = resolve(root, path);
  if (!absolute.startsWith(root + sep))
    throw new Error("Source escapes workspace");
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  if (!info.isFile())
    throw new Error("Archive accepts regular source files only");
  files.push(path);
}
files.sort();
const list = archive + ".files";
await writeFile(list, files.join("\n") + "\n");
execFileSync("tar", ["-czf", archive, "-T", list], { cwd: root });
const bytes = await readFile(archive);
const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
const metadata = {
  createdAt: new Date().toISOString(),
  archive,
  sourceSha256,
  buildRevision: sourceSha256.slice(0, 12),
  baseGitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  workingTreeDirty:
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
      .length > 0,
  files: files.length,
  bytes: bytes.length,
};
await writeFile(archive + ".json", JSON.stringify(metadata, null, 2) + "\n");
console.log(JSON.stringify(metadata, null, 2));
