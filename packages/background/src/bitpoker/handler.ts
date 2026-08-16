import {
  Env,
  Handler,
  InternalHandler,
  KeplrError,
  Message,
} from "@keplr-wallet/router";
import { BitpokerService } from "./service";
import {
  BitpokerGetKeyMsg,
  BitpokerCancelIntentMsg,
  BitpokerClaimSessionTimeoutMsg,
  BitpokerOpenIntentMsg,
  BitpokerSignPayloadMsg,
  BitpokerSubmitEvidenceMsg,
  BitpokerSubmitResultMsg,
  BitpokerSubmitSecretMsg,
} from "./messages";

export const getHandler: (service: BitpokerService) => Handler = (
  service: BitpokerService
) => {
  return (env: Env, msg: Message<unknown>) => {
    switch (msg.constructor) {
      case BitpokerSignPayloadMsg:
        return handleBitpokerSignPayloadMsg(service)(
          env,
          msg as BitpokerSignPayloadMsg
        );
      case BitpokerGetKeyMsg:
        return handleBitpokerGetKeyMsg(service)(env, msg as BitpokerGetKeyMsg);
      case BitpokerClaimSessionTimeoutMsg:
        return handleBitpokerClaimSessionTimeoutMsg(service)(
          env,
          msg as BitpokerClaimSessionTimeoutMsg
        );
      case BitpokerCancelIntentMsg:
        return handleBitpokerCancelIntentMsg(service)(
          env,
          msg as BitpokerCancelIntentMsg
        );
      case BitpokerOpenIntentMsg:
        return handleBitpokerOpenIntentMsg(service)(
          env,
          msg as BitpokerOpenIntentMsg
        );
      case BitpokerSubmitResultMsg:
        return handleBitpokerSubmitResultMsg(service)(
          env,
          msg as BitpokerSubmitResultMsg
        );
      case BitpokerSubmitEvidenceMsg:
        return handleBitpokerSubmitEvidenceMsg(service)(
          env,
          msg as BitpokerSubmitEvidenceMsg
        );
      case BitpokerSubmitSecretMsg:
        return handleBitpokerSubmitSecretMsg(service)(
          env,
          msg as BitpokerSubmitSecretMsg
        );
      default:
        throw new KeplrError("bitpoker", 100, "Unknown msg type");
    }
  };
};

const handleBitpokerSignPayloadMsg: (
  service: BitpokerService
) => InternalHandler<BitpokerSignPayloadMsg> = (service) => {
  return (env, msg) => {
    return service.signPayload(env, msg.chainId, msg.payload);
  };
};

const handleBitpokerGetKeyMsg: (
  service: BitpokerService
) => InternalHandler<BitpokerGetKeyMsg> = (service) => {
  return (env, msg) => {
    return service.getKey(env, msg.chainId);
  };
};

const handleBitpokerOpenIntentMsg: (
  service: BitpokerService
) => InternalHandler<BitpokerOpenIntentMsg> = (service) => {
  return (env, msg) => {
    return service.openIntent(env, msg.chainId, {
      gameType: msg.gameType,
      minStake: msg.minStake,
      maxStake: msg.maxStake,
      opponent: msg.opponent,
      playerSessionPubkey: msg.playerSessionPubkey,
      playerTransportPubkey: msg.playerTransportPubkey,
    });
  };
};

const handleBitpokerClaimSessionTimeoutMsg: (
  service: BitpokerService
) => InternalHandler<BitpokerClaimSessionTimeoutMsg> = (service) => {
  return (env, msg) =>
    service.claimSessionTimeout(env, msg.chainId, msg.sessionId);
};

const handleBitpokerCancelIntentMsg: (
  service: BitpokerService
) => InternalHandler<BitpokerCancelIntentMsg> = (service) => {
  return (env, msg) => service.cancelIntent(env, msg.chainId, msg.intentId);
};

const handleBitpokerSubmitResultMsg: (
  service: BitpokerService
) => InternalHandler<BitpokerSubmitResultMsg> = (service) => {
  return (env, msg) => {
    return service.submitResult(env, msg.chainId, {
      sessionId: msg.sessionId,
      winner: msg.winner,
      loser: msg.loser,
      finalStake: msg.finalStake,
      transcriptHash: msg.transcriptHash,
      resultSignature: msg.resultSignature,
      splitPot: msg.splitPot,
      playerAAmount: msg.playerAAmount,
      playerBAmount: msg.playerBAmount,
    });
  };
};

const handleBitpokerSubmitEvidenceMsg: (
  service: BitpokerService
) => InternalHandler<BitpokerSubmitEvidenceMsg> = (service) => {
  return (env, msg) => {
    return service.submitEvidence(env, msg.chainId, {
      sessionId: msg.sessionId,
      evidenceHash: msg.evidenceHash,
      evidencePayloadHex: msg.evidencePayloadHex,
      evidenceSignature: msg.evidenceSignature,
      reason: msg.reason,
    });
  };
};

const handleBitpokerSubmitSecretMsg: (
  service: BitpokerService
) => InternalHandler<BitpokerSubmitSecretMsg> = (service) => {
  return (env, msg) => {
    return service.submitSecret(env, msg.chainId, {
      sessionId: msg.sessionId,
      sessionSecretKeyHex: msg.sessionSecretKeyHex,
      sessionPubkeyHex: msg.sessionPubkeyHex,
    });
  };
};
