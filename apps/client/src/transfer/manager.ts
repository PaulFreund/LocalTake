import { z } from "zod";
import {
  idSchema,
  recordingMetaSchema,
  type Inventory,
  type RecordingMeta,
} from "../../../../packages/protocol/src/index.js";
import {
  sha256,
  holdOriginals,
  type StoredInventory,
  type LocalStore,
} from "../storage/store.js";
import type { LiveMesh, Remote } from "../live/mesh.js";

const uuid = "[a-f0-9-]{36}";
const allowedPath = new RegExp(
  `^(recording\\.json|completion\\.json|(clocks|events)/${uuid}\\.json|tracks/${uuid}/track\\.json|tracks/${uuid}/${uuid}/(epoch\\.json|[0-9]+_[0-9]+us\\.(mp4|wav|segment\\.json)))$`,
);
export const fileEntrySchema = z.object({
  path: z.string().max(200).regex(allowedPath),
  bytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 * 1024),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
type Entry = z.infer<typeof fileEntrySchema>;
const offerSchema = z.object({
  type: z.literal("offer"),
  id: idSchema,
  recording: recordingMetaSchema,
  count: z.number().int().min(1).max(300_000),
  total: z
    .number()
    .int()
    .positive()
    .max(2 ** 40),
  complete: z.boolean(),
});
const controlSchema = z.discriminatedUnion("type", [
  offerSchema,
  z.object({
    type: z.literal("page"),
    id: idSchema,
    files: z.array(fileEntrySchema).min(1).max(8),
  }),
  z.object({ type: z.literal("offer-end"), id: idSchema }),
  z.object({
    type: z.literal("get"),
    id: idSchema,
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("stored"),
    id: idSchema,
    index: z.number().int().nonnegative(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({ type: z.literal("complete"), id: idSchema }),
  z.object({
    type: z.literal("cancel"),
    id: idSchema,
    reason: z.string().max(300),
  }),
]);
export type Transfer = {
  id: string;
  peerId: string;
  recording: RecordingMeta;
  files: Entry[];
  count: number;
  total: number;
  bytes: number;
  completeRecording: boolean;
  direction: "send" | "receive";
  state:
    | "offering"
    | "offered"
    | "transferring"
    | "paused"
    | "verifying"
    | "done"
    | "error";
  error?: string;
  index: number;
  releaseOriginals?: () => void;
};
export class TransferManager extends EventTarget {
  transfers = new Map<string, Transfer>();
  private sendingStore = new Map<string, LocalStore>();
  private receivingStore = new Map<string, LocalStore>();
  private attached = new WeakSet<RTCDataChannel>();
  private incoming = new Map<
    string,
    { id: string; index: number; parts: ArrayBuffer[]; bytes: number }
  >();
  private chains = new Map<string, Promise<void>>();
  private serving = new Set<string>();
  private receipts = new Map<string, Set<number>>();
  constructor(
    readonly mesh: LiveMesh,
    readonly canTransfer: (peerId: string) => boolean,
    readonly bytesPerSecond: () => number = () => 0,
  ) {
    super();
    mesh.addEventListener("channel", (event) => {
      const { remote, channel } = (
        event as CustomEvent<{ remote: Remote; channel: RTCDataChannel }>
      ).detail;
      this.attach(remote, channel);
    });
  }
  private changed() {
    this.dispatchEvent(new Event("change"));
  }
  private error(id: string, error: unknown, notify = true) {
    const transfer = this.transfers.get(id);
    if (transfer && transfer.state !== "error" && transfer.state !== "done") {
      transfer.state = "error";
      transfer.error = error instanceof Error ? error.message : String(error);
      if (this.incoming.get(transfer.peerId)?.id === id)
        this.incoming.delete(transfer.peerId);
      this.receivingStore.delete(id);
      this.sendingStore.delete(id);
      this.receipts.delete(id);
      transfer.releaseOriginals?.();
      const remote = this.mesh.remotes.get(transfer.peerId);
      if (notify && remote?.control?.readyState === "open") {
        try {
          this.control(remote, {
            type: "cancel",
            id,
            reason: transfer.error.slice(0, 300),
          });
        } catch {
          /* A closed channel is already reported locally. */
        }
      }
      this.changed();
    }
  }
  private control(remote: Remote, value: z.infer<typeof controlSchema>) {
    if (remote.control?.readyState !== "open")
      throw new Error(
        "Dateikanal nicht verbunden. Bestand später erneut freigeben.",
      );
    const text = JSON.stringify(value);
    if (text.length > 15_000) throw new Error("Kontrollnachricht zu groß.");
    remote.control.send(text);
  }
  private attach(remote: Remote, channel: RTCDataChannel) {
    if (this.attached.has(channel)) return;
    this.attached.add(channel);
    channel.addEventListener("close", () => {
      for (const transfer of this.transfers.values())
        if (
          transfer.peerId === remote.id &&
          !["done", "error"].includes(transfer.state)
        )
          this.error(
            transfer.id,
            new Error(
              "Übertragung unterbrochen. Erneute Freigabe setzt am gespeicherten Bestand fort.",
            ),
          );
      this.incoming.delete(remote.id);
    });
    channel.addEventListener("message", ({ data }) => {
      // Keep control and file processing separate; a sender waiting for backpressure must not block receipts.
      const key = `${remote.id}/${channel.label}`;
      const next = (this.chains.get(key) ?? Promise.resolve())
        .then(() =>
          channel.label === "localtake-control"
            ? this.onControl(remote, data)
            : this.onFile(remote, data),
        )
        .catch((error) => {
          for (const transfer of this.transfers.values())
            if (
              transfer.peerId === remote.id &&
              !["done", "error"].includes(transfer.state)
            )
              this.error(transfer.id, error);
          this.incoming.delete(remote.id);
        });
      this.chains.set(key, next);
    });
  }
  async offer(peerId: string, inventory: Inventory, store: LocalStore) {
    if (
      (inventory as StoredInventory).archive ||
      (inventory as StoredInventory).transferredTo
    )
      throw new Error(
        "Originale sind bereits im Cutter-Ordner oder beim Master gesichert.",
      );
    const remote = this.mesh.remotes.get(peerId);
    if (!remote) throw new Error("Empfänger nicht verbunden.");
    const releaseOriginals = await holdOriginals(inventory.recording);
    try {
      const files: Entry[] = [];
      const add = async (path: string) => {
        const bytes = await store.fileBytes(inventory.recording, path);
        files.push(
          fileEntrySchema.parse({
            path,
            bytes: bytes.byteLength,
            hash: await sha256(bytes),
          }),
        );
      };
      await add("recording.json");
      for (const track of inventory.tracks) {
        const path = `tracks/${track.trackId}`;
        if (!files.some((f) => f.path === `${path}/track.json`))
          await add(`${path}/track.json`);
        await add(`${path}/${track.epochId}/epoch.json`);
      }
      for (const file of await store.auxiliary(inventory.recording))
        await add(file.path);
      for (const segment of inventory.segments) {
        const path = `tracks/${segment.trackId}/${segment.epochId}/${segment.fileName}`;
        files.push(
          fileEntrySchema.parse({
            path,
            bytes: segment.byteLength,
            hash: segment.sha256,
          }),
        );
        await add(path.replace(/\.(mp4|wav)$/, ".segment.json"));
      }
      try {
        await add("completion.json");
      } catch (error) {
        if ((error as DOMException).name !== "NotFoundError") throw error;
      }
      // Completed attempts have durable receipts in the sender's folder. Bound
      // the in-memory history without making long sessions hit the offer limit.
      if (this.transfers.size >= 80)
        for (const [id, item] of this.transfers)
          if (["done", "error"].includes(item.state)) this.transfers.delete(id);
      const transfer: Transfer = {
        id: crypto.randomUUID(),
        peerId,
        recording: inventory.recording,
        files,
        count: files.length,
        total: files.reduce((n, f) => n + f.bytes, 0),
        bytes: 0,
        completeRecording: inventory.complete,
        direction: "send",
        state: "offered",
        index: 0,
        releaseOriginals,
      };
      this.transfers.set(transfer.id, transfer);
      this.sendingStore.set(transfer.id, store);
      this.changed();
      this.control(remote, {
        type: "offer",
        id: transfer.id,
        recording: transfer.recording,
        count: transfer.count,
        total: transfer.total,
        complete: inventory.complete,
      });
      for (let i = 0; i < files.length; i += 8) {
        await this.drain(remote.control!);
        this.control(remote, {
          type: "page",
          id: transfer.id,
          files: files.slice(i, i + 8),
        });
      }
      this.control(remote, { type: "offer-end", id: transfer.id });
      return transfer;
    } catch (error) {
      releaseOriginals();
      throw error;
    }
  }
  private async onControl(remote: Remote, data: unknown) {
    if (typeof data !== "string" || data.length > 16_384)
      throw new Error("Ungültige Transfernachricht.");
    const message = controlSchema.parse(JSON.parse(data));
    if (message.type === "offer") {
      const active = [...this.transfers.values()].filter(
        (t) =>
          t.peerId === remote.id &&
          t.direction === "receive" &&
          !["done", "error"].includes(t.state),
      );
      if (active.length >= 3 || this.transfers.size >= 100)
        throw new Error("Zu viele Übernahmeangebote.");
      if (this.transfers.has(message.id))
        throw new Error("Doppelte Transferidentität.");
      this.transfers.set(message.id, {
        ...message,
        peerId: remote.id,
        files: [],
        bytes: 0,
        direction: "receive",
        state: "offering",
        completeRecording: message.complete,
        index: 0,
      });
      this.changed();
      return;
    }
    const transfer = this.transfers.get(message.id);
    if (!transfer || transfer.peerId !== remote.id)
      throw new Error("Transfer ist nicht freigegeben.");
    if (message.type === "page") {
      if (
        transfer.direction !== "receive" ||
        transfer.state !== "offering" ||
        transfer.files.length + message.files.length > transfer.count
      )
        throw new Error("Ungültiges Dateiinventar.");
      transfer.files.push(...message.files);
      return;
    }
    if (message.type === "offer-end") {
      if (
        transfer.direction !== "receive" ||
        transfer.state !== "offering" ||
        transfer.files.length !== transfer.count ||
        transfer.files.reduce((n, f) => n + f.bytes, 0) !== transfer.total ||
        new Set(transfer.files.map((f) => f.path)).size !== transfer.count
      )
        throw new Error("Unvollständiges Dateiinventar.");
      transfer.state = "offered";
      this.changed();
      this.dispatchEvent(new CustomEvent("offered", { detail: transfer }));
      return;
    }
    if (message.type === "cancel") {
      this.error(transfer.id, message.reason, false);
      return;
    }
    if (transfer.state === "error") return;
    if (message.type === "get") {
      if (
        transfer.direction !== "send" ||
        message.index >= transfer.files.length ||
        transfer.state === "done"
      )
        throw new Error("Dateianfrage nicht erlaubt.");
      if (this.serving.has(remote.id))
        throw new Error("Eine Datei wird bereits übertragen.");
      this.serving.add(remote.id);
      // Never block the control channel while paused: CANCEL/receipts must remain deliverable.
      void this.sendFile(remote, transfer, message.index)
        .catch((error) => {
          this.error(transfer.id, error);
        })
        .finally(() => this.serving.delete(remote.id));
      return;
    }
    if (message.type === "stored") {
      const file = transfer.files[message.index];
      if (transfer.direction !== "send" || !file || file.hash !== message.hash)
        throw new Error("Ungültige Empfangsbestätigung.");
      if (!this.receipts.has(transfer.id))
        this.receipts.set(transfer.id, new Set());
      this.receipts.get(transfer.id)!.add(message.index);
      transfer.index = Math.max(transfer.index, message.index + 1);
      transfer.bytes = transfer.files
        .slice(0, transfer.index)
        .reduce((n, f) => n + f.bytes, 0);
      this.changed();
      return;
    }
    if (message.type === "complete") {
      if (
        transfer.direction !== "send" ||
        this.receipts.get(transfer.id)?.size !== transfer.count
      )
        throw new Error("Abschluss ohne vollständige Speicherbestätigungen.");
      transfer.state = "done";
      transfer.bytes = transfer.total;
      this.sendingStore.delete(transfer.id);
      this.receipts.delete(transfer.id);
      transfer.releaseOriginals?.();
      this.changed();
      this.dispatchEvent(new CustomEvent("sent", { detail: transfer }));
    }
  }
  async accept(id: string, store: LocalStore) {
    const transfer = this.transfers.get(id);
    if (
      !transfer ||
      transfer.direction !== "receive" ||
      transfer.state !== "offered"
    )
      throw new Error("Angebot ist nicht bereit.");
    if (
      [...this.transfers.values()].some(
        (t) =>
          t.direction === "receive" &&
          ["transferring", "paused", "verifying"].includes(t.state),
      )
    )
      throw new Error("Zuerst die laufende Übernahme abschließen.");
    this.receivingStore.set(id, store);
    transfer.state = "verifying";
    this.changed();
    try {
      transfer.releaseOriginals = await holdOriginals(transfer.recording);
      await store.preflight();
      const archived = await store.catalogFor(transfer.recording);
      if (
        archived?.type === "archive" &&
        archived.inventory.complete &&
        transfer.completeRecording &&
        transfer.files.length === archived.originals.length &&
        transfer.files.every((f) =>
          archived.originals.some(
            (o) =>
              o.path === f.path && o.bytes === f.bytes && o.hash === f.hash,
          ),
        )
      ) {
        const remote = this.mesh.remotes.get(transfer.peerId)!;
        // Retry after the guest missed the final ACK: verified cutter files
        // prove the originals without recreating already-cleared staging data.
        for (let index = 0; index < transfer.files.length; index++) {
          await this.drain(remote.control!);
          this.control(remote, {
            type: "stored",
            id,
            index,
            hash: transfer.files[index].hash,
          });
        }
        this.control(remote, { type: "complete", id });
        transfer.state = "done";
        transfer.bytes = transfer.total;
        this.receivingStore.delete(id);
        transfer.releaseOriginals?.();
        this.changed();
        this.dispatchEvent(new Event("received"));
        return;
      }
      await this.next(transfer);
    } catch (error) {
      this.error(id, error);
      throw error;
    }
  }
  cancel(id: string) {
    this.error(
      id,
      "Übernahme angehalten. Gespeicherter Bestand bleibt erhalten.",
    );
  }
  private async next(transfer: Transfer) {
    const store = this.receivingStore.get(transfer.id)!,
      remote = this.mesh.remotes.get(transfer.peerId)!;
    while (
      transfer.index < transfer.files.length &&
      transfer.state !== "error"
    ) {
      const item = transfer.files[transfer.index];
      try {
        const bytes = await store.fileBytes(transfer.recording, item.path);
        if (bytes.byteLength === 0)
          throw new DOMException(
            "Uncommitted empty placeholder",
            "NotFoundError",
          );
        if (
          bytes.byteLength !== item.bytes ||
          (await sha256(bytes)) !== item.hash
        )
          throw new Error(
            `Dateikonflikt: ${item.path}. Bitte anderen Empfangsordner wählen; Original bleibt erhalten.`,
          );
        if ((transfer.state as Transfer["state"]) === "error") return;
        this.control(remote, {
          type: "stored",
          id: transfer.id,
          index: transfer.index,
          hash: item.hash,
        });
        transfer.bytes += item.bytes;
        transfer.index++;
        this.changed();
        continue;
      } catch (error) {
        if ((error as DOMException).name !== "NotFoundError") throw error;
      }
      if ((transfer.state as Transfer["state"]) === "error") return;
      transfer.state = this.canTransfer(remote.id) ? "transferring" : "paused";
      this.changed();
      this.control(remote, {
        type: "get",
        id: transfer.id,
        index: transfer.index,
      });
      return;
    }
    if (transfer.state === "error") return;
    transfer.state = "verifying";
    this.changed();
    // A complete byte inventory is distinct from an originally partial recording.
    const inventory = await store.scan(
      transfer.recording.recordingId,
      transfer.recording.participantId,
    );
    if (transfer.completeRecording && !inventory.complete)
      throw new Error(
        `Empfangener Bestand ist noch nicht vollständig: ${inventory.issues.join(" · ")}`,
      );
    if ((transfer.state as Transfer["state"]) === "error") return;
    transfer.state = "done";
    this.control(remote, { type: "complete", id: transfer.id });
    this.receivingStore.delete(transfer.id);
    transfer.releaseOriginals?.();
    this.changed();
    this.dispatchEvent(new Event("received"));
  }
  private async allowed(transfer: Transfer, remote: Remote) {
    while (!this.canTransfer(remote.id)) {
      if (transfer.state === "error" || remote.files?.readyState !== "open")
        throw new Error("Übertragung unterbrochen.");
      if (transfer.state !== "paused") {
        transfer.state = "paused";
        this.changed();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (transfer.state === "error") throw new Error("Übertragung angehalten.");
    if (transfer.state !== "transferring") {
      transfer.state = "transferring";
      this.changed();
    }
  }
  private async drain(channel: RTCDataChannel) {
    if (channel.readyState !== "open")
      throw new Error("Dateikanal geschlossen.");
    if (channel.bufferedAmount < 512 * 1024) return;
    channel.bufferedAmountLowThreshold = 128 * 1024;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", low);
        channel.removeEventListener("close", close);
      };
      const low = () => {
          cleanup();
          resolve();
        },
        close = () => {
          cleanup();
          reject(new Error("Dateikanal geschlossen."));
        };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Dateikanal antwortet nicht."));
      }, 15_000);
      channel.addEventListener("bufferedamountlow", low);
      channel.addEventListener("close", close);
    });
  }
  private async sendFile(remote: Remote, transfer: Transfer, index: number) {
    const channel = remote.files;
    if (!channel || channel.readyState !== "open")
      throw new Error("Dateikanal nicht bereit.");
    await this.allowed(transfer, remote);
    const item = transfer.files[index],
      bytes = await this.sendingStore
        .get(transfer.id)!
        .fileBytes(transfer.recording, item.path);
    if (bytes.byteLength !== item.bytes || (await sha256(bytes)) !== item.hash)
      throw new Error("Quelldatei hat sich geändert.");
    await this.drain(channel);
    channel.send(JSON.stringify({ type: "begin", id: transfer.id, index }));
    const limit = Math.min(16_384, remote.pc.sctp?.maxMessageSize || 16_384);
    for (let offset = 0; offset < bytes.byteLength; offset += limit) {
      await this.allowed(transfer, remote);
      await this.drain(channel);
      channel.send(bytes.slice(offset, offset + limit));
      const rate = this.bytesPerSecond();
      if (rate > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, (limit / rate) * 1000),
        );
    }
    await this.drain(channel);
    channel.send(JSON.stringify({ type: "end", id: transfer.id, index }));
  }
  private async onFile(remote: Remote, data: unknown) {
    if (typeof data === "string") {
      if (data.length > 1024) throw new Error("Dateimarker zu groß.");
      const marker = z
        .object({
          type: z.enum(["begin", "end"]),
          id: idSchema,
          index: z.number().int().nonnegative(),
        })
        .parse(JSON.parse(data));
      const transfer = this.transfers.get(marker.id);
      if (
        !transfer ||
        transfer.direction !== "receive" ||
        transfer.peerId !== remote.id ||
        !this.receivingStore.has(marker.id) ||
        transfer.index !== marker.index ||
        transfer.state === "error"
      )
        throw new Error("Dateiübernahme nicht freigegeben.");
      if (marker.type === "begin") {
        if (this.incoming.has(remote.id))
          throw new Error("Überlappende Dateiübertragung.");
        this.incoming.set(remote.id, {
          id: marker.id,
          index: marker.index,
          parts: [],
          bytes: 0,
        });
        return;
      }
      const incoming = this.incoming.get(remote.id),
        entry = transfer.files[marker.index];
      if (
        !incoming ||
        incoming.id !== marker.id ||
        incoming.index !== marker.index ||
        incoming.bytes !== entry.bytes
      )
        throw new Error("Datei ist unvollständig.");
      const buffer = new Uint8Array(incoming.bytes);
      let offset = 0;
      for (const part of incoming.parts) {
        buffer.set(new Uint8Array(part), offset);
        offset += part.byteLength;
      }
      this.incoming.delete(remote.id);
      transfer.state = "verifying";
      this.changed();
      await this.receivingStore
        .get(marker.id)!
        .receive(transfer.recording, entry.path, buffer.buffer, entry.hash);
      if ((transfer.state as Transfer["state"]) === "error") return;
      this.control(remote, {
        type: "stored",
        id: marker.id,
        index: marker.index,
        hash: entry.hash,
      });
      transfer.bytes += entry.bytes;
      transfer.index++;
      await this.next(transfer);
      return;
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength > 16_384)
      throw new Error("Ungültiger Dateiblock.");
    const incoming = this.incoming.get(remote.id);
    if (!incoming) throw new Error("Dateiblock ohne Anfang.");
    const transfer = this.transfers.get(incoming.id)!;
    incoming.bytes += data.byteLength;
    if (incoming.bytes > transfer.files[incoming.index].bytes)
      throw new Error("Datei überschreitet die freigegebene Größe.");
    incoming.parts.push(data);
  }
}
