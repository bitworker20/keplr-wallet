// TypeScript client for the BitPoker relay wire protocol (poker-relayd) — the
// extension port of bitpoker/wasm/host/relay_client.js: the 11-byte big-endian
// frame header, the protobuf ClientHello, and an awaitable inbound frame queue
// over a standard WebSocket. Zero dependencies.
//
// Auth: the dev relay-direct flow sends unsigned-dev hellos (the default when
// connect() gets no authScheme); chain sessions pass authScheme
// "cosmos-signature-v1" with a signature obtained via the background
// BitpokerSignPayloadMsg (see controller.joinChain).

export enum RelayType {
  ClientHello = 1,
  MatchAnnouncement = 2,
  MatchResult = 3,
  OpenStream = 4,
  StreamData = 5,
  Settlement = 6,
  ChatMessage = 7,
  Receipt = 8,
  Error = 255,
}

const RELAY_PROTOCOL_VERSION = 1;
const RELAY_FRAME_HEADER_LENGTH = 11;

export interface RelayFrame {
  type: number;
  requestId: number;
  payload: Uint8Array;
}

// version(u8) | type(u16 BE) | request_id(u32 BE) | payload_length(u32 BE) | payload
export function packRelayFrame(
  type: number,
  requestId: number,
  payload?: Uint8Array
): Uint8Array {
  const body = payload ?? new Uint8Array(0);
  const out = new Uint8Array(RELAY_FRAME_HEADER_LENGTH + body.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, RELAY_PROTOCOL_VERSION);
  view.setUint16(1, type, false);
  view.setUint32(3, requestId >>> 0, false);
  view.setUint32(7, body.length, false);
  out.set(body, RELAY_FRAME_HEADER_LENGTH);
  return out;
}

export function unpackRelayFrame(bytes: Uint8Array): RelayFrame | null {
  if (bytes.length < RELAY_FRAME_HEADER_LENGTH) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== RELAY_PROTOCOL_VERSION) {
    return null;
  }
  const type = view.getUint16(1, false);
  const requestId = view.getUint32(3, false);
  const payloadLength = view.getUint32(7, false);
  if (RELAY_FRAME_HEADER_LENGTH + payloadLength !== bytes.length) {
    return null;
  }
  return { type, requestId, payload: bytes.slice(RELAY_FRAME_HEADER_LENGTH) };
}

// --- Minimal proto3 encoding for relay.proto's ClientHello -------------------
function pushVarint(out: number[], value: number | bigint): void {
  // BigInt without 2020+ literals (the tsconfig targets lower).
  const zero = BigInt(0);
  const low7 = BigInt(0x7f);
  const shift = BigInt(7);
  let v = BigInt(value);
  for (;;) {
    const byte = Number(v & low7);
    v >>= shift;
    if (v === zero) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}
function pushTag(out: number[], field: number, wireType: number): void {
  pushVarint(out, (field << 3) | wireType);
}
function pushString(out: number[], field: number, value?: string): void {
  if (!value) {
    return;
  }
  const bytes = new TextEncoder().encode(value);
  pushTag(out, field, 2);
  pushVarint(out, bytes.length);
  for (const b of bytes) {
    out.push(b);
  }
}
function pushUint64(
  out: number[],
  field: number,
  value?: number | string | bigint
): void {
  if (!value) {
    return;
  }
  pushTag(out, field, 0);
  pushVarint(out, typeof value === "string" ? BigInt(value) : value);
}

export interface ClientHelloFields {
  playerName: string;
  networkAddress: string;
  chainId: string;
  accountAddress: string;
  preferredRelayIds?: string[];
  timestampMillis?: number;
  nonce?: string;
  authScheme?: string;
  // cosmos-signature-v1: compressed_pubkey(33) || r || s over
  // sha256(buildClientHelloSigningPayload text) — see buildHelloSigningPayload.
  authPayload?: Uint8Array;
  sessionId: string | number;
  relayId: string;
  playerSessionPubkey: string;
}

// The exact text the relay verifies for the cosmos-signature-v1 auth scheme
// (relay_protocol.cpp buildClientHelloSigningPayload). timestampMillis and
// nonce must therefore be fixed BEFORE signing and passed unchanged into the
// hello fields.
export function buildHelloSigningPayload(hello: {
  chainId: string;
  accountAddress: string;
  networkAddress: string;
  sessionId: string | number;
  relayId: string;
  playerSessionPubkey: string;
  timestampMillis: number;
  nonce: string;
}): string {
  return (
    "bitpoker-relay-client-hello-v1\n" +
    `${hello.chainId}\n` +
    `${hello.accountAddress}\n` +
    `${hello.networkAddress}\n` +
    `${hello.sessionId}\n` +
    `${hello.relayId}\n` +
    `${hello.playerSessionPubkey}\n` +
    `${hello.timestampMillis}\n` +
    `${hello.nonce}`
  );
}

export function encodeClientHello(hello: ClientHelloFields): Uint8Array {
  const out: number[] = [];
  pushString(out, 1, hello.playerName);
  pushString(out, 2, hello.networkAddress);
  pushString(out, 3, hello.chainId);
  pushString(out, 4, hello.accountAddress);
  for (const id of hello.preferredRelayIds ?? []) {
    pushString(out, 5, id);
  }
  pushUint64(out, 6, hello.timestampMillis ?? Date.now());
  pushString(
    out,
    7,
    hello.nonce ?? Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
  pushString(out, 8, hello.authScheme ?? "unsigned-dev");
  if (hello.authPayload && hello.authPayload.length > 0) {
    pushTag(out, 9, 2);
    pushVarint(out, hello.authPayload.length);
    for (const b of hello.authPayload) {
      out.push(b);
    }
  }
  pushUint64(out, 10, hello.sessionId);
  pushString(out, 11, hello.relayId);
  pushString(out, 12, hello.playerSessionPubkey);
  return new Uint8Array(out);
}

// --- WebSocket relay connection with an awaitable inbound frame queue --------
export class RelayClient {
  protected ws?: WebSocket;
  protected readonly queue: RelayFrame[] = [];
  protected waiters: Array<() => void> = [];
  protected requestId = 0;
  closed = false;

  constructor(
    public readonly url: string,
    // ADR-007 §3.2: offered subprotocols carrying the connect token
    // ("xpoker.relay.v1" + "xpoker.tok.<base64url>"). Undefined = legacy
    // handshake without subprotocols.
    protected readonly subprotocols?: string[]
  ) {}

  // Connects and authenticates: the ClientHello must be the first frame.
  async connect(hello: ClientHelloFields): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = this.subprotocols
        ? new WebSocket(this.url, this.subprotocols)
        : new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };
      ws.onerror = () =>
        reject(new Error(`relay websocket error: ${this.url}`));
      ws.onclose = () => {
        this.closed = true;
        this.wake();
      };
      ws.onmessage = (event: MessageEvent) => {
        const frame = unpackRelayFrame(new Uint8Array(event.data));
        if (frame) {
          this.queue.push(frame);
          this.wake();
        }
      };
    });
    this.sendFrame(RelayType.ClientHello, encodeClientHello(hello));
  }

  sendFrame(type: number, payload?: Uint8Array): void {
    if (!this.ws) {
      throw new Error("relay is not connected");
    }
    this.ws.send(packRelayFrame(type, ++this.requestId, payload));
  }
  sendAnnouncement(packedAnnouncement: Uint8Array): void {
    this.sendFrame(RelayType.MatchAnnouncement, packedAnnouncement);
  }
  sendStream(packedGameFrame: Uint8Array): void {
    this.sendFrame(RelayType.StreamData, packedGameFrame);
  }

  // Resolves with the next inbound frame, or null on close/timeout.
  nextFrame(timeoutMs = 30000): Promise<RelayFrame | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift() ?? null);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      const waiter = () => {
        clearTimeout(timer);
        resolve(this.queue.length > 0 ? this.queue.shift() ?? null : null);
      };
      this.waiters.push(waiter);
    });
  }

  protected wake(): void {
    while (this.waiters.length > 0 && (this.queue.length > 0 || this.closed)) {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter();
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
    }
    this.wake();
  }
}
