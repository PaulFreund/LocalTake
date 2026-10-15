import {
  mkdir,
  readdir,
  stat,
  statfs,
  appendFile,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { compactDiagnostic } from "../../../packages/protocol/src/telemetry.js";

// Leave space for Docker's two 25 MiB application logs: total < 1 GB.
export const TELEMETRY_DISK_LIMIT = 900_000_000;
const FILE_PATTERN = /^telemetry-\d{13}-[a-f0-9-]{36}\.jsonl$/;
type File = { path: string; bytes: number; time: number };
export type TelemetrySink = {
  enqueue(record: Record<string, unknown>): boolean;
  status(): { enabled: boolean; dropped: number };
  close(): Promise<void>;
};
type Options = {
  directory: string;
  maxBytes?: number;
  segmentBytes?: number;
  retentionMs?: number;
  queueBytes?: number;
  minFreeBytes?: number;
  // The injectable async I/O allows testing a stalled or failed disk.
  io?: typeof disk;
};
const disk = { mkdir, readdir, stat, statfs, appendFile, unlink };

export class TelemetryStore implements TelemetrySink {
  readonly directory: string;
  readonly maxBytes: number;
  private readonly segmentBytes: number;
  private readonly retentionMs: number;
  private readonly queueLimit: number;
  private readonly minFreeBytes: number;
  private readonly io: typeof disk;
  private files: File[] = [];
  private totalBytes = 0;
  private active: File | null = null;
  private queue: { line: string; bytes: number }[] = [];
  private queuedBytes = 0;
  private dropped = 0;
  private draining: Promise<void> | null = null;
  private scheduled = false;
  private closed = false;
  private retryAt = 0;
  private lastDiskCheck = 0;
  private timer?: ReturnType<typeof setInterval>;

  private constructor(options: Options) {
    this.directory = resolve(options.directory);
    const limit = options.maxBytes ?? TELEMETRY_DISK_LIMIT;
    this.maxBytes =
      Number.isFinite(limit) && limit > 0
        ? Math.max(1, Math.min(TELEMETRY_DISK_LIMIT, Math.floor(limit)))
        : TELEMETRY_DISK_LIMIT;
    this.segmentBytes = Math.min(
      this.maxBytes,
      Math.max(1, options.segmentBytes ?? 8_000_000),
    );
    this.retentionMs = options.retentionMs ?? 7 * 86400_000;
    this.queueLimit = options.queueBytes ?? 2 * 1024 * 1024;
    this.minFreeBytes = options.minFreeBytes ?? 256 * 1024 * 1024;
    this.io = options.io ?? disk;
  }
  static async open(options: Options): Promise<TelemetryStore> {
    const store = new TelemetryStore(options);
    await store.io.mkdir(store.directory, { recursive: true });
    for (const name of await store.io.readdir(store.directory)) {
      if (!FILE_PATTERN.test(name)) continue;
      const path = join(store.directory, name);
      const info = await store.io.stat(path);
      if (info.isFile())
        store.files.push({
          path,
          bytes: info.size,
          time: Number(name.slice(10, 23)),
        });
    }
    store.files.sort((a, b) => a.time - b.time || a.path.localeCompare(b.path));
    store.totalBytes = store.files.reduce((sum, file) => sum + file.bytes, 0);
    await store.prune(0);
    store.timer = setInterval(() => store.schedule(), 60_000);
    store.timer.unref();
    return store;
  }
  status() {
    return {
      enabled: !this.closed,
      dropped: this.dropped,
      bytes: this.totalBytes,
      queuedBytes: this.queuedBytes,
      files: this.files.length,
      retryAt: this.retryAt,
    };
  }
  enqueue(record: Record<string, unknown>): boolean {
    if (this.closed || Date.now() < this.retryAt) {
      this.dropped++;
      return false;
    }
    let line: string;
    try {
      line = JSON.stringify(compactDiagnostic(record)) + "\n";
    } catch {
      this.dropped++;
      return false;
    }
    const bytes = Buffer.byteLength(line);
    if (
      bytes > Math.min(16_384, this.maxBytes, this.segmentBytes) ||
      this.queue.length >= 512 ||
      this.queuedBytes + bytes > this.queueLimit
    ) {
      this.dropped++;
      return false;
    }
    this.queue.push({ line, bytes });
    this.queuedBytes += bytes;
    this.schedule();
    return true;
  }
  private schedule() {
    if (
      this.closed ||
      this.scheduled ||
      this.draining ||
      Date.now() < this.retryAt
    )
      return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (!this.closed) void this.flush();
    });
  }
  private async prune(incoming: number) {
    const cutoff = Date.now() - this.retentionMs;
    while (
      this.files.length &&
      (this.files[0].time < cutoff ||
        this.totalBytes + incoming > this.maxBytes)
    ) {
      const file = this.files[0];
      // Only exact managed filenames in this directory; no recursive deletion.
      await this.io.unlink(file.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.files.shift();
      this.totalBytes -= file.bytes;
      if (this.active === file) this.active = null;
    }
  }
  private async drain() {
    let writingRows = 0;
    try {
      await this.prune(0);
      if (Date.now() - this.lastDiskCheck >= 30_000) {
        const space = await this.io.statfs(this.directory);
        this.lastDiskCheck = Date.now();
        if (space.bavail * space.bsize < this.minFreeBytes)
          throw new Error("Low disk space");
      }
      while (this.queue.length) {
        const group = [];
        let bytes = 0;
        while (
          this.queue.length &&
          bytes + this.queue[0].bytes <= Math.min(65_536, this.segmentBytes)
        ) {
          const row = this.queue.shift()!;
          group.push(row.line);
          bytes += row.bytes;
          // Include the in-flight batch in the queue budget until it completes.
        }
        if (
          !this.active ||
          this.active.bytes + bytes > this.segmentBytes ||
          Date.now() - this.active.time >= 86400_000
        )
          this.active = null;
        await this.prune(bytes);
        if (!this.active) {
          const time = Date.now();
          this.active = {
            path: join(
              this.directory,
              `telemetry-${time}-${randomUUID()}.jsonl`,
            ),
            bytes: 0,
            time,
          };
          this.files.push(this.active);
        }
        // Reserve bytes before append; a partial disk write also stays within cap.
        writingRows = group.length;
        this.active.bytes += bytes;
        this.totalBytes += bytes;
        await this.io.appendFile(this.active.path, group.join(""), {
          mode: 0o600,
        });
        writingRows = 0;
        this.queuedBytes -= bytes;
        await new Promise<void>((done) => setImmediate(done));
      }
    } catch {
      this.dropped += this.queue.length + writingRows;
      this.queue = [];
      this.queuedBytes = 0;
      this.retryAt = Date.now() + 60_000;
      this.lastDiskCheck = 0;
    }
  }
  // For shutdown/tests only. HTTP and WebSocket handlers call enqueue, never flush.
  async flush() {
    if (!this.draining)
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    await this.draining;
    if (this.queue.length) this.schedule();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    // A stalled filesystem must not delay application shutdown indefinitely.
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      this.flush(),
      new Promise<void>((done) => {
        timer = setTimeout(done, 1500);
      }),
    ]);
    clearTimeout(timer!);
  }
}
