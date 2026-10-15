export class MemoryDirectory {
  kind = "directory";
  entries = new Map<string, MemoryDirectory | MemoryFile>();
  failCloseFor = "";
  constructor(
    readonly name = "root",
    readonly caseInsensitive = false,
  ) {}
  async isSameEntry(other: unknown) {
    return other === this;
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let entry =
      this.entries.get(name) ??
      (this.caseInsensitive
        ? [...this.entries].find(
            ([key]) => key.toLowerCase() === name.toLowerCase(),
          )?.[1]
        : undefined);
    if (!entry && options?.create) {
      entry = new MemoryDirectory(name, this.caseInsensitive);
      this.entries.set(name, entry);
    }
    if (!entry) throw new DOMException("Not found", "NotFoundError");
    if (!(entry instanceof MemoryDirectory)) throw new Error("Not a directory");
    return entry;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    let entry =
      this.entries.get(name) ??
      (this.caseInsensitive
        ? [...this.entries].find(
            ([key]) => key.toLowerCase() === name.toLowerCase(),
          )?.[1]
        : undefined);
    if (!entry && options?.create) {
      entry = new MemoryFile(name, this);
      this.entries.set(name, entry);
    }
    if (!entry) throw new DOMException("Not found", "NotFoundError");
    if (!(entry instanceof MemoryFile)) throw new Error("Not a file");
    return entry;
  }
  async *values() {
    yield* this.entries.values();
  }
  async removeEntry(name: string) {
    this.entries.delete(name);
  }
}
export class MemoryFile {
  kind = "file";
  bytes = new Uint8Array();
  constructor(
    readonly name: string,
    readonly parent: MemoryDirectory,
  ) {}
  async getFile() {
    return new File([this.bytes], this.name);
  }
  async createWritable() {
    let pending = new Uint8Array();
    let position = 0;
    const stream = new WritableStream({
      write: async (
        chunk:
          | ArrayBuffer
          | Uint8Array
          | { type: string; position: number; data: Uint8Array },
      ) => {
        const bytes = "type" in chunk ? chunk.data : new Uint8Array(chunk);
        if ("type" in chunk) position = chunk.position;
        const next = new Uint8Array(
          Math.max(pending.length, position + bytes.byteLength),
        );
        next.set(pending);
        next.set(bytes, position);
        pending = next;
        position += bytes.byteLength;
      },
      close: async () => {
        if (
          this.name.endsWith(this.parent.failCloseFor) &&
          this.parent.failCloseFor
        )
          throw new Error("Disk failure at close");
        this.bytes = pending;
      },
    });
    return Object.assign(stream, {
      async write(chunk: unknown) {
        const writer = stream.getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
      },
      async close() {
        const writer = stream.getWriter();
        try {
          await writer.close();
        } finally {
          writer.releaseLock();
        }
      },
    });
  }
}
