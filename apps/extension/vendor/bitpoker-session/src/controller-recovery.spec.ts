// What the pump does when the relay goes quiet, and when the local player
// does.
//
// Both used to have the same answer — escalate to an on-chain dispute — which
// meant a dropped websocket or a player who thought for 30 seconds cost the
// escrow. These drive the real pump() with a fake relay so the decision, not
// just the constants, is covered.
//
// No vi.* / jest.* helpers: this file is also read by the Keplr extension's
// jest through the vendored copy, so it stays on plain fakes and never waits
// on a real clock (the paths asserted here are the zero-delay ones).
import { PokerGameController } from "./controller";
import { RelayType } from "./relay-client";

interface FakeRelay {
  closed: boolean;
  sent: Uint8Array[];
  nextFrame(timeoutMs?: number): Promise<null>;
  close(): void;
  sendStream(frame: Uint8Array): void;
  sendSessionHello(frame: Uint8Array): void;
  sentSequence: number;
  continueSequenceFrom(sequence: number): void;
}

const fakeRelay = (onRead: () => void = () => {}): FakeRelay => ({
  closed: false,
  sent: [],
  async nextFrame(): Promise<null> {
    onRead();
    return null;
  },
  close(): void {
    this.closed = true;
  },
  sendStream(frame: Uint8Array): void {
    this.sent.push(frame);
  },
  sendSessionHello(): void {},
  sentSequence: 0,
  continueSequenceFrom(sequence: number): void {
    this.sentSequence = Math.max(this.sentSequence, sequence);
  },
});

const RESYNC = new Uint8Array([0xbe, 0xef]);

// Only the calls pump() makes on the way through recovery.
const fakeWorker = () =>
  ({
    async makeResyncFrame(): Promise<Uint8Array> {
      return RESYNC;
    },
  } as any);

class TestController extends PokerGameController {
  disputed: string[] = [];
  failed: string[] = [];
  reconnectCalls: number[] = [];

  constructor() {
    super(() => {}, {} as any, fakeWorker());
  }

  protected override async submitDispute(reason: string): Promise<void> {
    this.disputed.push(reason);
    this.running = false;
  }

  protected override fail(message: string): void {
    this.failed.push(message);
    this.running = false;
  }

  // Drops the controller into the state pump() runs in: matched, playing, on
  // an on-chain session (the case where giving up costs money).
  armMidHand(relay: FakeRelay, reconnect?: (from: number) => FakeRelay): void {
    this.relay = relay as any;
    this.matched = { meFirst: true, betAmount: 1 };
    this.chainSession = { session_id: "7" };
    this.running = true;
    this.snapshot = { stage: "playing", message: "", wait: 1 };
    this.reconnect = reconnect
      ? async (from: number) => {
          this.reconnectCalls.push(from);
          return reconnect(from) as any;
        }
      : undefined;
  }

  stop(): void {
    this.running = false;
  }

  runPump(): Promise<void> {
    return this.pump();
  }

  setWait(wait: number): void {
    this.emit({ wait });
  }

  get deadline(): number | undefined {
    return this.snapshot.actionDeadline;
  }

  get liveRelay(): FakeRelay {
    return this.relay as unknown as FakeRelay;
  }
}

describe("pump recovery", () => {
  it("reconnects and resyncs instead of disputing when the link drops", async () => {
    const controller = new TestController();
    const dead = fakeRelay();
    let replacement: FakeRelay | undefined;

    // First read finds nothing (the drop). After the reconnect the second read
    // ends the test rather than looping forever.
    controller.armMidHand(dead, (from) => {
      replacement = fakeRelay(() => controller.stop());
      replacement.continueSequenceFrom(from);
      return replacement;
    });

    await controller.runPump();

    expect(controller.disputed).toEqual([]);
    expect(controller.failed).toEqual([]);
    expect(controller.reconnectCalls).toHaveLength(1);
    // The gamecore's resync frame is what makes the peer replay what we
    // missed; a reconnect without it leaves both sides waiting.
    expect(replacement?.sent).toEqual([RESYNC]);
    expect(controller.liveRelay).toBe(replacement);
    // The broken socket is closed so nothing is left reading it.
    expect(dead.closed).toBe(true);
  });

  it("carries the outbound stream sequence into the new connection", async () => {
    const controller = new TestController();
    const dead = fakeRelay();
    dead.sentSequence = 17;

    controller.armMidHand(dead, (from) => {
      const relay = fakeRelay(() => controller.stop());
      relay.continueSequenceFrom(from);
      return relay;
    });

    await controller.runPump();

    // A native peer drops any stream frame numbered at or below what it has
    // already seen, so a replacement connection that restarted at 1 would be
    // ignored into a stall — and then disputed.
    expect(controller.reconnectCalls).toEqual([17]);
    expect(controller.liveRelay.sentSequence).toBe(17);
  });

  it("escalates when the session has no way to reconnect", async () => {
    const controller = new TestController();
    controller.armMidHand(fakeRelay());

    await controller.runPump();

    expect(controller.disputed).toHaveLength(1);
    expect(controller.failed).toEqual([]);
  });

  it("does not mistake a finished hand for a lost peer", async () => {
    const controller = new TestController();
    // finish() tears the link down from outside the loop: running goes false
    // and the pending read wakes with no frame. That is not a disconnect.
    const relay = fakeRelay(() => controller.stop());
    controller.armMidHand(relay);

    await controller.runPump();

    expect(controller.disputed).toEqual([]);
    expect(controller.failed).toEqual([]);
  });
});

describe("local action clock", () => {
  it("starts only when it is the local player's turn", () => {
    const controller = new TestController();
    controller.armMidHand(fakeRelay());

    expect(controller.deadline).toBeUndefined();

    controller.setWait(0);
    const deadline = controller.deadline;
    expect(deadline).toBeDefined();
    expect(deadline! - Date.now()).toBeGreaterThan(0);

    controller.setWait(1);
    expect(controller.deadline).toBeUndefined();
  });

  it("does not restart the clock on a table refresh mid-turn", () => {
    const controller = new TestController();
    controller.armMidHand(fakeRelay());

    controller.setWait(0);
    const first = controller.deadline;
    // A peer-driven refresh re-emits the same wait; handing the player a fresh
    // minute each time would make the deadline unreachable.
    controller.setWait(0);
    expect(controller.deadline).toBe(first);

    controller.setWait(1);
  });

  it("has no clock outside a live hand", () => {
    const controller = new TestController();
    controller.armMidHand(fakeRelay());
    controller.setWait(0);
    expect(controller.deadline).toBeDefined();

    controller.stop();
    controller.setWait(0);
    expect(controller.deadline).toBeUndefined();
  });
});

// Sanity: the frame type the JS client never sends is still the one the relay
// reserves for transport resume, so the game-layer resync above is the only
// recovery this client relies on.
describe("relay frame types", () => {
  it("keeps SessionResume at the wire value native uses", () => {
    expect(RelayType.SessionResume).toBe(9);
  });
});

// The peer can force this session to DISPUTED and reveal its own secret
// entirely through chain transactions the relay link never sees — pump()'s
// escalation above only fires on a dead transport, so a player who is not
// watching the chain would never answer and would be judged
// FORFEIT_NO_SUBMISSION for the whole escrow (ONCHAIN_ROADMAP.md §13.5).
// These drive checkForUnilateralDispute directly against a stubbed `fetch`.
class DisputeWatchController extends PokerGameController {
  answered = 0;

  constructor() {
    super(() => {}, {} as any, fakeWorker());
  }

  protected override async respondToUnilateralDispute(): Promise<void> {
    this.answered += 1;
    this.disputeHandled = true;
    this.running = false;
  }

  arm(sessionId: string): void {
    this.chainSession = { session_id: sessionId };
    this.chainLcdUrl = "http://lcd.test";
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  check(): Promise<void> {
    return this.checkForUnilateralDispute();
  }
}

const stubFetch = (impl: () => Promise<{ ok: boolean; json(): Promise<any> }>) => {
  (global as any).fetch = impl;
};

describe("unilateral dispute watch", () => {
  const originalFetch = (global as any).fetch;

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it("answers once the chain reports this session as DISPUTED", async () => {
    const controller = new DisputeWatchController();
    controller.arm("7");
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        session: { status: "GAME_SESSION_STATE_DISPUTED" },
      }),
    }));

    await controller.check();

    expect(controller.answered).toBe(1);
  });

  it("does nothing while the session is still active", async () => {
    const controller = new DisputeWatchController();
    controller.arm("7");
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ session: { status: "GAME_SESSION_STATE_ACTIVE" } }),
    }));

    await controller.check();

    expect(controller.answered).toBe(0);
  });

  it("does not escalate on a transient LCD failure", async () => {
    const controller = new DisputeWatchController();
    controller.arm("7");
    stubFetch(async () => {
      throw new Error("network down");
    });

    await controller.check();

    expect(controller.answered).toBe(0);
  });

  it("answers at most once even if two ticks overlap", async () => {
    const controller = new DisputeWatchController();
    controller.arm("7");
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        session: { status: "GAME_SESSION_STATE_DISPUTED" },
      }),
    }));

    await Promise.all([controller.check(), controller.check()]);

    expect(controller.answered).toBe(1);
  });

  it("does not poll once the hand has stopped running", async () => {
    const controller = new DisputeWatchController();
    controller.arm("7");
    controller.stop();
    let called = false;
    stubFetch(async () => {
      called = true;
      return {
        ok: true,
        json: async () => ({
          session: { status: "GAME_SESSION_STATE_DISPUTED" },
        }),
      };
    });

    await controller.check();

    expect(called).toBe(false);
    expect(controller.answered).toBe(0);
  });
});
