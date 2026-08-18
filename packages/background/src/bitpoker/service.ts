import { Env } from "@keplr-wallet/router";
import { Buffer } from "buffer/";
import {
  AuthInfo,
  Fee,
  SignDoc,
  TxBody,
  TxRaw,
} from "@keplr-wallet/proto-types/cosmos/tx/v1beta1/tx";
import { PubKey } from "@keplr-wallet/proto-types/cosmos/crypto/secp256k1/keys";
import { SignMode } from "@keplr-wallet/proto-types/cosmos/tx/signing/v1beta1/signing";
import { simpleFetch } from "@keplr-wallet/simple-fetch";
import { KeyRingService } from "../keyring";
import { ChainsService } from "../chains";
import { BackgroundTxService } from "../tx";
import { InteractionService } from "../interaction";
import { withApprovalPopup } from "./popup-env";
import {
  adjustGas,
  Coin,
  DEFAULT_GAS_ADJUSTMENT,
  feeForGas,
  fetchNodeGasPrice,
  GasPrice,
  simulateGasUsed,
} from "./fees";
import {
  encodeMsgAdjudicateSession,
  encodeMsgCancelGameIntent,
  encodeMsgClaimSessionTimeout,
  encodeMsgOpenGameIntent,
  encodeMsgSubmitSessionEvidence,
  encodeMsgSubmitSessionResult,
  encodeMsgSubmitSessionSecret,
  MSG_ADJUDICATE_SESSION_TYPE_URL,
  MSG_CANCEL_GAME_INTENT_TYPE_URL,
  MSG_CLAIM_SESSION_TIMEOUT_TYPE_URL,
  MSG_OPEN_GAME_INTENT_TYPE_URL,
  MSG_SUBMIT_SESSION_EVIDENCE_TYPE_URL,
  MSG_SUBMIT_SESSION_RESULT_TYPE_URL,
  MSG_SUBMIT_SESSION_SECRET_TYPE_URL,
  POKERCHAIN_GAME_TYPE_TH,
} from "./proto-writer";

// The bitpoker protocol authenticates relay connections and on-chain dispute
// evidence with a raw secp256k1 signature over sha256(payload) — the payload is
// a domain-prefixed text, NOT a Cosmos SignDoc (see bitpoker's
// game::signSecp256k1Sha256Payload). Raw signing is dangerous, so this service
// is fenced twice:
//  - the message has no approveExternal(), so webpages/content scripts can
//    never reach it, and the handler additionally rejects non-internal envs;
//  - the payload must start with one of these domain-separation prefixes, so
//    the signer cannot be repurposed to sign transactions, ADR-36 docs, or any
//    other byte string.
const ALLOWED_PAYLOAD_PREFIXES = [
  // Relay ClientHello auth ("cosmos-signature-v1"), relay_protocol.cpp
  "bitpoker-relay-client-hello-v1\n",
  // Relay reward receipt (ADR-005 / M5.3). v2 added the chain id to the signed
  // bytes; the C++ and Go signers moved with it but this allowlist did not, so
  // every browser-signed receipt was rejected here before it could be sent —
  // which is why browser seats never acknowledged their relay at all.
  "bitpoker-relay-receipt-v2\n",
  // submit-session-evidence authentication (ADR-003)
  "bitpoker-session-evidence-v1\n",
];

// Gas FLOORS for the poker messages, not fixed limits: a tx pays whichever is
// larger, the simulated estimate or this.
//
// Simulation measures the state the chain is in now, and these messages change
// branch depending on state that moves underneath them. Submitting a session
// result simulates at ~86k gas (the "record it" branch) and executes at ~111k
// once the peer's result has landed and it runs settlement. Running out of gas
// there leaves the session RESULT_PENDING with the escrow locked, which costs
// far more than overpaying a fraction of a CHIP. Evidence carries the full
// message-history payload, so it pays a per-byte write cost.
const GAS_FLOOR_GAME = "400000";
const GAS_FLOOR_EVIDENCE = "3000000";

// Adjudication replays the disputed hand through the C++ engine inside the tx
// and then pays out the verdict, so its cost tracks the length of the evidence
// transcript. It is also the only way a disputed escrow is ever released, so
// it gets evidence-sized headroom rather than a tight estimate.
const GAS_FLOOR_ADJUDICATE = "3000000";

// A simulated tx is never verified, but the signature slot must exist and be
// the right length or the ante handler rejects the shape before measuring.
const DUMMY_SIGNATURE = new Uint8Array(64);

// Dev/e2e escape hatch: skip the interactive intent approval. Substituted by
// the extension's EnvironmentPlugin; honored only on non-production builds so
// a store build physically cannot bypass the popup.
const BITPOKER_AUTO_APPROVE =
  process.env["NODE_ENV"] !== "production" &&
  process.env["KEPLR_EXT_BITPOKER_AUTO_APPROVE"] === "1";

export class BitpokerService {
  constructor(
    protected readonly keyRingService: KeyRingService,
    protected readonly chainsService: ChainsService,
    protected readonly txService: BackgroundTxService,
    protected readonly interactionService: InteractionService
  ) {}

  static isAllowedPayload(payload: string): boolean {
    return ALLOWED_PAYLOAD_PREFIXES.some((prefix) =>
      payload.startsWith(prefix)
    );
  }

  // Returns compressed_pubkey(33) || r(32) || s(32) as hex — the 97-byte layout
  // bitpoker's verifySecp256k1Sha256Payload and the relay's cosmos-signature-v1
  // verifier expect — signed with the selected account's key for chainId.
  async signPayload(
    env: Env,
    chainId: string,
    payload: string
  ): Promise<{ signature: string }> {
    if (!env.isInternalMsg) {
      throw new Error("bitpoker sign is only allowed for internal messages");
    }
    if (!BitpokerService.isAllowedPayload(payload)) {
      throw new Error(
        "bitpoker sign payload must start with an allowed bitpoker domain prefix"
      );
    }

    const pubKey = await this.keyRingService.getPubKeySelected(chainId);
    const signature = await this.keyRingService.signSelected(
      chainId,
      Buffer.from(payload, "utf8"),
      "sha256"
    );

    return {
      signature: Buffer.concat([
        Buffer.from(pubKey.toBytes()),
        Buffer.from(signature.r),
        Buffer.from(signature.s),
      ]).toString("hex"),
    };
  }

  // The selected account's identity on the poker chain: the page needs the
  // bech32 address (chain seat identity) and the FiatShamir-independent
  // compressed pubkey hex.
  async getKey(
    env: Env,
    chainId: string
  ): Promise<{ bech32Address: string; pubkeyHex: string }> {
    if (!env.isInternalMsg) {
      throw new Error("bitpoker getKey is only allowed for internal messages");
    }
    const modularChainInfo =
      this.chainsService.getModularChainInfoOrThrow(chainId);
    if (
      modularChainInfo.type !== "cosmos" &&
      modularChainInfo.type !== "ethermint"
    ) {
      throw new Error(`Not a cosmos chain: ${chainId}`);
    }
    const pubKey = await this.keyRingService.getPubKeySelected(chainId);
    const { Bech32Address } = await import("@keplr-wallet/cosmos");
    return {
      bech32Address: new Bech32Address(pubKey.getCosmosAddress()).toBech32(
        modularChainInfo.cosmos.bech32Config?.bech32PrefixAccAddr ?? "cosmos"
      ),
      pubkeyHex: Buffer.from(pubKey.toBytes()).toString("hex"),
    };
  }

  // Approval boundary: openIntent is the ONLY session-flow tx that locks
  // funds (a matched intent escrows the stake), so it alone goes through an
  // interactive Keplr approval popup. submitResult / submitEvidence /
  // submitSecret and the raw relay-hello signs stay direct-signed: they never
  // lock new funds (they release or defend escrow already at stake) and they
  // run inside the protocol's 30s frame-timeout / dispute-deadline windows
  // where a popup would forfeit the hand. All of them remain fenced by
  // env.isInternalMsg and (for raw signs) the domain-prefix allowlist.
  // Withdraw an unmatched offer. No approval: it is the opposite of locking
  // funds, and the page sends it when the player has stopped waiting — or
  // never came back at all.
  async cancelIntent(
    env: Env,
    chainId: string,
    intentId: string
  ): Promise<{ txHash: string; code: number; rawLog: string }> {
    if (!env.isInternalMsg) {
      throw new Error("bitpoker tx is only allowed for internal messages");
    }
    const { bech32Address } = await this.getKey(env, chainId);
    return this.broadcastPokerMsg(
      chainId,
      MSG_CANCEL_GAME_INTENT_TYPE_URL,
      encodeMsgCancelGameIntent({ creator: bech32Address, intentId }),
      GAS_FLOOR_GAME
    );
  }

  // Recover a stuck session. No approval: the player is getting their own
  // escrow unstuck, and the chain decides whether that means a refund or
  // adjudication.
  async claimSessionTimeout(
    env: Env,
    chainId: string,
    sessionId: string
  ): Promise<{ txHash: string; code: number; rawLog: string }> {
    if (!env.isInternalMsg) {
      throw new Error("bitpoker tx is only allowed for internal messages");
    }
    const { bech32Address } = await this.getKey(env, chainId);
    return this.broadcastPokerMsg(
      chainId,
      MSG_CLAIM_SESSION_TIMEOUT_TYPE_URL,
      encodeMsgClaimSessionTimeout({ creator: bech32Address, sessionId }),
      GAS_FLOOR_GAME
    );
  }

  // Ask for a verdict on a disputed session. No approval either: it moves the
  // player's own escrowed stake, and refusing to adjudicate never gets it back.
  async adjudicateSession(
    env: Env,
    chainId: string,
    sessionId: string
  ): Promise<{ txHash: string; code: number; rawLog: string }> {
    if (!env.isInternalMsg) {
      throw new Error("bitpoker tx is only allowed for internal messages");
    }
    const { bech32Address } = await this.getKey(env, chainId);
    return this.broadcastPokerMsg(
      chainId,
      MSG_ADJUDICATE_SESSION_TYPE_URL,
      encodeMsgAdjudicateSession({ creator: bech32Address, sessionId }),
      GAS_FLOOR_ADJUDICATE
    );
  }

  async openIntent(
    env: Env,
    chainId: string,
    args: {
      gameType: number;
      minStake: string;
      maxStake: string;
      opponent: string;
      playerSessionPubkey: string;
      playerTransportPubkey?: string;
    }
  ): Promise<{ txHash: string; code: number; rawLog: string }> {
    if (!env.isInternalMsg) {
      throw new Error("bitpoker tx is only allowed for internal messages");
    }
    const { bech32Address } = await this.getKey(env, chainId);
    const broadcast = () =>
      this.broadcastOpenIntent(chainId, bech32Address, args);

    if (BITPOKER_AUTO_APPROVE) {
      console.warn(
        "bitpoker: KEPLR_EXT_BITPOKER_AUTO_APPROVE is set — skipping the " +
          "interactive intent approval (dev/e2e builds only)"
      );
      return broadcast();
    }

    return await this.interactionService.waitApproveV2(
      withApprovalPopup(env),
      "/bitpoker/approve-intent",
      "bitpoker-open-intent",
      {
        chainId,
        gameType: args.gameType || POKERCHAIN_GAME_TYPE_TH,
        minStake: args.minStake,
        maxStake: args.maxStake,
        opponent: args.opponent,
        signer: bech32Address,
      },
      // Two-phase (interaction.md): approval resolves the wait first, THEN
      // the fund-locking broadcast runs.
      () => broadcast()
    );
  }

  protected async broadcastOpenIntent(
    chainId: string,
    bech32Address: string,
    args: {
      gameType: number;
      minStake: string;
      maxStake: string;
      opponent: string;
      playerSessionPubkey: string;
      playerTransportPubkey?: string;
    }
  ): Promise<{ txHash: string; code: number; rawLog: string }> {
    const msg = encodeMsgOpenGameIntent({
      creator: bech32Address,
      gameType: args.gameType || POKERCHAIN_GAME_TYPE_TH,
      minStake: args.minStake,
      maxStake: args.maxStake,
      opponent: args.opponent,
      playerSessionPubkey: args.playerSessionPubkey,
      playerTransportPubkey: args.playerTransportPubkey,
    });
    return this.broadcastPokerMsg(
      chainId,
      MSG_OPEN_GAME_INTENT_TYPE_URL,
      msg,
      GAS_FLOOR_GAME
    );
  }

  async submitResult(
    env: Env,
    chainId: string,
    args: {
      sessionId: string;
      winner: string;
      loser: string;
      finalStake: string;
      transcriptHash: string;
      resultSignature: string;
      splitPot: boolean;
      playerAAmount: string;
      playerBAmount: string;
    }
  ): Promise<{ txHash: string; code: number; rawLog: string }> {
    if (!env.isInternalMsg) {
      throw new Error("bitpoker tx is only allowed for internal messages");
    }
    const { bech32Address } = await this.getKey(env, chainId);
    const msg = encodeMsgSubmitSessionResult({
      creator: bech32Address,
      sessionId: args.sessionId,
      winner: args.winner,
      loser: args.loser,
      finalStake: args.finalStake,
      transcriptHash: args.transcriptHash,
      resultSignature: args.resultSignature,
      splitPot: args.splitPot,
      playerAAmount: args.playerAAmount,
      playerBAmount: args.playerBAmount,
    });
    return this.broadcastPokerMsg(
      chainId,
      MSG_SUBMIT_SESSION_RESULT_TYPE_URL,
      msg,
      GAS_FLOOR_GAME
    );
  }

  // Dispute path (ADR-003): the first evidence submission moves the session to
  // DISPUTED, protecting the escrow; the secret lets validators decrypt and
  // adjudicate the disputed hand. Evidence payload bytes come from the
  // gamecore's buildDisputeEvidence (canonical SessionEvidencePayload).
  async submitEvidence(
    env: Env,
    chainId: string,
    args: {
      sessionId: string;
      evidenceHash: string;
      evidencePayloadHex: string;
      evidenceSignature: string;
      reason: string;
    }
  ): Promise<{ txHash: string; code: number; rawLog: string }> {
    if (!env.isInternalMsg) {
      throw new Error("bitpoker tx is only allowed for internal messages");
    }
    const { bech32Address } = await this.getKey(env, chainId);
    const msg = encodeMsgSubmitSessionEvidence({
      creator: bech32Address,
      sessionId: args.sessionId,
      evidenceHash: args.evidenceHash,
      evidencePayload: Buffer.from(args.evidencePayloadHex, "hex"),
      evidenceSignature: args.evidenceSignature,
      reason: args.reason,
    });
    return this.broadcastPokerMsg(
      chainId,
      MSG_SUBMIT_SESSION_EVIDENCE_TYPE_URL,
      msg,
      GAS_FLOOR_EVIDENCE
    );
  }

  async submitSecret(
    env: Env,
    chainId: string,
    args: {
      sessionId: string;
      sessionSecretKeyHex: string;
      sessionPubkeyHex: string;
    }
  ): Promise<{ txHash: string; code: number; rawLog: string }> {
    if (!env.isInternalMsg) {
      throw new Error("bitpoker tx is only allowed for internal messages");
    }
    const { bech32Address } = await this.getKey(env, chainId);
    const msg = encodeMsgSubmitSessionSecret({
      creator: bech32Address,
      sessionId: args.sessionId,
      sessionSecretKey: Buffer.from(args.sessionSecretKeyHex, "hex"),
      sessionPubkey: Buffer.from(args.sessionPubkeyHex, "hex"),
    });
    return this.broadcastPokerMsg(
      chainId,
      MSG_SUBMIT_SESSION_SECRET_TYPE_URL,
      msg,
      GAS_FLOOR_GAME
    );
  }

  protected async broadcastPokerMsg(
    chainId: string,
    typeUrl: string,
    msgValue: Uint8Array,
    gasFloor: string
  ): Promise<{ txHash: string; code: number; rawLog: string }> {
    const modularChainInfo =
      this.chainsService.getModularChainInfoOrThrow(chainId);
    if (
      modularChainInfo.type !== "cosmos" &&
      modularChainInfo.type !== "ethermint"
    ) {
      throw new Error(`Not a cosmos chain: ${chainId}`);
    }
    const cosmosInfo = modularChainInfo.cosmos;
    const pubKey = await this.keyRingService.getPubKeySelected(chainId);
    const { Bech32Address } = await import("@keplr-wallet/cosmos");
    const bech32Address = new Bech32Address(pubKey.getCosmosAddress()).toBech32(
      cosmosInfo.bech32Config?.bech32PrefixAccAddr ?? "cosmos"
    );

    // Account number + sequence from the LCD.
    const account = await simpleFetch<any>(
      cosmosInfo.rest,
      `/cosmos/auth/v1beta1/accounts/${bech32Address}`
    );
    const base = account.data?.account;
    const accountNumber: string = base?.account_number ?? "0";
    const sequence: string = base?.sequence ?? "0";

    const bodyBytes = TxBody.encode(
      TxBody.fromPartial({
        messages: [{ typeUrl, value: msgValue }],
      })
    ).finish();

    // Both halves of the fee come from the chain: the gas from simulating this
    // exact tx, the price from the node's own config. See fees.ts.
    const encodeAuthInfo = (gasLimit: string, amount: Coin[]): Uint8Array =>
      AuthInfo.encode({
        signerInfos: [
          {
            publicKey: {
              typeUrl: "/cosmos.crypto.secp256k1.PubKey",
              value: PubKey.encode({ key: pubKey.toBytes() }).finish(),
            },
            modeInfo: {
              single: { mode: SignMode.SIGN_MODE_DIRECT },
              multi: undefined,
            },
            sequence,
          },
        ],
        fee: Fee.fromPartial({ gasLimit, amount }),
      }).finish();

    const feeDenom =
      cosmosInfo.feeCurrencies?.[0]?.coinMinimalDenom ??
      cosmosInfo.currencies?.[0]?.coinMinimalDenom;
    const [gasLimit, gasPrice] = await Promise.all([
      this.resolveGasLimit(
        cosmosInfo.rest,
        bodyBytes,
        encodeAuthInfo("0", []),
        gasFloor
      ),
      this.resolveGasPrice(cosmosInfo.rest, feeDenom),
    ]);
    const fee = gasPrice ? feeForGas(gasLimit, gasPrice) : undefined;
    const authInfoBytes = encodeAuthInfo(gasLimit, fee ? [fee] : []);
    const signDocBytes = SignDoc.encode({
      bodyBytes,
      authInfoBytes,
      chainId,
      accountNumber,
    }).finish();

    const signature = await this.keyRingService.signSelected(
      chainId,
      signDocBytes,
      "sha256"
    );
    const txRawBytes = TxRaw.encode({
      bodyBytes,
      authInfoBytes,
      signatures: [
        new Uint8Array(
          Buffer.concat([Buffer.from(signature.r), Buffer.from(signature.s)])
        ),
      ],
    }).finish();

    const txHashBytes = await this.txService.sendTx(
      chainId,
      txRawBytes,
      "sync",
      { silent: true, skipTracingTxResult: true }
    );
    const txHash = Buffer.from(txHashBytes).toString("hex").toUpperCase();

    // Poll the LCD until the tx is included so callers learn the DeliverTx
    // outcome (e.g. insufficient escrow funds) instead of guessing.
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const res = await simpleFetch<any>(
          cosmosInfo.rest,
          `/cosmos/tx/v1beta1/txs/${txHash}`
        );
        const txResponse = res.data?.tx_response;
        if (txResponse) {
          return {
            txHash,
            code: Number(txResponse.code ?? 0),
            rawLog: String(txResponse.raw_log ?? ""),
          };
        }
      } catch {
        // not indexed yet
      }
    }
    throw new Error(`tx ${txHash} was not included within 30s`);
  }

  // Gas from a simulated run of this exact tx, never below the caller's floor.
  // A node that declines to simulate leaves the tx on the floor alone — what
  // this service sent unconditionally before.
  protected async resolveGasLimit(
    rest: string,
    bodyBytes: Uint8Array,
    authInfoBytes: Uint8Array,
    gasFloor: string
  ): Promise<string> {
    try {
      const txBytes = TxRaw.encode({
        bodyBytes,
        authInfoBytes,
        signatures: [DUMMY_SIGNATURE],
      }).finish();
      const used = await simulateGasUsed(
        rest,
        Buffer.from(txBytes).toString("base64")
      );
      return adjustGas(used, DEFAULT_GAS_ADJUSTMENT, Number(gasFloor));
    } catch {
      return gasFloor;
    }
  }

  // Cached per endpoint: a node's minimum gas price comes from its app.toml
  // and changes on restart, not between transactions.
  protected gasPriceCache?: {
    rest: string;
    price: Promise<GasPrice | undefined>;
  };

  protected resolveGasPrice(
    rest: string,
    preferredDenom?: string
  ): Promise<GasPrice | undefined> {
    if (this.gasPriceCache?.rest !== rest) {
      this.gasPriceCache = {
        rest,
        price: fetchNodeGasPrice(rest, preferredDenom),
      };
    }
    return this.gasPriceCache.price;
  }
}
