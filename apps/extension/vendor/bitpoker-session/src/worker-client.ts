// Page-side promise RPC over the poker Web Worker (see worker.ts).
import { HandEffect, MatchedResult, TableState } from "./types";

interface PendingCall {
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
        call.reject(new Error(error));
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
      this.pending.set(id, { resolve, reject });
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
  buildAnnouncement(args: {
    name: string;
    game: string;
    chip: string;
    opponent: string;
    minBet: number;
    maxBet: number;
    p2pAddr?: string;
  }): Promise<Uint8Array> {
    return this.call("buildAnnouncement", args);
  }
  setChainSeats(playerA: string, playerB: string): Promise<void> {
    return this.call("setChainSeats", { playerA, playerB });
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
  onPeerAnnouncement(frame: Uint8Array): Promise<MatchedResult> {
    return this.call("onPeerAnnouncement", { frame });
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
