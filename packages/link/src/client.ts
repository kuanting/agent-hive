import WebSocket from "ws";
import { BoxToCloud, CloudToBox, envelope, LINK_PROTOCOL_VERSION, type BoxToCloudBody } from "./protocol.js";

export interface LinkClientOptions {
  /** wss://<ibuddys>/hive-link/v1 */
  url: string;
  /** `hbx_<boxId>_<secret>`, from enrollment */
  token: string;
  /** what the box says about itself on every connect */
  hello: () => BoxToCloudBody<"link.hello">;
  onMessage: (msg: CloudToBox) => void;
  /** called after each successful handshake, so the owner can resend state */
  onConnected?: () => void;
  onDisconnected?: (why: string) => void;
  log?: (level: "debug" | "info" | "warn" | "error", text: string) => void;
}

const PING_EVERY_MS = 20_000;
const PONG_DEADLINE_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Messages kept while offline. Beyond this the oldest go; a reconnect resends live state anyway. */
const OUTBOX_MAX = 5_000;

/**
 * The box's end of the Hive Link: one outbound WebSocket, kept alive.
 *
 * Outbound because the box sits behind the company's firewall and must need no
 * inbound port; kept alive because it is the only way the cloud can reach the
 * box at all. A drop is routine, not an incident: the client backs off,
 * reconnects, and the owner (`link-bridge.ts`) resends a snapshot of live state
 * on every `onConnected`, which repairs anything lost while it was away.
 *
 * Task events queued while offline are coalesced per task. Each carries the
 * task's whole state, so only the newest one is worth delivering.
 */
export class LinkClient {
  private ws?: WebSocket;
  private stopped = false;
  private ready = false;
  private backoff = BACKOFF_MIN_MS;
  private pingTimer?: NodeJS.Timeout;
  private pongTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly outbox: BoxToCloud[] = [];

  constructor(private readonly opts: LinkClientOptions) {}

  get connected(): boolean {
    return this.ready;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.clearTimers();
    this.ws?.close(1000, "box stopping");
  }

  /** Send now if connected, else hold it for the next connection. */
  send<T extends BoxToCloud["type"]>(type: T, body: BoxToCloudBody<T>): void {
    const msg = envelope(type, body) as BoxToCloud;
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    // Hold it. Replies to the cloud's requests are useless after a reconnect
    // (the cloud failed the request when the socket dropped), so they are not
    // queued; everything else is.
    if (type === "chat.response" || type === "task.content" || type === "link.pong") return;
    if (type === "task.event") {
      const taskId = (body as BoxToCloudBody<"task.event">).task.taskId;
      const i = this.outbox.findIndex((m) => m.type === "task.event" && m.body.task.taskId === taskId);
      if (i >= 0) this.outbox.splice(i, 1);
    }
    this.outbox.push(msg);
    while (this.outbox.length > OUTBOX_MAX) this.outbox.shift();
  }

  private log(level: "debug" | "info" | "warn" | "error", text: string): void {
    this.opts.log?.(level, text);
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url, {
      headers: { authorization: `Bearer ${this.opts.token}` },
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on("open", () => {
      ws.send(JSON.stringify(envelope("link.hello", { ...this.opts.hello(), protocol: LINK_PROTOCOL_VERSION })));
      this.startPinging();
    });

    ws.on("message", (data) => {
      let parsed: CloudToBox;
      try {
        parsed = CloudToBox.parse(JSON.parse(String(data)));
      } catch (err) {
        this.log("warn", `link: ignoring a malformed message (${String(err).slice(0, 120)})`);
        return;
      }
      if (parsed.type === "link.welcome") {
        this.ready = true;
        this.backoff = BACKOFF_MIN_MS;
        this.log("info", `link: connected as box ${parsed.body.boxId}`);
        this.flush();
        this.opts.onConnected?.();
      }
      if (parsed.type === "link.ping") {
        this.send("link.pong", {});
        return;
      }
      this.opts.onMessage(parsed);
    });

    ws.on("pong", () => clearTimeout(this.pongTimer));

    ws.on("unexpected-response", (_req, res) => {
      // 401/403 means the box was revoked or its token is wrong: retrying fast
      // would just hammer the cloud, so back off to the ceiling.
      if (res.statusCode === 401 || res.statusCode === 403) this.backoff = BACKOFF_MAX_MS;
      this.log("warn", `link: refused by the cloud (HTTP ${res.statusCode})`);
    });

    ws.on("error", (err) => this.log("debug", `link: socket error ${String(err).slice(0, 160)}`));

    ws.on("close", (code, reason) => {
      const wasReady = this.ready;
      this.ready = false;
      this.clearTimers();
      if (wasReady) this.opts.onDisconnected?.(`${code} ${String(reason)}`.trim());
      if (this.stopped) return;
      const wait = Math.round(this.backoff * (0.75 + Math.random() * 0.5));
      this.log(wasReady ? "warn" : "debug", `link: disconnected (${code}), retrying in ${Math.round(wait / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
      this.reconnectTimer.unref?.();
      this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    });
  }

  private flush(): void {
    while (this.outbox.length && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(this.outbox.shift()));
    }
  }

  /** Protocol-level pings: a half-open TCP connection otherwise looks alive for minutes. */
  private startPinging(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        this.log("warn", "link: no pong, reconnecting");
        this.ws?.terminate();
      }, PONG_DEADLINE_MS);
    }, PING_EVERY_MS);
    this.pingTimer.unref?.();
  }

  private clearTimers(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }
}

/** Parse one message the cloud might send, for tests and tools. */
export function parseBoxMessage(raw: unknown): BoxToCloud {
  return BoxToCloud.parse(raw);
}
