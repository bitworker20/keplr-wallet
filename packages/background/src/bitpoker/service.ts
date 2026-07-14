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
import {
  encodeMsgOpenGameIntent,
  encodeMsgSubmitSessionEvidence,
  encodeMsgSubmitSessionResult,
  encodeMsgSubmitSessionSecret,
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
  // Relay reward receipt (ADR-005 / M5.3)
  "bitpoker-relay-receipt-v1\n",
  // submit-session-evidence authentication (ADR-003)
  "bitpoker-session-evidence-v1\n",
];

export class BitpokerService {
  constructor(
    protected readonly keyRingService: KeyRingService,
    protected readonly chainsService: ChainsService,
    protected readonly txService: BackgroundTxService
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

  // DEV NOTE: session-flow txs are signed directly with the selected key,
  // without the interactive sign approval — the same trust model as the native
  // CLI client's key. The intent tx locks funds, so gating it behind a normal
  // Keplr sign interaction is a planned follow-up before any non-dev build.
  async openIntent(
    env: Env,
    chainId: string,
    args: {
      gameType: number;
      minStake: string;
      maxStake: string;
      opponent: string;
      playerSessionPubkey: string;
    }
  ): Promise<{ txHash: string; code: number; rawLog: string }> {
    if (!env.isInternalMsg) {
      throw new Error("bitpoker tx is only allowed for internal messages");
    }
    const { bech32Address } = await this.getKey(env, chainId);
    const msg = encodeMsgOpenGameIntent({
      creator: bech32Address,
      gameType: args.gameType || POKERCHAIN_GAME_TYPE_TH,
      minStake: args.minStake,
      maxStake: args.maxStake,
      opponent: args.opponent,
      playerSessionPubkey: args.playerSessionPubkey,
    });
    return this.broadcastPokerMsg(
      chainId,
      MSG_OPEN_GAME_INTENT_TYPE_URL,
      msg,
      "400000"
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
      "400000"
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
    // Evidence carries the full message-history payload, so it needs a high gas
    // limit (per-byte write cost); the local dev chain has zero gas price.
    return this.broadcastPokerMsg(
      chainId,
      MSG_SUBMIT_SESSION_EVIDENCE_TYPE_URL,
      msg,
      "3000000"
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
      "400000"
    );
  }

  protected async broadcastPokerMsg(
    chainId: string,
    typeUrl: string,
    msgValue: Uint8Array,
    gasLimit: string
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
    const authInfoBytes = AuthInfo.encode({
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
      fee: Fee.fromPartial({ gasLimit }),
    }).finish();
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
}
