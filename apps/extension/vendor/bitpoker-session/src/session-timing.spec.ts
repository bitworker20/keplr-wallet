// These numbers are the ones that were wrong: the client used to give the
// local player no action clock at all and treat 30s of peer silence as a
// disconnect, which meant a player who thought for half a minute escalated
// their own live session to an on-chain dispute. The assertions below are the
// arithmetic that has to keep holding, not a restatement of the constants —
// raising one budget without the other has to fail here.
import {
  ACTION_TIMEOUT_MS,
  PEER_SILENCE_GRACE_MS,
  PEER_SILENCE_MS,
  RESUME_ATTEMPTS,
  RESUME_BACKOFF_MS,
  RESUME_CONFIRM_TIMEOUT_MS,
  RESUME_CONNECT_TIMEOUT_MS,
  peerSilenceCoversBothSeats,
  resumeDelayMs,
  resumeFitsPeerSilence,
  totalResumeBudgetMs,
} from "./session-timing";

describe("session timing policy", () => {
  it("lets both seats spend their whole action budget inside one silence budget", () => {
    // Native's `timeout * 2 + 30`: the local seat is bounded by auto-fold, the
    // peer by its own clock, and one silence budget has to cover both.
    expect(peerSilenceCoversBothSeats()).toBe(true);
    expect(PEER_SILENCE_MS).toBe(ACTION_TIMEOUT_MS * 2 + PEER_SILENCE_GRACE_MS);
  });

  it("keeps a margin over the two action budgets rather than exactly meeting them", () => {
    // A silence bound equal to the sum leaves nothing for latency: the peer
    // acting at the last legal moment would still read as gone.
    expect(PEER_SILENCE_MS - ACTION_TIMEOUT_MS * 2).toBeGreaterThan(0);
  });

  it("matches the native peer-silence default of 150s", () => {
    // include/common/player_profile.hpp peerSilenceTimeout() at timeout=60.
    // A native peer applies this bound to us; drifting apart means one side
    // disputes a session the other still thinks is alive.
    expect(PEER_SILENCE_MS).toBe(150_000);
    expect(ACTION_TIMEOUT_MS).toBe(60_000);
  });

  it("never treats a thinking local player as a disconnected peer", () => {
    // The regression this file exists for: the local seat's own clock has to
    // fire first, so the client acts for the player instead of disputing.
    expect(ACTION_TIMEOUT_MS).toBeLessThan(PEER_SILENCE_MS);
  });

  it("backs off linearly after each failure", () => {
    expect(resumeDelayMs(1)).toBe(RESUME_BACKOFF_MS);
    expect(resumeDelayMs(2)).toBe(RESUME_BACKOFF_MS * 2);
    expect(resumeDelayMs(3)).toBe(RESUME_BACKOFF_MS * 3);
  });

  it("treats a zero or negative failure count as the first one", () => {
    expect(resumeDelayMs(0)).toBe(RESUME_BACKOFF_MS);
    expect(resumeDelayMs(-4)).toBe(RESUME_BACKOFF_MS);
  });

  it("does not delay the first attempt", () => {
    // A relay that bounced is often already back; making the player wait a
    // second to find that out is pure latency on the common recovery.
    const perAttempt = RESUME_CONNECT_TIMEOUT_MS + RESUME_CONFIRM_TIMEOUT_MS;
    expect(totalResumeBudgetMs(1)).toBe(perAttempt);
    expect(totalResumeBudgetMs(2)).toBe(perAttempt * 2 + resumeDelayMs(1));
  });

  it("confirms the peer answered quickly rather than tolerating a full thinking turn", () => {
    // The regression this constant exists for: reusing PEER_SILENCE_MS per
    // attempt let 3 attempts push the worst case past 10 minutes while the
    // relay stayed reachable throughout — see session-timing.ts.
    expect(RESUME_CONFIRM_TIMEOUT_MS).toBeLessThan(PEER_SILENCE_MS);
  });

  it("finishes reconnecting before the peer's silence budget expires", () => {
    // While we reconnect, the peer hears nothing from us and is running the
    // same clock. Recovery that outlasts it makes the opponent dispute the
    // session we are busy rescuing.
    expect(resumeFitsPeerSilence()).toBe(true);
    expect(totalResumeBudgetMs()).toBeLessThan(PEER_SILENCE_MS);
  });

  it("keeps the retry count small enough to stay inside that budget", () => {
    // Guards the tempting "just retry more times" edit: the budget grows with
    // the retry count and there is a real ceiling above it.
    expect(totalResumeBudgetMs(RESUME_ATTEMPTS)).toBeLessThan(PEER_SILENCE_MS);
    expect(totalResumeBudgetMs(RESUME_ATTEMPTS + 1)).toBeGreaterThan(
      totalResumeBudgetMs(RESUME_ATTEMPTS)
    );
    expect(totalResumeBudgetMs(20)).toBeGreaterThan(PEER_SILENCE_MS);
  });
});
