// PokerWalletBridge backed by the Keplr background service.
//
// This is the extension-only half of the seam: it lives outside poker/ because
// poker/ must stay free of extension APIs so the same sources can build for
// the standalone web client. Everything here is a thin translation from the
// bridge's argument objects to the positional Bitpoker* message constructors —
// no policy lives in this file; approval gating and the raw-signer allowlist
// are enforced in the background service, across the process boundary, where
// a compromised page cannot reach them.
import { InExtensionMessageRequester } from "@keplr-wallet/router-extension";
import { BACKGROUND_PORT } from "@keplr-wallet/router";
import {
  BitpokerCancelIntentMsg,
  BitpokerGetKeyMsg,
  BitpokerOpenIntentMsg,
  BitpokerSignPayloadMsg,
  BitpokerSubmitEvidenceMsg,
  BitpokerSubmitResultMsg,
  BitpokerSubmitSecretMsg,
} from "@keplr-wallet/background";
import {
  OpenIntentArgs,
  PokerAccountKey,
  PokerTxResult,
  PokerWalletBridge,
  SubmitEvidenceArgs,
  SubmitResultArgs,
  SubmitSecretArgs,
} from "@bitpoker/poker-session/wallet-bridge";

export class ExtensionWalletBridge implements PokerWalletBridge {
  protected readonly requester = new InExtensionMessageRequester();

  getKey(chainId: string): Promise<PokerAccountKey> {
    return this.requester.sendMessage(
      BACKGROUND_PORT,
      new BitpokerGetKeyMsg(chainId)
    );
  }

  signPayload(
    chainId: string,
    payload: string
  ): Promise<{ signature: string }> {
    return this.requester.sendMessage(
      BACKGROUND_PORT,
      new BitpokerSignPayloadMsg(chainId, payload)
    );
  }

  openIntent(chainId: string, args: OpenIntentArgs): Promise<PokerTxResult> {
    return this.requester.sendMessage(
      BACKGROUND_PORT,
      new BitpokerOpenIntentMsg(
        chainId,
        args.gameType,
        args.minStake,
        args.maxStake,
        args.opponent,
        args.playerSessionPubkey,
        args.playerTransportPubkey
      )
    );
  }

  cancelIntent(chainId: string, intentId: string): Promise<PokerTxResult> {
    return this.requester.sendMessage(
      BACKGROUND_PORT,
      new BitpokerCancelIntentMsg(chainId, intentId)
    );
  }

  submitResult(
    chainId: string,
    args: SubmitResultArgs
  ): Promise<PokerTxResult> {
    return this.requester.sendMessage(
      BACKGROUND_PORT,
      new BitpokerSubmitResultMsg(
        chainId,
        args.sessionId,
        args.winner,
        args.loser,
        args.finalStake,
        args.transcriptHash,
        args.resultSignature,
        args.splitPot,
        args.playerAAmount,
        args.playerBAmount
      )
    );
  }

  submitEvidence(
    chainId: string,
    args: SubmitEvidenceArgs
  ): Promise<PokerTxResult> {
    return this.requester.sendMessage(
      BACKGROUND_PORT,
      new BitpokerSubmitEvidenceMsg(
        chainId,
        args.sessionId,
        args.evidenceHash,
        args.payloadHex,
        args.signature,
        args.reason
      )
    );
  }

  submitSecret(
    chainId: string,
    args: SubmitSecretArgs
  ): Promise<PokerTxResult> {
    return this.requester.sendMessage(
      BACKGROUND_PORT,
      new BitpokerSubmitSecretMsg(
        chainId,
        args.sessionId,
        args.secretKeyHex,
        args.pubkeyHex
      )
    );
  }
}
