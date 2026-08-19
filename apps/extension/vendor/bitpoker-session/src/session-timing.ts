// How long a live session waits — for the local player, for the peer, and for
// a dropped transport to come back.
//
// These four numbers decide whether a session that is merely SLOW gets turned
// into an on-chain dispute, so they are here (with the arithmetic that ties
// them together) rather than inline at the call sites. Getting them wrong is
// not a UI glitch: escalating means the escrow is locked until adjudication
// and the dispute fee comes out of the at-fault side's payout (ADR-004).
//
// They mirror the native client's policy, whose reasoning is worth repeating
// from include/common/player_profile.hpp:
//
//   Declaring a slow but honest opponent dead would escalate a live game into
//   a dispute over real money, which is far worse than waiting.
//
// Native derives its peer-silence bound as `timeout * 2 + 30` — twice the
// action budget (each seat may spend one) plus a grace margin. The same
// derivation is spelled out below, and `peerSilenceCoversBothSeats()` asserts
// it holds, so raising the action budget without raising the silence bound
// cannot slip through.

// What the local player gets to think for before the client acts for them.
// A local policy, not a protocol rule — its job is to make this client's own
// occupancy predictable, which is what makes the peer's bound below sound.
export const ACTION_TIMEOUT_MS = 60_000;

// Slack on top of both seats' action budgets: network latency, a paced frame
// burst, a peer whose own clock is a little more generous than ours.
export const PEER_SILENCE_GRACE_MS = 30_000;

// How long to hear nothing at all from the peer before treating the link as
// broken. One budget covers the whole cycle — the local seat spends at most
// ACTION_TIMEOUT_MS (auto-fold guarantees it), then the peer spends at most
// its own — so there is no need to vary it by whose turn it is.
export const PEER_SILENCE_MS = ACTION_TIMEOUT_MS * 2 + PEER_SILENCE_GRACE_MS; // 150s

// Transport recovery before escalating: reconnect the websocket and replay the
// game-layer resync (the gamecore's makeResyncFrame). Matches native's
// relayResumeAttempts / relayReconnectBackoffMilliseconds defaults.
export const RESUME_ATTEMPTS = 3;
export const RESUME_BACKOFF_MS = 1_000;

// A reconnect that never resolves would strand the player with neither a game
// nor a way out, so each attempt is bounded.
export const RESUME_CONNECT_TIMEOUT_MS = 10_000;

// How long to wait after the Nth failed attempt before the next one: linear,
// counted from 1 (so 1s, 2s, 3s). The FIRST attempt is not delayed — the
// common case is a relay that bounced and is already back — so a run of n
// attempts pays delays 1..n-1.
export function resumeDelayMs(failedAttempts: number): number {
  return Math.max(1, Math.trunc(failedAttempts)) * RESUME_BACKOFF_MS;
}

// Worst-case wall time spent trying to recover before we give up and escalate.
// This is time during which the PEER hears nothing from us, so it has to stay
// inside the peer's own silence budget — otherwise our recovery attempt is
// what makes the opponent dispute the session.
export function totalResumeBudgetMs(
  attempts: number = RESUME_ATTEMPTS
): number {
  let total = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      total += resumeDelayMs(attempt - 1);
    }
    total += RESUME_CONNECT_TIMEOUT_MS;
  }
  return total;
}

// The invariant native encodes as `timeout * 2 + 30`: one silence budget must
// cover both seats using their full action budget back to back.
export function peerSilenceCoversBothSeats(): boolean {
  return PEER_SILENCE_MS >= ACTION_TIMEOUT_MS * 2;
}

// Whether a full recovery attempt fits inside the budget the peer is applying
// to us at the same time.
export function resumeFitsPeerSilence(): boolean {
  return totalResumeBudgetMs() < PEER_SILENCE_MS;
}
