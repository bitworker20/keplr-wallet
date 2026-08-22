// GENERATED FILE — DO NOT EDIT.
//
// Source of truth: pokerchain/x/pokerchain/types/gas_bounds.go
// Regenerate:      tools/gen-gas-table.py
// Proof:           pokerchain/x/pokerchain/keeper/gas_bounds_test.go runs every
//                  message below against the most expensive chain state it can
//                  legally meet and asserts the measured gas stays inside these
//                  numbers.
//
// A gas limit is a promise made before the chain runs the message. Promise too
// little and the tx passes CheckTx, reports code 0 to a sync broadcast, and then
// dies at DeliverTx with out-of-gas having paid the fee and done nothing. This
// project shipped that bug five times from hand-written copies of this table;
// the numbers are generated now so there is only one copy to be wrong.

// Saturation guard for a nonsense payload size; never clips a real bound.
export const MAX_MSG_GAS = 128000000;

// The largest evidence payload the chain stores per submitter, and how many
// submissions it keeps per session. Their product is the most bytes an
// adjudication can be asked to read back.
export const MAX_EVIDENCE_PAYLOAD_BYTES = 1048576;
export const MAX_EVIDENCE_SUBMISSIONS = 2;
export const MAX_STORED_EVIDENCE_BYTES =
  MAX_EVIDENCE_PAYLOAD_BYTES * MAX_EVIDENCE_SUBMISSIONS;

// What a message with no entry of its own gets.
export const DEFAULT_MSG_GAS = 300000;

// MsgAdjudicateSession — measured against an adversarial state.
// Scales with: total bytes of evidence_payload stored for the session.
export const GAS_ADJUDICATE_SESSION_BASE = 1000000;
export const GAS_ADJUDICATE_SESSION_PER_BYTE = 12;
export function adjudicateSessionFloor(payloadBytes: number): number {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
    throw new Error("payload size must be a non-negative integer");
  }
  return Math.min(
    GAS_ADJUDICATE_SESSION_BASE +
      GAS_ADJUDICATE_SESSION_PER_BYTE * payloadBytes,
    MAX_MSG_GAS
  );
}

// MsgBeginRelayUnbonding — unverified; see gasBoundExempt.
export const GAS_BEGIN_RELAY_UNBONDING = 300000;

// MsgCancelGameIntent — measured against an adversarial state.
export const GAS_CANCEL_GAME_INTENT = 200000;

// MsgClaimRelayReward — measured against an adversarial state.
export const GAS_CLAIM_RELAY_REWARD = 200000;

// MsgClaimSessionTimeout — measured against an adversarial state.
export const GAS_CLAIM_SESSION_TIMEOUT = 300000;

// MsgIncreaseRelayBond — unverified; see gasBoundExempt.
export const GAS_INCREASE_RELAY_BOND = 300000;

// MsgOpenGameIntent — measured against an adversarial state.
export const GAS_OPEN_GAME_INTENT = 1000000;

// MsgOpenRelayChallenge — unverified; see gasBoundExempt.
export const GAS_OPEN_RELAY_CHALLENGE = 400000;

// MsgProvideRelayEndpoint — measured against an adversarial state.
export const GAS_PROVIDE_RELAY_ENDPOINT = 200000;

// MsgRegisterRelay — measured against an adversarial state.
export const GAS_REGISTER_RELAY = 200000;

// MsgRenewRelayLease — unverified; see gasBoundExempt.
export const GAS_RENEW_RELAY_LEASE = 300000;

// MsgResolveRelayChallenge — unverified; see gasBoundExempt.
export const GAS_RESOLVE_RELAY_CHALLENGE = 400000;

// MsgRespondRelayChallenge — unverified; see gasBoundExempt.
export const GAS_RESPOND_RELAY_CHALLENGE = 400000;

// MsgSetRelayStatus — measured against an adversarial state.
export const GAS_SET_RELAY_STATUS = 200000;

// MsgSubmitSessionEvidence — measured against an adversarial state.
// Scales with: len(evidence_payload).
export const GAS_SUBMIT_SESSION_EVIDENCE_BASE = 400000;
export const GAS_SUBMIT_SESSION_EVIDENCE_PER_BYTE = 60;
export function submitSessionEvidenceFloor(payloadBytes: number): number {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
    throw new Error("payload size must be a non-negative integer");
  }
  return Math.min(
    GAS_SUBMIT_SESSION_EVIDENCE_BASE +
      GAS_SUBMIT_SESSION_EVIDENCE_PER_BYTE * payloadBytes,
    MAX_MSG_GAS
  );
}

// MsgSubmitSessionResult — measured against an adversarial state.
export const GAS_SUBMIT_SESSION_RESULT = 400000;

// MsgSubmitSessionSecret — measured against an adversarial state.
export const GAS_SUBMIT_SESSION_SECRET = 200000;

// MsgUpdateParams — unverified; see gasBoundExempt.
export const GAS_UPDATE_PARAMS = 300000;

// MsgUpdateRelay — unverified; see gasBoundExempt.
export const GAS_UPDATE_RELAY = 400000;

// MsgWithdrawRelayBond — unverified; see gasBoundExempt.
export const GAS_WITHDRAW_RELAY_BOND = 300000;
