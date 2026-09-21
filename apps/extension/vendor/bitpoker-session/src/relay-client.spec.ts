import {
  decodeSessionResume,
  encodeSessionResume,
  RelayClient,
  RelayType,
  unpackRelayFrame,
  packRelayFrame,
} from "./relay-client";

// The relay wire as a native peer sees it. These pin the one property the
// native transport insists on (relay_session_services.cpp acceptStreamFrame):
// game frames are numbered 1, 2, 3, ... with no gaps, whatever else the
// connection sends. The client used to number them from the connection's one
// request counter, after the two hellos, so a native peer waited for a frame 1
// that never came and no hand against a browser could start.

class FakeSocket {
  static last: FakeSocket;
  sent: Uint8Array[] = [];
  binaryType = "";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.();
  }
  deliver(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.slice().buffer });
  }
  frames(type: RelayType) {
    return this.sent
      .map((bytes) => unpackRelayFrame(bytes))
      .filter((frame) => frame?.type === type);
  }
}

const HELLO = {
  playerName: "tom",
  networkAddress: "test://tom",
  chainId: "test",
  accountAddress: "xpoker1tom",
  sessionId: 1,
  relayId: "relay-a",
  playerSessionPubkey: "00",
};

describe("RelayClient stream numbering", () => {
  const realWebSocket = globalThis.WebSocket;
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  it("numbers game frames 1, 2, 3 whatever the hellos took", async () => {
    const relay = new RelayClient("ws://relay");
    await relay.connect(HELLO);
    relay.sendSessionHello(new Uint8Array([1]));
    relay.sendSessionHello(new Uint8Array([1])); // a re-sent hello takes a number too
    relay.sendStream(new Uint8Array([10]));
    relay.sendStream(new Uint8Array([11]));

    const stream = FakeSocket.last.frames(RelayType.StreamData);
    expect(stream.map((frame) => frame?.requestId)).toEqual([1, 2]);
  });

  it("carries on without a gap on a replacement connection", async () => {
    const first = new RelayClient("ws://relay");
    await first.connect(HELLO);
    first.sendStream(new Uint8Array([10]));
    first.sendStream(new Uint8Array([11]));

    const second = new RelayClient("ws://relay");
    second.restoreStreamState(first.streamState);
    await second.connect(HELLO); // the new ClientHello must not take a stream number
    second.sendStream(new Uint8Array([12]));

    const stream = FakeSocket.last.frames(RelayType.StreamData);
    expect(stream.map((frame) => frame?.requestId)).toEqual([3]);
  });

  it("retransmits what the peer is missing, in order, and answers once", async () => {
    const relay = new RelayClient("ws://relay");
    await relay.connect(HELLO);
    for (const byte of [10, 11, 12]) {
      relay.sendStream(new Uint8Array([byte]));
    }
    const socket = FakeSocket.last;
    socket.sent = [];

    // The peer got frame 1 and nothing after it.
    socket.deliver(
      packRelayFrame(RelayType.SessionResume, 7, encodeSessionResume(1, false))
    );
    socket.deliver(
      packRelayFrame(RelayType.StreamData, 1, new Uint8Array([99]))
    );
    const next = await relay.nextFrame(1000);

    // The resume was consumed, not handed to the game.
    expect(next?.type).toBe(RelayType.StreamData);
    const stream = socket.frames(RelayType.StreamData);
    expect(stream.map((frame) => frame?.requestId)).toEqual([2, 3]);
    expect(stream.map((frame) => frame?.payload[0])).toEqual([11, 12]);
    const replies = socket.frames(RelayType.SessionResume);
    expect(replies).toHaveLength(1);
    expect(decodeSessionResume(replies[0]!.payload)).toEqual({
      lastReceivedStreamSeq: 0,
      reply: true,
    });
  });

  it("does not answer a reply, and drops a retransmission it already has", async () => {
    const relay = new RelayClient("ws://relay");
    await relay.connect(HELLO);
    const socket = FakeSocket.last;
    socket.sent = [];

    socket.deliver(
      packRelayFrame(RelayType.StreamData, 1, new Uint8Array([1]))
    );
    socket.deliver(
      packRelayFrame(RelayType.SessionResume, 8, encodeSessionResume(0, true))
    );
    socket.deliver(
      packRelayFrame(RelayType.StreamData, 1, new Uint8Array([1]))
    );
    socket.deliver(
      packRelayFrame(RelayType.StreamData, 2, new Uint8Array([2]))
    );

    expect((await relay.nextFrame(1000))?.requestId).toBe(1);
    expect((await relay.nextFrame(1000))?.requestId).toBe(2);
    expect(socket.frames(RelayType.SessionResume)).toHaveLength(0);
  });
});
