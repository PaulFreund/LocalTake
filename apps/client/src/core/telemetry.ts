import type { Credentials } from "../../../../packages/protocol/src/index.js";
import {
  compactDiagnostic,
  TELEMETRY_BODY_BYTES,
  TELEMETRY_INTERVAL_MS,
  TELEMETRY_MIN_INTERVAL_MS,
  TELEMETRY_MAX_EVENTS,
  type TelemetryBatch,
  type TelemetryEvent,
} from "../../../../packages/protocol/src/telemetry.js";
import type { DiagnosticLog } from "./diagnostics.js";

type Context = { credentials: Credentials | null; enabled: boolean };
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

export class TelemetryUploader {
  readonly pageId = crypto.randomUUID();
  private queue: TelemetryEvent[] = [];
  private dropped = 0;
  private sequence = 0;
  private identity = "";
  private generation = 0;
  private pending: { batch: TelemetryBatch; body: string } | null = null;
  private controller: AbortController | null = null;
  private failures = 0;
  private nextAt = 0;
  private lastAcceptedAt: string | null = null;
  private lastError: string | null = null;
  private disposed = false;
  private timer: ReturnType<typeof setInterval>;
  private urgent?: ReturnType<typeof setTimeout>;
  private readonly onEntry = (event: Event) => {
    this.refresh();
    if (!this.identity) return;
    const entry = (event as CustomEvent<TelemetryEvent>).detail;
    this.queue.push(entry);
    if (this.queue.length > 128) {
      this.queue.shift();
      this.dropped++;
    }
    if (
      /error|failed|timeout|closed|rejected|unreachable|offline|started|stopping|finished/.test(
        entry.event,
      )
    )
      this.scheduleSoon();
  };
  constructor(
    private readonly log: DiagnosticLog,
    private readonly context: () => Context,
    private readonly sample: () => unknown,
    private readonly request: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {
    log.addEventListener("entry", this.onEntry);
    this.timer = setInterval(() => {
      this.refresh();
      void this.flush();
    }, TELEMETRY_INTERVAL_MS);
  }
  refresh() {
    if (this.disposed) return;
    const context = this.context();
    const identity =
      context.enabled && context.credentials
        ? `${context.credentials.roomId}/${context.credentials.participantId}`
        : "";
    if (identity === this.identity) return;
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    clearTimeout(this.urgent);
    this.urgent = undefined;
    this.identity = identity;
    this.queue = [];
    this.pending = null;
    this.failures = 0;
    this.nextAt = 0;
    this.lastAcceptedAt = null;
    this.lastError = null;
    if (identity) {
      this.queue.push({
        at: new Date().toISOString(),
        elapsedMs: Math.round(performance.now()),
        scope: "app",
        event: "telemetry.started",
      });
      this.nextAt = Date.now() + TELEMETRY_MIN_INTERVAL_MS;
      this.scheduleSoon();
    }
  }
  status() {
    return {
      enabled: Boolean(this.identity),
      pageId: this.pageId,
      queued: this.queue.length + (this.pending?.batch.events.length ?? 0),
      dropped: this.dropped,
      sending: Boolean(this.controller),
      failures: this.failures,
      lastAcceptedAt: this.lastAcceptedAt,
      lastError: this.lastError,
      nextAttemptAt: this.nextAt ? new Date(this.nextAt).toISOString() : null,
      intervalSeconds: TELEMETRY_INTERVAL_MS / 1000,
    };
  }
  private scheduleSoon() {
    if (this.urgent || !this.identity || this.disposed) return;
    this.urgent = setTimeout(
      () => {
        this.urgent = undefined;
        void this.flush();
      },
      Math.max(TELEMETRY_MIN_INTERVAL_MS, this.nextAt - Date.now()),
    );
  }
  private makeBatch() {
    const events = this.queue.splice(0, TELEMETRY_MAX_EVENTS);
    const batch: TelemetryBatch = {
      version: 1,
      pageId: this.pageId,
      sequence: ++this.sequence,
      dropped: this.dropped,
      events,
      sample: compactDiagnostic(this.sample()),
    };
    // Preserve events ahead of a large sample; never serialize more than 12 KiB
    // onto the network. The local report retains the detailed diagnostics.
    let body = JSON.stringify(batch);
    if (bytes(body) > TELEMETRY_BODY_BYTES) {
      batch.sample = { truncated: true };
      body = JSON.stringify(batch);
    }
    while (bytes(body) > TELEMETRY_BODY_BYTES && events.length > 1) {
      this.queue.unshift(events.pop()!);
      body = JSON.stringify(batch);
    }
    if (bytes(body) > TELEMETRY_BODY_BYTES) {
      this.dropped += events.length;
      batch.events = [];
      batch.dropped = this.dropped;
      body = JSON.stringify(batch);
    }
    return { batch, body };
  }
  async flush() {
    if (
      this.disposed ||
      !this.identity ||
      this.controller ||
      Date.now() < this.nextAt
    )
      return;
    const credentials = this.context().credentials;
    if (!credentials) return;
    const generation = this.generation;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      this.pending ??= this.makeBatch();
      const controller = new AbortController();
      this.controller = controller;
      this.nextAt = Date.now() + TELEMETRY_MIN_INTERVAL_MS;
      // Race also protects against a fetch implementation that ignores abort.
      const response = await Promise.race([
        this.request("/api/telemetry", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${credentials.token}`,
          },
          body: this.pending.body,
          signal: controller.signal,
          cache: "no-store",
          credentials: "same-origin",
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Zeitlimit beim Diagnoseversand"));
          }, 3000);
        }),
      ]);
      if (generation !== this.generation) return;
      if (!response.ok) throw new Error(`Diagnose-HTTP ${response.status}`);
      const result = await Promise.race([
        response.json() as Promise<{ accepted?: boolean }>,
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("Zeitlimit beim Diagnoseversand")),
            { once: true },
          ),
        ),
      ]);
      if (generation !== this.generation) return;
      if (!result.accepted)
        throw new Error(
          "Server verwirft Diagnose wegen Auslastung oder Speicherfehler",
        );
      this.pending = null;
      this.failures = 0;
      this.lastError = null;
      this.lastAcceptedAt = new Date().toISOString();
      if (this.queue.length) this.scheduleSoon();
    } catch (error) {
      if (generation !== this.generation) return;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.failures++;
      this.nextAt =
        Date.now() +
        Math.min(
          300_000,
          TELEMETRY_MIN_INTERVAL_MS * 2 ** Math.min(6, this.failures),
        );
      // At most two retries per batch; newer evidence must not wait forever.
      if (this.failures >= 3 && this.pending) {
        this.dropped += this.pending.batch.events.length;
        this.pending = null;
      }
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) this.controller = null;
    }
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    clearInterval(this.timer);
    clearTimeout(this.urgent);
    this.controller?.abort();
    this.log.removeEventListener("entry", this.onEntry);
    this.queue = [];
    this.pending = null;
  }
}
