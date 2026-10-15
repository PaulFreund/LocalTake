import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type Credentials,
  type RoomState,
  type ServerMessage,
} from "../../../../packages/protocol/src/index.js";
import { SessionClock } from "../core/clock.js";
import { rememberRoom } from "./session-link.js";

export class RoomClient extends EventTarget {
  readonly clock = new SessionClock();
  state: RoomState | null = null;
  connected = false;
  credentials: Credentials | null = null;
  telemetryEnabled = false;
  private socket: WebSocket | null = null;
  private retry = 0;
  private closed = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private clockTimer?: ReturnType<typeof setInterval>;
  private name = "";
  private requestRevision = 0;
  private lastMessageAt: string | null = null;
  private lastWelcomeAt: string | null = null;
  private lastClose: {
    at: string;
    code: number;
    reason: string;
    wasClean: boolean;
  } | null = null;
  private diagnostic(event: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent("diagnostic", { detail: { event, detail } }),
    );
  }
  diagnosticState() {
    const states = ["connecting", "open", "closing", "closed"];
    return {
      authenticated: this.connected,
      socket: this.socket ? states[this.socket.readyState] : "none",
      reconnectEnabled: !this.closed,
      reconnectAttempts: this.retry,
      lastMessageAt: this.lastMessageAt,
      lastWelcomeAt: this.lastWelcomeAt,
      lastClose: this.lastClose,
    };
  }
  private notify() {
    this.dispatchEvent(new Event("change"));
  }
  async create(name: string, roomName: string) {
    const revision = ++this.requestRevision;
    const credentials = await this.request(
      "/api/rooms",
      { name, roomName },
      revision,
    );
    this.checkRequest(revision);
    this.join(credentials, name);
    return credentials;
  }
  async accept(inviteToken: string, name: string, expectedRoomId?: string) {
    const revision = ++this.requestRevision;
    const credentials = await this.request(
      "/api/rooms/join",
      {
        inviteToken,
        name,
      },
      revision,
    );
    this.checkRequest(revision);
    if (expectedRoomId && credentials.roomId !== expectedRoomId)
      throw new Error("Die Einladung gehört nicht zum Raum in diesem Link.");
    this.join(credentials, name);
    return credentials;
  }
  private checkRequest(revision: number) {
    if (revision !== this.requestRevision)
      throw new DOMException("Raumwechsel wurde ersetzt.", "AbortError");
  }
  private async request(
    url: string,
    body: unknown,
    revision: number,
  ): Promise<Credentials> {
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        this.diagnostic("api.unreachable", { path: url });
        throw new Error(
          "Koordinationsdienst nicht erreichbar. Lokale Aufnahme und Archiv können unabhängig davon verwendet werden.",
        );
      }
      const data = await response.json();
      this.diagnostic("api.response", { path: url, status: response.status });
      if (!response.ok)
        throw new Error(data.error || "Verbindung fehlgeschlagen.");
      return data;
    } finally {
      this.checkRequest(revision);
    }
  }
  join(credentials: Credentials, name: string) {
    this.leave();
    this.credentials = credentials;
    this.telemetryEnabled = credentials.telemetry?.enabled ?? false;
    this.name = name;
    this.closed = false;
    this.retry = 0;
    rememberRoom({ credentials, name });
    this.connect();
  }
  private connect() {
    if (this.closed || !this.credentials) return;
    const url = new URL("/ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const credentials = this.credentials;
    this.socket = socket;
    this.diagnostic("socket.connecting", { url: url.origin + url.pathname });
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.diagnostic("socket.open");
      this.send({
        type: "auth",
        version: PROTOCOL_VERSION,
        token: credentials.token,
        name: this.name,
      });
    };
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(data);
      } catch {
        this.diagnostic("message.invalid_json");
        return;
      }
      this.lastMessageAt = new Date().toISOString();
      if (message.type === "welcome") {
        this.lastWelcomeAt = this.lastMessageAt;
        this.telemetryEnabled = message.telemetry?.enabled ?? false;
        this.diagnostic("authenticated", {
          participantId: message.participantId,
        });
        this.connected = true;
        this.retry = 0;
        this.state = message.state;
        clearInterval(this.clockTimer);
        this.clockTimer = setInterval(() => this.probe(), 5000);
        this.probe();
        for (let i = 1; i < 5; i++)
          setTimeout(() => {
            if (this.socket === socket) this.probe();
          }, i * 150);
      }
      if (message.type === "room.state") this.state = message.state;
      if (message.type === "error")
        this.diagnostic("server.error", {
          code: message.code,
          message: message.message,
        });
      if (message.type === "clock.reply")
        this.clock.accept(
          message.t1,
          message.t2,
          message.t3,
          performance.now(),
          message.epoch,
        );
      this.dispatchEvent(new CustomEvent("message", { detail: message }));
      this.notify();
    };
    socket.onclose = ({ code, reason, wasClean }) => {
      if (this.socket !== socket) return;
      this.lastClose = { at: new Date().toISOString(), code, reason, wasClean };
      this.diagnostic("socket.closed", this.lastClose);
      this.connected = false;
      clearInterval(this.clockTimer);
      this.notify();
      if (code === 1008 || code === 4001) {
        this.closed = true;
        this.dispatchEvent(
          new CustomEvent("error", {
            detail:
              code === 4001
                ? "Diese Raumsitzung wurde in einem anderen Tab geöffnet. Lokale Aufnahme läuft weiter."
                : "Raumzugang abgelehnt. Einladung prüfen oder neuen Raum öffnen.",
          }),
        );
        return;
      }
      if (!this.closed)
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          Math.min(10_000, 500 * 2 ** this.retry++),
        );
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.diagnostic("socket.error");
      /* onclose schedules reconnect; recording is independent */
    };
  }
  private probe() {
    this.send({ type: "clock.probe", t1: performance.now() });
  }
  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      if (message.type !== "clock.probe")
        this.diagnostic("message.not_sent", { type: message.type });
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }
  leave() {
    this.requestRevision++;
    if (this.credentials) this.diagnostic("room.left");
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.clockTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.connected = false;
    this.state = null;
    this.credentials = null;
    this.telemetryEnabled = false;
    this.notify();
  }
}
