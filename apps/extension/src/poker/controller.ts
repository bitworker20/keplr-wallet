// Orchestrates one hand of BitPoker from the extension page: relay transport
// (relay-client), gamecore in the worker (worker-client), and the wait-state
// machine in between. The UI subscribes to snapshots and calls act() when the
// gamecore reports it is the local player's turn (wait === 0).
//
// Mirrors the flow proven by bitpoker/wasm/test/run_interop_peer.js, so this
// controller is wire-compatible with a native GameSession peer over
// poker-relayd.
import { RelayClient, RelayType } from "./relay-client";
import { PokerWorkerClient } from "./worker-client";
import { HandEffect, MatchedResult, TableState } from "./types";

export interface JoinOptions {
  relayUrl: string;
  relayId: string;
  sessionId: string;
  playerName: string;
  accountAddress: string;
  chainId: string;
  chip: string;
  minBet: number;
  maxBet: number;
}

export type GameStage =
  | "idle"
  | "connecting"
  | "matching"
  | "playing"
  | "done"
  | "error";

export interface GameSnapshot {
  stage: GameStage;
  message: string;
  matched?: MatchedResult;
  table?: TableState;
  // wait === 0 means the action bar should be enabled.
  wait: number;
}

export class PokerGameController {
  protected relay?: RelayClient;
  protected readonly worker: PokerWorkerClient;
  protected snapshot: GameSnapshot = { stage: "idle", message: "", wait: 1 };
  protected matched?: MatchedResult;
  protected announcement?: Uint8Array;
  protected running = false;

  constructor(
    protected readonly onSnapshot: (snapshot: GameSnapshot) => void,
    worker?: PokerWorkerClient
  ) {
    this.worker = worker ?? new PokerWorkerClient();
  }

  getWorker(): PokerWorkerClient {
    return this.worker;
  }

  protected emit(partial: Partial<GameSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.onSnapshot(this.snapshot);
  }

  async join(opts: JoinOptions): Promise<void> {
    if (this.running) {
      throw new Error("already joined");
    }
    this.running = true;
    try {
      this.emit({
        stage: "connecting",
        message: `connecting ${opts.relayUrl}`,
      });
      await this.worker.newHand();

      this.relay = new RelayClient(opts.relayUrl);
      await this.relay.connect({
        playerName: opts.playerName,
        networkAddress: `keplr://${opts.playerName}`,
        chainId: opts.chainId,
        accountAddress: opts.accountAddress,
        sessionId: opts.sessionId,
        relayId: opts.relayId,
        playerSessionPubkey: "keplr-dev",
      });

      this.announcement = await this.worker.buildAnnouncement({
        name: opts.playerName,
        game: "TH",
        chip: opts.chip,
        opponent: "ANY",
        minBet: opts.minBet,
        maxBet: opts.maxBet,
      });
      this.relay.sendAnnouncement(this.announcement);
      this.emit({ stage: "matching", message: "waiting for an opponent…" });

      await this.pump();
    } catch (e: any) {
      this.fail(e?.message ?? String(e));
    }
  }

  // The UI's action bar: kind per PokerActionKind, amount for bet/raise-to.
  async act(kind: number, amount: number): Promise<void> {
    if (this.snapshot.wait !== 0 || !this.relay) {
      return;
    }
    // Optimistically leave the "our turn" state so double-clicks are inert;
    // refresh() below restores the real wait from the gamecore.
    this.emit({ wait: 1 });
    await this.applyEffect(await this.worker.onLocalAction(kind, amount));
    await this.refresh();
  }

  protected async pump(): Promise<void> {
    while (this.running && this.relay) {
      const frame = await this.relay.nextFrame(120000);
      if (this.snapshot.stage === "done") {
        return;
      }
      if (!frame) {
        this.fail(
          this.relay.closed
            ? "relay connection closed"
            : "timed out waiting for the opponent"
        );
        return;
      }

      if (frame.type === RelayType.MatchAnnouncement && !this.matched) {
        const matched = await this.worker.onPeerAnnouncement(frame.payload);
        if (matched.error) {
          this.fail(`match failed: ${matched.error}`);
          return;
        }
        this.matched = matched;
        // The relay replays announcements to late joiners, but re-send ours so
        // the exchange is join-order agnostic even against older relays.
        if (this.announcement) {
          this.relay.sendAnnouncement(this.announcement);
        }
        this.emit({
          stage: "playing",
          matched,
          message: `matched: ${matched.firstName} vs ${matched.secondName}, bet ${matched.betAmount}`,
        });
        await this.applyEffect(await this.worker.start());
        await this.refresh();
        continue;
      }
      if (frame.type === RelayType.StreamData && this.matched) {
        await this.applyEffect(await this.worker.onPeerFrame(frame.payload));
        await this.refresh();
        continue;
      }
      // Settlement/Chat/duplicate announcements are not the hand's concern.
    }
  }

  protected async applyEffect(eff: HandEffect): Promise<void> {
    if (!this.relay) {
      return;
    }
    for (const frame of eff.frames) {
      this.relay.sendStream(frame);
    }
    this.emit({ wait: eff.wait });
    if (eff.wait === 2) {
      await this.finish();
    }
  }

  protected async refresh(): Promise<void> {
    if (this.snapshot.stage !== "playing") {
      return;
    }
    const table = await this.worker.tableState();
    this.emit({ table });
  }

  protected async finish(): Promise<void> {
    const status = await this.worker.status();
    const table = await this.worker.tableState();
    this.running = false;
    if (this.relay) {
      this.relay.close();
    }
    if (status === 1) {
      this.emit({ stage: "done", table, message: "hand settled" });
    } else {
      this.emit({
        stage: "error",
        table,
        message: `hand ended abnormally (status ${status}) — dispute path applies`,
      });
    }
  }

  protected fail(message: string): void {
    this.running = false;
    if (this.relay) {
      this.relay.close();
    }
    this.emit({ stage: "error", message });
  }
}
