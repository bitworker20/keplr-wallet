// Orchestrates one hand of BitPoker for whichever client renders it: relay
// transport (relay-client), gamecore in the worker (worker-client), and the
// wait-state machine in between. The UI subscribes to snapshots and calls
// act() when the gamecore reports it is the local player's turn (wait === 0).
// Nothing below this line knows what that UI looks like.
//
// Mirrors the flow proven by bitpoker/wasm/test/run_interop_peer.js, so this
// controller is wire-compatible with a native GameSession peer over
// poker-relayd.
import { PokerWalletBridge } from "./wallet-bridge";
import {
  buildHelloSigningPayload,
  RelayClient,
  RelayType,
} from "./relay-client";
import {
  RELAY_SUBPROTOCOL_V1,
  base64ToBytes,
  connectTokenSubprotocol,
  generateTransportKeypair,
  openEndpointBlob,
} from "./endpoint-blob";
import { isPendingIntent } from "./lobby";
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

// How long to wait for an ADR-007 endpoint answer on a chain that does not
// gate answering (relay_answer_timeout_blocks = 0, the default genesis). The
// relay's answer loop polls every couple of seconds, so this is generous
// enough for a slow one and short enough that a chain with no answering relay
// at all still reports the problem promptly.
const UNGATED_ANSWER_GRACE_MS = 30000;

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
  protected sessionHello?: Uint8Array;
  protected running = false;

  // On-chain session state (joinChain mode).
  protected chainSession?: any;
  // The intent this run opened, until it is matched. An intent left standing
  // is not harmless: matching escrows both stakes, so an offer that outlives
  // the tab reaches into the player's wallet up to an hour later and creates
  // a session nobody is there to play.
  protected openIntentId = "";
  // Set by cancelMatchmaking so the polling loop knows the player walked away
  // rather than the chain running out of time — the two want different words.
  protected matchmakingCancelled = false;
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
    protected readonly wallet: PokerWalletBridge,
    worker?: PokerWorkerClient
  ) {
    this.worker = worker ?? new PokerWorkerClient();
  }

  // Diagnostics only. Exposed as a method rather than handing out the worker
  // so the worker stays an implementation detail of this controller — a bridge
  // that one day lives behind an origin boundary cannot hand out live objects.
  runSelfTest(): Promise<string> {
    return this.worker.selfTest();
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

      this.sessionHello = await this.worker.buildSessionHello({
        name: opts.playerName,
        betAmount: opts.maxBet,
        accountAddress: opts.accountAddress,
      });
      this.relay.sendSessionHello(this.sessionHello);
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
    const lcd = async (path: string): Promise<any> => {
      const res = await fetch(opts.lcdUrl + path);
      if (!res.ok) {
        throw new Error(`LCD ${path}: ${res.status}`);
      }
      return res.json();
    };
    this.game = opts.game ?? "TH";
    try {
      const key = await this.wallet.getKey(opts.chainId);
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
      // ADR-007: a fresh transport keypair per run; the pubkey is committed
      // in the intent so the assigned relay can encrypt this player's
      // endpoint blob to it. The secret never leaves this page.
      const transport = generateTransportKeypair();

      const minStake = opts.minStakeUchip ?? opts.stake ?? "0";
      const maxStake = opts.maxStakeUchip ?? opts.stake ?? "0";
      const opponent =
        !opts.opponent || opts.opponent === "ANY" ? "" : opts.opponent;
      // Withdraw anything this account left standing from an earlier tab or a
      // crashed run. Two reasons, both real: those offers can still be matched
      // while nobody is watching, and matching takes the OLDEST compatible
      // intent — so a stale one is matched in preference to the fresh one
      // below, and this run then waits for a match that already happened to
      // a session key it does not have.
      await this.cancelStrandedIntents(lcd, opts.chainId, address);

      const intentTx = await this.wallet.openIntent(opts.chainId, {
        // GameType: TH=3, ZJH=2 (pokerchain enum).
        gameType: this.game === "ZJH" ? 2 : 3,
        minStake,
        maxStake,
        opponent,
        playerSessionPubkey: sessionPubkeyHex,
        playerTransportPubkey: transport.pubkeyHex,
      });
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
          this.openIntentId = intentId;
          if (mine.matched_session_id && mine.matched_session_id !== "0") {
            sessionId = String(mine.matched_session_id);
            // Matched: the offer is spent, and cancelling it now would fail.
            this.openIntentId = "";
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
        if (this.matchmakingCancelled) {
          // cancelMatchmaking already withdrew the offer and said so.
          return;
        }
        await this.withdrawOpenIntent();
        this.fail(
          "no chain match within 120s — the offer was withdrawn, so nothing " +
            "is left standing against your balance"
        );
        return;
      }

      const sessionRes = await lcd(
        `/pokerchain/pokerchain/v1/sessions/${sessionId}`
      );
      const session = sessionRes.session;

      // ADR-007 §3.1: when the answer protocol is live, the endpoint arrives
      // as an encrypted per-player blob on the session, not from the relay
      // registry (which no longer carries endpoints at all).
      let liveSession = session;
      const answerDeadline = Number(
        liveSession.relay_answer_deadline_height ?? "0"
      );
      const hasAnswer = (s: any): boolean =>
        !!s.relay_endpoint_answer && !!s.relay_endpoint_answer.relay_id;
      if (!hasAnswer(liveSession)) {
        // The answer is written by the relay a poll interval or two after the
        // match, so it is never there the instant we read the session. Wait
        // for it either way:
        //
        //   deadline > 0   the chain gates answering (relay_answer_timeout_
        //                  blocks is set) and enforces the deadline; missing
        //                  it means the session can be voided for a refund.
        //   deadline == 0  answering is UNGATED, which is the default genesis.
        //                  There is no chain deadline to wait on, so use a
        //                  local grace period — waiting a few seconds for the
        //                  relay's next poll is the difference between playing
        //                  and reporting that nobody published an endpoint.
        const graceUntil = Date.now() + UNGATED_ANSWER_GRACE_MS;
        this.emit({
          stage: "matching",
          message: "waiting for the assigned relay to allocate an endpoint…",
        });
        for (; this.running; ) {
          if (answerDeadline > 0) {
            const latest = await lcd(
              "/cosmos/base/tendermint/v1beta1/blocks/latest"
            );
            const height = Number(latest.block.header.height);
            if (height >= answerDeadline) {
              this.fail(
                "no assigned relay answered before the deadline; " +
                  "the session can be voided for a full refund"
              );
              return;
            }
          } else if (Date.now() >= graceUntil) {
            // Fall through to the legacy registry endpoint, which either
            // serves one (pre-ADR-007 chain) or reports that it does not.
            break;
          }
          liveSession = (
            await lcd(`/pokerchain/pokerchain/v1/sessions/${sessionId}`)
          ).session;
          if (hasAnswer(liveSession)) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!this.running) {
          return;
        }
      }

      let relayId: string = session.relay_assignment.primary_relay;
      let relayEndpoint = "";
      let relaySubprotocols: string[] | undefined;
      if (hasAnswer(liveSession)) {
        const answer = liveSession.relay_endpoint_answer;
        relayId = answer.relay_id;
        const isPlayerA = session.player_a === address;
        const grant = await openEndpointBlob(
          transport.secretHex,
          sessionId,
          relayId,
          base64ToBytes(isPlayerA ? answer.blob_a : answer.blob_b)
        );
        relayEndpoint = grant.endpoint;
        relaySubprotocols = [
          RELAY_SUBPROTOCOL_V1,
          connectTokenSubprotocol(grant.connectToken),
        ];
      } else {
        // Legacy chain: the registry still serves an endpoint. Under ADR-007
        // it does not — the field is gone — so an empty answer here means the
        // assigned relay never allocated an endpoint for this session, and
        // there is nowhere to connect. Say that, rather than handing an
        // undefined URL to the WebSocket and reporting whatever it throws.
        const relayRes = await lcd(
          `/pokerchain/pokerchain/v1/relays/${relayId}`
        );
        relayEndpoint = relayRes.relay?.endpoint ?? "";
        if (!relayEndpoint) {
          this.fail(
            `relay ${relayId} published no endpoint for this session: the ` +
              `chain expects the ADR-007 answer protocol, so poker-relayd ` +
              `must run with -relay-key-name, -chain-node and -chain-id`
          );
          return;
        }
      }
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

      // The chain's own record of which session key each seat committed to,
      // read from the two matched intents. The gamecore verifies the peer's
      // session hello against it (session_matchmaking.cpp), so a relay cannot
      // slip a different key in between the match and the first deal.
      const seatPubkey = async (intentId: string): Promise<Uint8Array> => {
        const res = await lcd(`/pokerchain/pokerchain/v1/intents/${intentId}`);
        const hex = res?.intent?.player_session_pubkey ?? "";
        if (!hex) {
          throw new Error(
            `chain intent ${intentId} carries no player_session_pubkey`
          );
        }
        return hexToBytes(hex);
      };
      const [playerAPubkey, playerBPubkey] = await Promise.all([
        seatPubkey(String(session.player_a_intent_id)),
        seatPubkey(String(session.player_b_intent_id)),
      ]);

      await this.worker.setSessionSeed(sessionId);
      await this.worker.setChainSeats(
        session.player_a,
        session.player_b,
        playerAPubkey,
        playerBPubkey
      );

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
      const signed = await this.wallet.signPayload(opts.chainId, signText);

      this.relay = new RelayClient(relayEndpoint, relaySubprotocols);
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
      // both seats or the two hellos disagree.
      const stake = parseInt(String(session.stake), 10);
      this.sessionHello = await this.worker.buildSessionHello({
        name: opts.playerName,
        betAmount: stake,
        // Seats are matched by account address against chainPlayerA/B.
        accountAddress: address,
      });
      this.relay.sendSessionHello(this.sessionHello);
      this.emit({ message: "connected to relay, waiting for the opponent…" });

      await this.pump();
    } catch (e: any) {
      // Anything that goes wrong before the match leaves an offer nobody is
      // going to play; take it off the table.
      await this.withdrawOpenIntent();
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

      if (frame.type === RelayType.SessionHello && !this.matched) {
        const matched = await this.worker.onPeerSessionHello(frame.payload);
        if (matched.error) {
          this.fail(`match failed: ${matched.error}`);
          return;
        }
        this.matched = matched;
        // The relay replays hellos to late joiners, but re-send ours so the
        // exchange is join-order agnostic even against older relays. The
        // hello is idempotent; peers ignore a duplicate mid-hand.
        if (this.sessionHello) {
          this.relay.sendSessionHello(this.sessionHello);
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
        // Frame pacing: hold each rendered peer move on screen for a beat so
        // fast opponents (native robots settle a street in milliseconds) stay
        // followable. Safe against the 30s disconnect detector: relay-client
        // buffers inbound frames in an awaitable queue, so nextFrame's timer
        // measures real peer silence, not our UI hold. Shuffle/key-exchange
        // bursts (dealing) are not paced — nothing visible changes per frame.
        const table = this.snapshot.table;
        if (table?.ready && !table.dealing && this.snapshot.wait === 1) {
          await this.hold(PokerGameController.PEER_FRAME_HOLD_MS);
        }
        continue;
      }
      // Settlement/Chat/duplicate hellos are not the hand's concern.
    }
  }

  protected static readonly PEER_FRAME_HOLD_MS = 850;
  protected static readonly SETTLE_HOLD_MS = 2600;

  protected async hold(ms: number): Promise<void> {
    if (!this.running) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
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
      // Let the showdown reveal + result banner land before result submission
      // / settle polling takes over the status line. Per hand-end, so the
      // extra beat is invisible next to the chain's 1s poll cadence.
      await this.refresh();
      await this.hold(PokerGameController.SETTLE_HOLD_MS);
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
      const tx = await this.wallet.submitResult(this.chainId, {
        sessionId: String(session.session_id),
        winner: result.winner ?? "",
        loser: result.loser ?? "",
        finalStake: result.finalStake ?? "0",
        transcriptHash: result.transcriptHash ?? "",
        resultSignature: result.resultSignature ?? "",
        splitPot: result.splitPot ?? false,
        playerAAmount: result.playerAAmount ?? "0",
        playerBAmount: result.playerBAmount ?? "0",
      });
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
      // The evidence signing payload carries the bitpoker-session-evidence-v1
      // domain prefix, so the raw signer accepts it.
      const signed = await this.wallet.signPayload(
        this.chainId,
        evidence.signingPayload ?? ""
      );
      const evidenceTx = await this.wallet.submitEvidence(this.chainId, {
        sessionId: String(session.session_id),
        evidenceHash: evidence.evidenceHash ?? "",
        payloadHex: evidence.payloadHex ?? "",
        signature: signed.signature,
        reason: evidence.reason ?? "connection-lost",
      });
      if (evidenceTx.code !== 0) {
        throw new Error(`submit-session-evidence failed: ${evidenceTx.rawLog}`);
      }
      this.emit({
        chain: { ...this.snapshot.chain, evidenceTxHash: evidenceTx.txHash },
        message: "evidence submitted — revealing session secret…",
      });

      const secret = await this.worker.exportSessionSecret();
      const secretTx = await this.wallet.submitSecret(this.chainId, {
        sessionId: String(session.session_id),
        secretKeyHex: bytesToHex(secret.secretKey),
        pubkeyHex: bytesToHex(secret.pubkey),
      });
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

  // Withdraw the offer this run opened, if it is still standing. Best effort:
  // the tx can fail because the intent was matched a moment ago, or expired,
  // and neither is worth turning into the error the player sees — the reason
  // they are here is that something else already went wrong.
  protected async withdrawOpenIntent(): Promise<void> {
    const intentId = this.openIntentId;
    if (!intentId) {
      return;
    }
    this.openIntentId = "";
    try {
      const res = await this.wallet.cancelIntent(this.chainId, intentId);
      if (res.code !== 0) {
        console.warn(`could not withdraw intent ${intentId}: ${res.rawLog}`);
      }
    } catch (e: any) {
      console.warn(`could not withdraw intent ${intentId}: ${e?.message ?? e}`);
    }
  }

  // Retire this account's leftover offers before opening a new one. The chain
  // lets a creator cancel any PENDING intent of theirs, and matching would
  // otherwise prefer these older ones over the fresh one.
  protected async cancelStrandedIntents(
    lcd: (path: string) => Promise<any>,
    chainId: string,
    address: string
  ): Promise<void> {
    let stranded: string[] = [];
    try {
      const res = await lcd(
        `/pokerchain/pokerchain/v1/intents?owner=${address}`
      );
      const intents: any[] = res.intents ?? [];
      stranded = intents
        .filter((intent) => isPendingIntent(intent))
        .map((intent) => String(intent.intent_id));
    } catch (e: any) {
      // A failed lobby query is not a reason to refuse to play.
      console.warn(`could not look for stranded intents: ${e?.message ?? e}`);
      return;
    }
    for (const intentId of stranded) {
      try {
        const res = await this.wallet.cancelIntent(chainId, intentId);
        if (res.code === 0) {
          this.emit({
            message: `withdrew a leftover offer (intent ${intentId})`,
          });
        }
      } catch (e: any) {
        console.warn(`could not cancel intent ${intentId}: ${e?.message ?? e}`);
      }
    }
  }

  // The player gave up waiting. Public because only the UI knows that — the
  // controller is happy to keep polling.
  async cancelMatchmaking(): Promise<void> {
    this.matchmakingCancelled = true;
    // Stop the polling loop first: it emits "waiting for an opponent" every
    // second, and the withdrawal takes a block or two to land. Without this
    // the page goes on inviting an opponent the player has already given up
    // on.
    this.running = false;
    this.emit({ message: "withdrawing the offer…" });
    await this.withdrawOpenIntent();
    this.fail("you withdrew the offer before it matched");
  }

  protected fail(message: string): void {
    this.running = false;
    if (this.relay) {
      this.relay.close();
    }
    this.emit({ stage: "error", message });
  }
}
