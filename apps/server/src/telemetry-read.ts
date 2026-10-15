import { readdir, createReadStream } from "node:fs";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { join } from "node:path";

// Explicit administrator CLI, never an unauthenticated HTTP log endpoint.
const args = process.argv.slice(2);
const filters = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--room", "--participant", "--recording", "--page"].includes(args[i]) ||
    !/^[a-f0-9-]{36}$/i.test(args[i + 1] ?? "")
  )
    throw new Error(
      "Usage: telemetry-read [--room UUID] [--participant UUID] [--recording UUID] [--page UUID]",
    );
  filters.set(args[i].slice(2), args[i + 1]);
}
const directory = process.env.TELEMETRY_DIR;
if (!directory) throw new Error("TELEMETRY_DIR is not configured");
const files = (await promisify(readdir)(directory))
  .filter((name) => /^telemetry-\d{13}-[a-f0-9-]{36}\.jsonl$/.test(name))
  .sort()
  .slice(-4);
const rows: string[] = [];
for (const file of files) {
  const input = createReadStream(join(directory, file));
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  let failure: NodeJS.ErrnoException | undefined;
  input.on("error", (error: NodeJS.ErrnoException) => {
    failure = error;
    lines.close();
  });
  try {
    for await (const line of lines) {
      if (line.length > 16_384) continue;
      try {
        const row = JSON.parse(line);
        const ids: Record<string, unknown> = {
          room: row.roomId,
          participant: row.participantId,
          recording:
            row.recordingId ?? row.batch?.sample?.recording?.recordingId,
          page: row.batch?.pageId,
        };
        if ([...filters].every(([key, id]) => ids[key] === id)) {
          rows.push(line);
          if (rows.length > 200) rows.shift();
        }
      } catch {
        /* A concurrent append may leave an incomplete final line. */
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  if (failure && failure.code !== "ENOENT") throw failure;
}
for (const row of rows) process.stdout.write(row + "\n");
