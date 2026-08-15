// Page-side promise RPC over the poker Web Worker (see worker.ts).
import { HandEffect, MatchedResult, TableState } from "./types";

interface PendingCall {
  cmd: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export class PokerWorkerClient {
  protected readonly worker: Worker;
  protected seq = 0;
  protected readonly pending = new Map<number, PendingCall>();

  constructor() {
    this.worker = new Worker("pokerWorker.bundle.js");
    this.worker.onmessage = (ev: MessageEvent) => {
      const { id, ok, result, error } = ev.data;
      const call = this.pending.get(id);
      if (!call) {
        return;
      }
      this.pending.delete(id);
      if (ok) {
        call.resolve(result);
      } else {
        call.reject(new Error(`gamecore ${call.cmd}: ${error}`));
      }
    };
    this.worker.onerror = (ev) => {
      const error = new Error(`poker worker error: ${ev.message}`);
      for (const call of this.pending.values()) {
        call.reject(error);
      }
      this.pending.clear();
    };
  }

  protected call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { cmd, resolve, reject });
      this.worker.postMessage({ id, cmd, args: args ?? {} });
    });
  }

  selfTest(): Promise<string> {
    return this.call("selfTest");
  }
  newHand(game: "TH" | "ZJH" = "TH"): Promise<boolean> {
    // Chips/seat are overridden by the matchmaking result.
    return this.call("newHand", {
      game,
      firstChips: 0,
      secondChips: 0,
      localSeat: 0,
      button: 0,
    });
  }
  localPubkey(): Promise<Uint8Array> {
    return this.call("localPubkey");
  }
  // The session hello both seats exchange over relay frame 2: display name,
  // the stake this seat plays for, and the account the chain seated it as.
  buildSessionHello(args: {
    name: string;
    betAmount: number;
    accountAddress: string;
  }): Promise<Uint8Array> {
    return this.call("buildSessionHello", args);
  }
  // The two addresses AND the session pubkeys the chain has on record for
  // them. The gamecore refuses to match a session hello whose pubkey differs
  // from the chain's commitment, which is what stops a relay (or the peer)
  // substituting a different session key after the intents are matched.
  setChainSeats(
    playerA: string,
    playerB: string,
    playerAPubkey: Uint8Array,
    playerBPubkey: Uint8Array
  ): Promise<void> {
    return this.call("setChainSeats", {
      playerA,
      playerB,
      playerAPubkey,
      playerBPubkey,
    });
  }
  setContinueWish(wish: boolean): Promise<void> {
    return this.call("setContinueWish", { wish });
  }
  buildSessionResult(args: {
    chainSessionId: string;
    playerA: string;
    playerB: string;
    finalStake: string;
    relayFee: string;
    localAddress: string;
  }): Promise<{
    error?: string;
    winner?: string;
    loser?: string;
    splitPot?: boolean;
    finalStake?: string;
    transcriptHash?: string;
    resultSignature?: string;
    playerAAmount?: string;
    playerBAmount?: string;
  }> {
    return this.call("buildSessionResult", args);
  }
  onPeerSessionHello(frame: Uint8Array): Promise<MatchedResult> {
    return this.call("onPeerSessionHello", { frame });
  }
  setSessionSeed(seed: string): Promise<void> {
    return this.call("setSessionSeed", { seed });
  }
  start(): Promise<HandEffect> {
    return this.call("start");
  }
  onPeerFrame(frame: Uint8Array): Promise<HandEffect> {
    return this.call("onPeerFrame", { frame });
  }
  onLocalAction(kind: number, amount: number): Promise<HandEffect> {
    return this.call("onLocalAction", { kind, amount });
  }
  makeResyncFrame(): Promise<Uint8Array> {
    return this.call("makeResyncFrame");
  }
  tableState(): Promise<TableState> {
    return this.call("tableState");
  }
  status(): Promise<number> {
    return this.call("status");
  }
  exportSessionSecret(): Promise<{
    secretKey: Uint8Array;
    pubkey: Uint8Array;
  }> {
    return this.call("exportSessionSecret");
  }
  buildDisputeEvidence(args: {
    chainSessionId: string;
    submitter: string;
    reasonCode: number;
    reasonLabel: string;
    reasonDescription: string;
  }): Promise<{
    error?: string;
    payload?: Uint8Array;
    payloadHex?: string;
    evidenceHash?: string;
    signingPayload?: string;
    reason?: string;
  }> {
    return this.call("buildDisputeEvidence", args);
  }

  terminate(): void {
    this.worker.terminate();
  }
}
