// Orchestrates one hand of BitPoker from the extension page: relay transport
// (relay-client), gamecore in the worker (worker-client), and the wait-state
// machine in between. The UI subscribes to snapshots and calls act() when the
// gamecore reports it is the local player's turn (wait === 0).
//
// Mirrors the flow proven by bitpoker/wasm/test/run_interop_peer.js, so this
// controller is wire-compatible with a native GameSession peer over
// poker-relayd.
import { InExtensionMessageRequester } from "@keplr-wallet/router-extension";
import { BACKGROUND_PORT } from "@keplr-wallet/router";
import {
  BitpokerGetKeyMsg,
  BitpokerOpenIntentMsg,
  BitpokerSignPayloadMsg,
  BitpokerSubmitEvidenceMsg,
  BitpokerSubmitResultMsg,
  BitpokerSubmitSecretMsg,
} from "@keplr-wallet/background";
import {
  buildHelloSigningPayload,
  RelayClient,
  RelayType,
} from "./relay-client";
import { PokerWorkerClient } from "./worker-client";
import { HandEffect, MatchedResult, TableState } from "./types";

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export type PokerGame = "TH" | "ZJH";

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
  game?: PokerGame;
}

export type GameStage =
  | "idle"
  | "connecting"
  | "matching"
  | "playing"
  | "done"
  | "disputing"
  | "disputed"
  | "error";

export interface ChainJoinOptions {
  lcdUrl: string;
  chainId: string;
  playerName: string;
  // Legacy single-stake form (min = max = stake). Ignored when
  // minStakeUchip/maxStakeUchip are given.
  stake?: string; // decimal, uchip
  // Stake range in uchip (uint64-as-string). The chain matches two intents
  // whose ranges overlap; the session's actual stake comes from the match.
  minStakeUchip?: string;
  maxStakeUchip?: string;
  // "" or "ANY" = open matchmaking; a bech32 address = private challenge
  // (also how the lobby joins: opponent = the listed intent's creator).
  opponent?: string;
  game?: PokerGame;
}

export interface ChainProgress {
  address?: string;
  intentId?: string;
  sessionId?: string;
  relayId?: string;
  relayEndpoint?: string;
  resultTxHash?: string;
  evidenceTxHash?: string;
  sessionStatus?: string;
}

export interface GameSnapshot {
  stage: GameStage;
  message: string;
  matched?: MatchedResult;
  table?: TableState;
  chain?: ChainProgress;
  // wait === 0 means the action bar should be enabled.
  wait: number;
  // The local "keep playing after this hand" wish (multi-hand).
  continueWish?: boolean;
}

export class PokerGameController {
  protected relay?: RelayClient;
  protected readonly worker: PokerWorkerClient;
  protected snapshot: GameSnapshot = { stage: "idle", message: "", wait: 1 };
  protected matched?: MatchedResult;
  protected announcement?: Uint8Array;
  protected running = false;

  // On-chain session state (joinChain mode).
  protected chainSession?: any;
  protected chainAddress = "";
  protected chainId = "";
  protected chainLcdUrl = "";

  // Multi-hand: the local player's wish to keep playing after each hand
  // (default auto-continue). The session continues only if BOTH players wish
  // to; the UI toggles this and it takes effect at the current hand's
  // settlement.
  protected continueWish = true;

  // The game this session plays (Texas Hold'em by default, or ZhaJinHua).
  protected game: PokerGame = "TH";

  constructor(
    protected readonly onSnapshot: (snapshot: GameSnapshot) => void,
    worker?: PokerWorkerClient
  ) {
    this.worker = worker ?? new PokerWorkerClient();
  }

  getWorker(): PokerWorkerClient {
    return this.worker;
  }

  // The UI's "play another hand after this one" toggle. Takes effect at the
  // current hand's settlement.
  async setContinueWish(wish: boolean): Promise<void> {
    this.continueWish = wish;
    await this.worker.setContinueWish(wish);
    this.emit({ continueWish: wish });
  }

  getContinueWish(): boolean {
    return this.continueWish;
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
    this.game = opts.game ?? "TH";
    try {
      this.emit({
        stage: "connecting",
        message: `connecting ${opts.relayUrl}`,
      });
      await this.worker.newHand(this.game);
      await this.worker.setContinueWish(this.continueWish);

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
        game: this.game,
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

  // Full on-chain session: open an intent from the wallet, wait for the chain
  // to match it, load the session + assigned relay, authenticate to the relay
  // with a cosmos-signature-v1 hello, play the hand with the chain-forced seat
  // order, then submit the cooperative result and wait for SETTLED.
  async joinChain(opts: ChainJoinOptions): Promise<void> {
    if (this.running) {
      throw new Error("already joined");
    }
    this.running = true;
    const requester = new InExtensionMessageRequester();
    const lcd = async (path: string): Promise<any> => {
      const res = await fetch(opts.lcdUrl + path);
      if (!res.ok) {
        throw new Error(`LCD ${path}: ${res.status}`);
      }
      return res.json();
    };
    this.game = opts.game ?? "TH";
    try {
      const key = await requester.sendMessage(
        BACKGROUND_PORT,
        new BitpokerGetKeyMsg(opts.chainId)
      );
      const address = key.bech32Address;
      this.chainAddress = address;
      this.chainId = opts.chainId;
      this.chainLcdUrl = opts.lcdUrl;
      this.emit({
        stage: "connecting",
        chain: { address },
        message: `opening game intent as ${address}…`,
      });

      await this.worker.newHand(this.game);
      await this.worker.setContinueWish(this.continueWish);
      const sessionPubkeyHex = bytesToHex(await this.worker.localPubkey());

      const minStake = opts.minStakeUchip ?? opts.stake ?? "0";
      const maxStake = opts.maxStakeUchip ?? opts.stake ?? "0";
      const opponent =
        !opts.opponent || opts.opponent === "ANY" ? "" : opts.opponent;
      const intentTx = await requester.sendMessage(
        BACKGROUND_PORT,
        new BitpokerOpenIntentMsg(
          opts.chainId,
          // GameType: TH=3, ZJH=2 (pokerchain enum).
          this.game === "ZJH" ? 2 : 3,
          minStake,
          maxStake,
          opponent,
          sessionPubkeyHex
        )
      );
      if (intentTx.code !== 0) {
        this.fail(`open-game-intent failed: ${intentTx.rawLog}`);
        return;
      }

      this.emit({ stage: "matching", message: "waiting for a chain match…" });
      let intentId = "";
      let sessionId = "";
      for (let attempt = 0; attempt < 120 && this.running; attempt++) {
        const res = await lcd(
          `/pokerchain/pokerchain/v1/intents?owner=${address}`
        );
        const intents: any[] = res.intents ?? res.intent ?? [];
        const mine = intents
          .filter((i) => i.player_session_pubkey === sessionPubkeyHex)
          .sort((a, b) => Number(b.intent_id) - Number(a.intent_id))[0];
        if (mine) {
          intentId = String(mine.intent_id);
          if (mine.matched_session_id && mine.matched_session_id !== "0") {
            sessionId = String(mine.matched_session_id);
            break;
          }
        }
        this.emit({
          chain: { ...this.snapshot.chain, intentId },
          message: `intent ${intentId || "…"} open, waiting for an opponent…`,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!sessionId) {
        this.fail("no chain match within 120s");
        return;
      }

      const sessionRes = await lcd(
        `/pokerchain/pokerchain/v1/sessions/${sessionId}`
      );
      const session = sessionRes.session;
      const relayId: string = session.relay_assignment.primary_relay;
      const relayRes = await lcd(`/pokerchain/pokerchain/v1/relays/${relayId}`);
      const relayEndpoint: string = relayRes.relay.endpoint;
      this.chainSession = session;
      this.emit({
        chain: {
          ...this.snapshot.chain,
          intentId,
          sessionId,
          relayId,
          relayEndpoint,
        },
        message: `matched session ${sessionId}: ${session.player_a} vs ${session.player_b}, relay ${relayId}`,
      });

      await this.worker.setSessionSeed(sessionId);
      await this.worker.setChainSeats(session.player_a, session.player_b);

      // cosmos-signature-v1 relay auth: timestamp + nonce are part of the
      // signed text, so fix them before signing.
      const timestampMillis = Date.now();
      const nonce =
        Math.random().toString(36).slice(2) + Date.now().toString(36);
      const signText = buildHelloSigningPayload({
        chainId: opts.chainId,
        accountAddress: address,
        networkAddress: address,
        sessionId,
        relayId,
        playerSessionPubkey: sessionPubkeyHex,
        timestampMillis,
        nonce,
      });
      const signed = await requester.sendMessage(
        BACKGROUND_PORT,
        new BitpokerSignPayloadMsg(opts.chainId, signText)
      );

      this.relay = new RelayClient(relayEndpoint);
      await this.relay.connect({
        playerName: opts.playerName,
        networkAddress: address,
        chainId: opts.chainId,
        accountAddress: address,
        sessionId,
        relayId,
        playerSessionPubkey: sessionPubkeyHex,
        authScheme: "cosmos-signature-v1",
        authPayload: hexToBytes(signed.signature),
        timestampMillis,
        nonce,
      });

      // The matched session's stake is authoritative (a range intent can match
      // anywhere inside the overlap) — the in-game chips must mirror it on
      // both seats or the announcements disagree.
      const stake = parseInt(String(session.stake), 10);
      this.announcement = await this.worker.buildAnnouncement({
        name: opts.playerName,
        game: this.game,
        chip: "CHIP",
        opponent: "ANY",
        minBet: stake,
        maxBet: stake,
        // Chain seats are matched by announcement address (chainPlayerA/B).
        p2pAddr: address,
      });
      this.relay.sendAnnouncement(this.announcement);
      this.emit({ message: "connected to relay, waiting for the opponent…" });

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
      // A missing frame for this long mid-hand is treated as a disconnect
      // (matches bitpoker's NETWORK_MESSAGE_TIMEOUT); in a chain session it
      // escalates to the dispute path.
      const frame = await this.relay.nextFrame(30000);
      if (this.snapshot.stage === "done") {
        return;
      }
      if (!frame) {
        const reason = this.relay.closed
          ? "relay connection closed"
          : "timed out waiting for the opponent";
        // On-chain session interrupted mid-hand: escalate to the chain dispute
        // path (submit evidence + secret -> DISPUTED) instead of just failing,
        // so the escrow is protected and the hand can be adjudicated. Only once
        // we have matched (there is a real session + message history to attest).
        if (this.chainSession && this.matched) {
          await this.submitDispute(reason);
        } else {
          this.fail(reason);
        }
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
    if (status !== 1) {
      this.emit({
        stage: "error",
        table,
        message: `hand ended abnormally (status ${status}) — dispute path applies`,
      });
      return;
    }
    if (!this.chainSession) {
      this.emit({ stage: "done", table, message: "hand settled" });
      return;
    }
    // On-chain session: submit the cooperative result and wait for SETTLED.
    try {
      const session = this.chainSession;
      this.emit({
        table,
        message: "hand settled — submitting session result…",
      });
      const result = await this.worker.buildSessionResult({
        chainSessionId: String(session.session_id),
        playerA: session.player_a,
        playerB: session.player_b,
        finalStake: String(session.stake),
        relayFee: String(session.relay_fee_snapshot ?? "0"),
        localAddress: this.chainAddress,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      const requester = new InExtensionMessageRequester();
      const tx = await requester.sendMessage(
        BACKGROUND_PORT,
        new BitpokerSubmitResultMsg(
          this.chainId,
          String(session.session_id),
          result.winner ?? "",
          result.loser ?? "",
          result.finalStake ?? "0",
          result.transcriptHash ?? "",
          result.resultSignature ?? "",
          result.splitPot ?? false,
          result.playerAAmount ?? "0",
          result.playerBAmount ?? "0"
        )
      );
      if (tx.code !== 0) {
        throw new Error(`submit-session-result failed: ${tx.rawLog}`);
      }
      this.emit({
        chain: { ...this.snapshot.chain, resultTxHash: tx.txHash },
        message: `result submitted (${tx.txHash.slice(
          0,
          12
        )}…), waiting for on-chain settlement…`,
      });

      const lcdUrl = this.chainLcdUrl;
      for (let attempt = 0; attempt < 60; attempt++) {
        const res = await fetch(
          `${lcdUrl}/pokerchain/pokerchain/v1/sessions/${session.session_id}`
        ).then((r) => r.json());
        const sessionStatus: string = res.session?.status ?? "";
        this.emit({ chain: { ...this.snapshot.chain, sessionStatus } });
        if (/SETTLED/.test(sessionStatus)) {
          this.emit({
            stage: "done",
            table,
            message: `session ${session.session_id} settled on chain`,
          });
          return;
        }
        if (/DISPUTED|CANCELLED/.test(sessionStatus)) {
          throw new Error(`session ended as ${sessionStatus}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("session did not settle on chain within 60s");
    } catch (e: any) {
      this.emit({
        stage: "error",
        table,
        message: e?.message ?? String(e),
      });
    }
  }

  // On-chain dispute escalation (ADR-003): build the canonical evidence from
  // the recorded transcript, sign it, and submit evidence + the per-hand secret
  // so the chain marks the session DISPUTED (protecting the escrow) and can
  // adjudicate the abandoned hand.
  protected async submitDispute(reason: string): Promise<void> {
    this.running = false;
    if (this.relay) {
      this.relay.close();
    }
    const session = this.chainSession;
    try {
      this.emit({
        stage: "disputing",
        message: `hand interrupted (${reason}) — submitting dispute evidence…`,
      });
      const evidence = await this.worker.buildDisputeEvidence({
        chainSessionId: String(session.session_id),
        submitter: this.chainAddress,
        // ARBITRATION_REASON_CODE_CONNECTION_LOST = 6
        reasonCode: 6,
        reasonLabel: "connection-lost",
        reasonDescription: reason,
      });
      if (evidence.error) {
        throw new Error(evidence.error);
      }
      const requester = new InExtensionMessageRequester();
      // The evidence signing payload carries the bitpoker-session-evidence-v1
      // domain prefix, so the internal raw signer accepts it.
      const signed = await requester.sendMessage(
        BACKGROUND_PORT,
        new BitpokerSignPayloadMsg(this.chainId, evidence.signingPayload ?? "")
      );
      const evidenceTx = await requester.sendMessage(
        BACKGROUND_PORT,
        new BitpokerSubmitEvidenceMsg(
          this.chainId,
          String(session.session_id),
          evidence.evidenceHash ?? "",
          evidence.payloadHex ?? "",
          signed.signature,
          evidence.reason ?? "connection-lost"
        )
      );
      if (evidenceTx.code !== 0) {
        throw new Error(`submit-session-evidence failed: ${evidenceTx.rawLog}`);
      }
      this.emit({
        chain: { ...this.snapshot.chain, evidenceTxHash: evidenceTx.txHash },
        message: "evidence submitted — revealing session secret…",
      });

      const secret = await this.worker.exportSessionSecret();
      const secretTx = await requester.sendMessage(
        BACKGROUND_PORT,
        new BitpokerSubmitSecretMsg(
          this.chainId,
          String(session.session_id),
          bytesToHex(secret.secretKey),
          bytesToHex(secret.pubkey)
        )
      );
      if (secretTx.code !== 0) {
        throw new Error(`submit-session-secret failed: ${secretTx.rawLog}`);
      }

      // Confirm the session is DISPUTED (the escrow-protecting transition).
      for (let attempt = 0; attempt < 30; attempt++) {
        const res = await fetch(
          `${this.chainLcdUrl}/pokerchain/pokerchain/v1/sessions/${session.session_id}`
        ).then((r) => r.json());
        const sessionStatus: string = res.session?.status ?? "";
        this.emit({ chain: { ...this.snapshot.chain, sessionStatus } });
        if (/DISPUTED/.test(sessionStatus)) {
          this.emit({
            stage: "disputed",
            message: `session ${session.session_id} disputed on chain — awaiting adjudication`,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("session was not marked disputed within 30s");
    } catch (e: any) {
      this.emit({ stage: "error", message: e?.message ?? String(e) });
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
