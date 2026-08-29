// Rebuild a submit-session-result from a persisted ADR-010 checkpoint.
//
// The recovery card runs in a tab that never played the session — that is the
// whole point of it — so there is no live gamecore hand to ask. The gamecore
// exposes the derivation as a free function for exactly this: it takes the
// double-signed settle bytes and returns the same fields the cooperative path
// files at the end of a session.
//
// Everything is derived from the signed bytes rather than from anything stored
// beside them. The vault is local state, and local state is the one input a
// player can edit; the result filed here has to be the one the opponent's own
// independent filing will match, or the two collide into a dispute instead of
// settling.

import { PokerWorkerClient } from "./worker-client";

export interface CheckpointResultArgs {
  chainSessionId: string;
  playerA: string;
  playerB: string;
  finalStake: string;
  localAddress: string;
  settleHex: string;
}

export interface CheckpointResult {
  error?: string;
  handId?: number;
  winner?: string;
  loser?: string;
  splitPot?: boolean;
  finalStake?: string;
  transcriptHash?: string;
  resultSignature?: string;
  playerAAmount?: string;
  playerBAmount?: string;
}

/**
 * Derive the result for one checkpoint. Spins a throwaway gamecore worker,
 * because this runs once per click on a screen that otherwise has no worker,
 * and a long-lived one would sit in memory for the whole lobby.
 *
 * `worker` is injectable so a caller that already has one (the controller, a
 * test) does not pay for a second.
 */
export async function checkpointResult(
  args: CheckpointResultArgs,
  worker?: Pick<PokerWorkerClient, "buildCheckpointSessionResult">
): Promise<CheckpointResult> {
  if (worker) {
    return worker.buildCheckpointSessionResult(args);
  }
  const owned = new PokerWorkerClient();
  try {
    return await owned.buildCheckpointSessionResult(args);
  } finally {
    owned.terminate();
  }
}
