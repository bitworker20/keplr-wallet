// What a rejected transaction means for whoever sent it (ADR-008 §2.6).
//
// A client that cannot tell "ask again" from "the chain will refuse this
// forever" has exactly one behaviour available: ask again. That is how session
// 101 on poker-milestone2-test broadcast the same doomed MsgAdjudicateSession
// eighty-nine times — each accepted at CheckTx, each dead at DeliverTx with the
// same code, each paying a fee.
//
// This mirrors pokerchain's own ClassifyTxFailure (x/pokerchain/types) and the
// native client's chain_tx_outcome.hpp. The three are the same table because
// the chain's refusals mean the same thing to every client.

// The SDK's root codespace.
const SDK_CODESPACE = "sdk";

// SDK root-codespace codes a client has to be able to name.
const SDK_OUT_OF_GAS = 11;
const SDK_INSUFFICIENT_FEE = 13;
const SDK_TX_IN_MEMPOOL_CACHE = 19;
const SDK_MEMPOOL_IS_FULL = 20;
const SDK_WRONG_SEQUENCE = 32;

// The pokerchain module's codespace, and the module codes a client acts on
// rather than merely reporting. Mirrors x/pokerchain/types/errors.go and the
// native client's chain_tx_outcome.hpp.
export const POKERCHAIN_CODESPACE = "pokerchain";

// Adjudication has no transcript on chain to decide this hand from — yet. It
// reads as terminal (it is a module error) but the remedy is local and the
// opposite of stopping: file the transcript this client kept, then ask again.
export const CODE_ADJUDICATION_NO_EVIDENCE = 1109;

export function isAdjudicationNoEvidence(
  code: number,
  codespace?: string
): boolean {
  return (
    code === CODE_ADJUDICATION_NO_EVIDENCE && codespace === POKERCHAIN_CODESPACE
  );
}

export type TxFailureClass =
  // Nothing about the message is wrong: the chain was busy, or our own previous
  // transaction had not landed yet. Send it again unchanged.
  | "transient"
  // The message is right but the budget was not. Worth one repriced retry.
  | "underfunded"
  // The chain refused it on its merits and will refuse it again for as long as
  // the session looks the way it does now.
  | "terminal";

// Module errors — anything outside the SDK's root codespace — are all terminal.
// That is the conservative reading: pokerchain refuses a message because of what
// the SESSION looks like, and none of those resolve by repeating the same
// message a minute later. What resolves them is the session changing, and a
// caller that re-reads and re-decides sends a DIFFERENT message.
//
// Note the collision this prevents: pokerchain's code 11 is not the SDK's
// out-of-gas.
export function txFailureClass(
  code: number,
  codespace?: string
): TxFailureClass {
  if (!code) {
    return "transient"; // not a failure; the caller should not be asking
  }
  if (codespace && codespace !== SDK_CODESPACE) {
    return "terminal";
  }
  switch (code) {
    case SDK_OUT_OF_GAS:
      return "underfunded";
    case SDK_INSUFFICIENT_FEE:
    case SDK_TX_IN_MEMPOOL_CACHE:
    case SDK_MEMPOOL_IS_FULL:
    case SDK_WRONG_SEQUENCE:
      return "transient";
    default:
      return "terminal";
  }
}
