// TypeScript client for the BitPoker relay wire protocol (poker-relayd) — the
// browser port of bitpoker/wasm/host/relay_client.js: the 11-byte big-endian
// frame header, the protobuf ClientHello, and an awaitable inbound frame queue
// over a standard WebSocket. Zero dependencies.
//
// Auth: the dev relay-direct flow sends unsigned-dev hellos (the default when
// connect() gets no authScheme); chain sessions pass authScheme
// "cosmos-signature-v1" with a signature obtained via the background
// BitpokerSignPayloadMsg (see controller.joinChain).
import { PEER_SILENCE_MS } from "./session-timing";

export enum RelayType {
  ClientHello = 1,
  // Frame 2 carries the per-session hello the two seats exchange to agree on
  // order and stake (relay_protocol.hpp RelayMessageType). It used to carry a
  // free-form match announcement; the wire value did not change when the
  // gamecore moved to the session-hello handshake.
  SessionHello = 2,
  MatchResult = 3,
  OpenStream = 4,
  StreamData = 5,
  Settlement = 6,
  ChatMessage = 7,
  // Reserved, not sent: the chain pays the relay fee at settlement, so no
  // client produces a reward receipt any more. The relay still recognises the
  // type in order to drop frames from clients that predate that change.
  Receipt = 8,
  SessionResume = 9,
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

// --- SessionResume (relay.proto): field 1 = the sender's inbound high-water,
// field 2 = "this is the reply", so an answer is not answered again. ----------
export function encodeSessionResume(
  lastReceivedStreamSeq: number,
  reply: boolean
): Uint8Array {
  const out: number[] = [];
  pushUint64(out, 1, lastReceivedStreamSeq);
  if (reply) {
    pushVarint(out, (2 << 3) | 0);
    pushVarint(out, 1);
  }
  return new Uint8Array(out);
}

export function decodeSessionResume(payload: Uint8Array): {
  lastReceivedStreamSeq: number;
  reply: boolean;
} {
  const resume = { lastReceivedStreamSeq: 0, reply: false };
  let offset = 0;
  // Plain numbers, not BigInt: the extension compiles this package below
  // ES2020, and a stream sequence is a uint32 -- far inside 2^53.
  const readVarint = (): number => {
    let value = 0;
    let scale = 1;
    while (offset < payload.length) {
      const byte = payload[offset++];
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        break;
      }
      scale *= 128;
    }
    return value;
  };
  while (offset < payload.length) {
    const tag = readVarint();
    if ((tag & 0x07) !== 0) {
      return resume; // only varint fields are defined
    }
    const value = readVarint();
    if (tag >> 3 === 1) {
      resume.lastReceivedStreamSeq = value;
    } else if (tag >> 3 === 2) {
      resume.reply = value !== 0;
    }
  }
  return resume;
}

// What a replacement connection has to inherit from the one it replaces. The
// stream numbering belongs to the SESSION, not to a socket: see sendStream.
export interface RelayStreamState {
  sendSeq: number;
  sentFrames: { seq: number; payload: Uint8Array }[];
  lastReceivedSeq: number;
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
  // Mid-game resume state (SessionResume in relay.proto), as the native client
  // keeps it (relay_session_services.cpp RelayGameTransport).
  protected sendStreamSeq = 0;
  protected sentStreamFrames: { seq: number; payload: Uint8Array }[] = [];
  protected lastReceivedStreamSeq = 0;
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
  sendSessionHello(packedHello: Uint8Array): void {
    this.sendFrame(RelayType.SessionHello, packedHello);
  }
  // Game frames carry their OWN sequence -- 1, 2, 3, ... with no gaps -- in the
  // frame header, and are retained so a peer that lost some can be caught up.
  //
  // It used to be the connection's one request counter, shared with the
  // ClientHello and the SessionHello, so the first game frame went out as 3 or
  // 4. That was harmless while a native peer only dropped what was at or below
  // its high-water mark. Since it accepts exactly last+1 (so that a relay
  // injecting one huge sequence cannot starve the session), it waits for a
  // frame 1 that never comes and discards every game frame this client sends:
  // no hand between a browser and a native peer could start at all, and each
  // one ended as a dispute over a peer that "went quiet".
  sendStream(packedGameFrame: Uint8Array): void {
    if (!this.ws) {
      throw new Error("relay is not connected");
    }
    const seq = ++this.sendStreamSeq;
    this.sentStreamFrames.push({ seq, payload: packedGameFrame });
    this.ws.send(packRelayFrame(RelayType.StreamData, seq, packedGameFrame));
  }

  // The numbering and the retained frames outlive a socket: a replacement
  // connection that restarted at 1, or carried on past frames the peer never
  // got, is a gap the peer can only answer by dropping everything after it.
  get streamState(): RelayStreamState {
    return {
      sendSeq: this.sendStreamSeq,
      sentFrames: this.sentStreamFrames,
      lastReceivedSeq: this.lastReceivedStreamSeq,
    };
  }

  // Call before connect().
  restoreStreamState(state: RelayStreamState): void {
    this.sendStreamSeq = state.sendSeq;
    this.sentStreamFrames = state.sentFrames;
    this.lastReceivedStreamSeq = state.lastReceivedSeq;
  }

  // After a reconnect: tell the peer how far our inbound stream got, so it
  // retransmits the rest -- and, in its reply, tells us how far ITS got, which
  // handleSessionResume answers with ours. Until that exchange has happened a
  // frame sent on the new socket may sit behind a gap and be dropped; the
  // retransmission that follows delivers it again in order.
  requestResume(): void {
    this.sendFrame(
      RelayType.SessionResume,
      encodeSessionResume(this.lastReceivedStreamSeq, false)
    );
  }

  protected handleSessionResume(payload: Uint8Array): void {
    const resume = decodeSessionResume(payload);
    for (const sent of this.sentStreamFrames) {
      if (sent.seq > resume.lastReceivedStreamSeq && this.ws) {
        this.ws.send(
          packRelayFrame(RelayType.StreamData, sent.seq, sent.payload)
        );
      }
    }
    if (!resume.reply) {
      this.sendFrame(
        RelayType.SessionResume,
        encodeSessionResume(this.lastReceivedStreamSeq, true)
      );
    }
  }

  // Resolves with the next inbound frame, or null on close/timeout.
  //
  // The default is the peer-silence budget rather than a round number: a
  // caller that treats this timeout as "the peer is gone" and picks its own
  // shorter value is how a thinking opponent used to get disputed. Pass
  // something smaller only where a null result is not read as a disconnect.
  //
  // Resume bookkeeping happens here rather than in callers: a SessionResume is
  // answered and consumed, and a game frame at or below the inbound high-water
  // is a retransmission the game has already seen.
  async nextFrame(timeoutMs = PEER_SILENCE_MS): Promise<RelayFrame | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = await this.nextRawFrame(Math.max(0, deadline - Date.now()));
      if (!frame) {
        return null;
      }
      if (frame.type === RelayType.SessionResume) {
        this.handleSessionResume(frame.payload);
        continue;
      }
      if (frame.type === RelayType.StreamData && frame.requestId !== 0) {
        if (frame.requestId <= this.lastReceivedStreamSeq) {
          continue;
        }
        this.lastReceivedStreamSeq = frame.requestId;
      }
      return frame;
    }
  }

  protected nextRawFrame(timeoutMs: number): Promise<RelayFrame | null> {
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
