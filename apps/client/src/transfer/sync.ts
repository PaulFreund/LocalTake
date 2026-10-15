import type {
  Inventory,
  UploadStatus,
} from "../../../../packages/protocol/src/index.js";
import { inventoryFingerprint, type LocalStore } from "../storage/store.js";
import type { Transfer, TransferManager } from "./manager.js";

type Context = {
  roomId?: string;
  selfId?: string;
  destinationId?: string | null;
  store: LocalStore | null;
  library: Inventory[];
  canWork: boolean;
  destinationReady: boolean;
};
export type SyncItem = {
  inventory: Inventory;
  fingerprint: string;
  state: "waiting" | "uploading" | "done" | "error";
  transferId?: string;
  error?: string;
  retryAt: number;
};
export class AutomaticSync extends EventTarget {
  items: SyncItem[] = [];
  private contextKey = "";
  private running = false;
  private receiptWrites = new Set<string>();
  constructor(
    readonly transfer: TransferManager,
    readonly context: () => Context,
  ) {
    super();
    transfer.addEventListener("sent", (event) => {
      const value = (event as CustomEvent<Transfer>).detail;
      const item = this.items.find((i) => i.transferId === value.id);
      if (item)
        void this.finish(item, value).catch((error) => {
          item.state = "error";
          item.error = String(error);
          item.retryAt = Date.now() + 10_000;
          this.changed();
        });
    });
  }
  private changed() {
    this.dispatchEvent(new Event("change"));
  }
  async refresh() {
    const context = this.context();
    const key = `${context.roomId}/${context.selfId}/${context.destinationId}`;
    if (this.contextKey !== key) {
      for (const item of this.items) {
        const transfer = item.transferId
          ? this.transfer.transfers.get(item.transferId)
          : undefined;
        if (transfer && !["done", "error"].includes(transfer.state))
          this.transfer.cancel(transfer.id);
      }
      this.items = [];
      this.contextKey = key;
    }
    if (
      !context.store ||
      !context.roomId ||
      !context.selfId ||
      !context.destinationId ||
      context.destinationId === context.selfId
    ) {
      this.items = [];
      this.changed();
      return;
    }
    const items: SyncItem[] = [];
    for (const inventory of context.library) {
      if (
        inventory.recording.roomId !== context.roomId ||
        inventory.recording.purpose === "check" ||
        inventory.recording.participantId !== context.selfId ||
        !inventory.segments.length
      )
        continue;
      const fingerprint = await inventoryFingerprint(inventory);
      const previous = this.items.find((i) => i.fingerprint === fingerprint);
      const saved = await context.store.transferReceipt(
        inventory,
        context.destinationId,
        fingerprint,
      );
      items.push(
        saved
          ? { inventory, fingerprint, state: "done", retryAt: 0 }
          : (previous ?? {
              inventory,
              fingerprint,
              state: "waiting",
              retryAt: 0,
            }),
      );
    }
    if (this.contextKey !== key || this.context().store !== context.store)
      return;
    this.items = items;
    this.changed();
  }
  get status(): UploadStatus {
    const pending = this.items.filter((i) => i.state !== "done");
    let bytes = 0,
      total = 0;
    for (const item of this.items) {
      const size = item.inventory.segments.reduce(
        (n, s) => n + s.byteLength,
        0,
      );
      const transfer = item.transferId
        ? this.transfer.transfers.get(item.transferId)
        : undefined;
      total += transfer?.total ?? size;
      bytes +=
        item.state === "done"
          ? (transfer?.total ?? size)
          : (transfer?.bytes ?? 0);
    }
    const active = pending.some((i) => i.state === "uploading");
    const error = pending.find((i) => i.error);
    return {
      pending: pending.length,
      bytes,
      total,
      state: active
        ? "uploading"
        : error
          ? "error"
          : pending.length
            ? "waiting"
            : total
              ? "done"
              : "idle",
      reason:
        error?.error ??
        (pending.length
          ? this.context().destinationReady
            ? "Übertragung wird nach der Aufnahme fortgesetzt."
            : "Wartet auf Ziel-PC und freigegebenen Empfangsordner."
          : undefined),
    };
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const context = this.context();
      if (!context.canWork || !context.store || !context.destinationId) return;
      // Receive serially, across all senders, so disk and memory stay bounded.
      const receiving = [...this.transfer.transfers.values()].some(
        (t) =>
          t.direction === "receive" &&
          ["transferring", "paused", "verifying"].includes(t.state),
      );
      if (context.destinationId === context.selfId && !receiving) {
        const offer = [...this.transfer.transfers.values()].find(
          (t) =>
            t.direction === "receive" &&
            t.state === "offered" &&
            t.recording.roomId === context.roomId &&
            t.recording.participantId === t.peerId &&
            t.recording.purpose !== "check",
        );
        if (offer) await this.transfer.accept(offer.id, context.store);
      }
      for (const item of this.items) {
        const transfer = item.transferId
          ? this.transfer.transfers.get(item.transferId)
          : undefined;
        if (transfer?.state === "error" && item.state === "uploading") {
          item.state = "error";
          item.error = transfer.error;
          item.retryAt = Date.now() + 10_000;
          this.changed();
        }
        if (transfer?.state === "done" && item.state !== "done") {
          await this.finish(item, transfer);
          return;
        }
      }
      if (
        !context.destinationReady ||
        this.items.some((i) => i.state === "uploading")
      )
        return;
      const item = this.items.find(
        (i) => i.state !== "done" && i.retryAt <= Date.now(),
      );
      if (!item) return;
      item.state = "uploading";
      item.error = undefined;
      this.changed();
      try {
        const transfer = await this.transfer.offer(
          context.destinationId,
          item.inventory,
          context.store,
        );
        item.transferId = transfer.id;
      } catch (error) {
        item.state = "error";
        item.error = error instanceof Error ? error.message : String(error);
        item.retryAt = Date.now() + 10_000;
      }
      this.changed();
    } finally {
      this.running = false;
    }
  }
  private async finish(item: SyncItem, transfer: Transfer) {
    if (this.receiptWrites.has(transfer.id)) return;
    this.receiptWrites.add(transfer.id);
    try {
      const context = this.context();
      if (!context.store || transfer.peerId !== context.destinationId) return;
      await context.store.transferReceipt(
        item.inventory,
        transfer.peerId,
        item.fingerprint,
        true,
      );
      await context.store.retireTransferred(
        item.inventory,
        transfer.peerId,
        item.fingerprint,
      );
      if (item.inventory.complete)
        this.dispatchEvent(
          new CustomEvent("retired", {
            detail: {
              recording: item.inventory.recording,
              destinationId: transfer.peerId,
            },
          }),
        );
      item.state = "done";
      item.error = undefined;
      this.changed();
    } finally {
      this.receiptWrites.delete(transfer.id);
    }
  }
}
