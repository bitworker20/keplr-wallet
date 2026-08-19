// What a settled session actually pays this seat, reconciled from the seat's
// point of view.
//
// The player risked a stake and wants to check four numbers against each
// other: what they put up, what the table said they won, what the relay took,
// and what will land in the wallet. The chain settles on GROSS chip stacks and
// carves the relay rake out of them pro rata (largest remainder), so a client
// that reports only the gross figure is quoting a number the wallet will never
// match — and the difference looks like a missing payment rather than a fee.
//
// The arithmetic is the gamecore's, not this module's: buildSessionResult
// returns both the gross amounts and the net ones the chain will pay, and this
// only picks the local seat's side and checks the identity holds. Mirrors the
// native SettlementReport (include/client/settlement_report.hpp) so the two
// clients reconcile the same way.

import { uchipAdd, uchipEquals, uchipLessThan, uchipSub } from "./chip";

// The subset of the gamecore's buildSessionResult output this needs. Amounts
// are uint64-as-string uchip (JS numbers lose precision past 2^53).
export interface SessionResultAmounts {
  playerAAmount?: string;
  playerBAmount?: string;
  netPlayerAAmount?: string;
  netPlayerBAmount?: string;
  relayFee?: string;
  splitPot?: boolean;
}

export interface SettlementReport {
  sessionId: string;
  localIsPlayerA: boolean;
  // Per-seat escrow: what was risked, next to what came back.
  stake: string;
  // Chip stacks the session ended on (these sum to both stakes).
  grossMine: string;
  grossTheirs: string;
  // Each seat's share of the relay rake. feeMine + feeTheirs == relayFeeTotal.
  feeMine: string;
  feeTheirs: string;
  // What the chain actually pays: gross - fee.
  netMine: string;
  netTheirs: string;
  relayFeeTotal: string;
  splitPot: boolean;
  // True when this seat's gross beat the opponent's. Meaningless on a split.
  won: boolean;
  // False means the escrow has NOT been released: the session sits in
  // RESULT_PENDING until the opponent submits or someone claims the timeout.
  // The UI must not tell the player the money arrived.
  submitted: boolean;
  // Set when the numbers do not reconcile, which is a bug rather than a
  // settlement the player should act on.
  error?: string;
}

const amount = (value: string | undefined): string => (value ?? "0").trim();

export function buildSettlementReport(args: {
  sessionId: string;
  localIsPlayerA: boolean;
  stake: string;
  amounts: SessionResultAmounts;
  submitted: boolean;
}): SettlementReport {
  const { sessionId, localIsPlayerA, stake, amounts, submitted } = args;

  const pick = (a?: string, b?: string) => (localIsPlayerA ? a : b);
  const grossMine = amount(pick(amounts.playerAAmount, amounts.playerBAmount));
  const grossTheirs = amount(
    pick(amounts.playerBAmount, amounts.playerAAmount)
  );
  const netMine = amount(
    pick(amounts.netPlayerAAmount, amounts.netPlayerBAmount)
  );
  const netTheirs = amount(
    pick(amounts.netPlayerBAmount, amounts.netPlayerAAmount)
  );
  const relayFeeTotal = amount(amounts.relayFee);

  // A fee is gross - net, but a malformed settlement can have net above gross,
  // and this function's job is to REPORT that rather than throw in the middle
  // of rendering it.
  const fee = (gross: string, net: string): string | undefined =>
    uchipLessThan(gross, net) ? undefined : uchipSub(gross, net);
  const feeMine = fee(grossMine, netMine);
  const feeTheirs = fee(grossTheirs, netTheirs);

  const report: SettlementReport = {
    sessionId,
    localIsPlayerA,
    stake,
    grossMine,
    grossTheirs,
    feeMine: feeMine ?? "0",
    feeTheirs: feeTheirs ?? "0",
    netMine,
    netTheirs,
    relayFeeTotal,
    splitPot: amounts.splitPot === true,
    won: uchipLessThan(grossTheirs, grossMine),
    submitted,
  };

  // Two identities the chain enforces; if either fails here, the figures on
  // screen would not add up and saying so is better than showing them.
  const grossTotal = uchipAdd(grossMine, grossTheirs);
  const escrowTotal = uchipAdd(stake, stake);
  if (feeMine === undefined || feeTheirs === undefined) {
    report.error = `a seat is paid more than it won: net ${netMine}/${netTheirs} against gross ${grossMine}/${grossTheirs}`;
  } else if (!uchipEquals(grossTotal, escrowTotal)) {
    report.error = `settlement does not conserve the escrow: ${grossMine} + ${grossTheirs} != 2 x ${stake}`;
  } else if (
    !uchipEquals(
      uchipAdd(uchipAdd(netMine, netTheirs), relayFeeTotal),
      grossTotal
    )
  ) {
    report.error = `relay fee does not reconcile: ${netMine} + ${netTheirs} + ${relayFeeTotal} != ${grossTotal}`;
  }
  return report;
}
