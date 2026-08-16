// Getting a player's money out of a session that stopped moving.
//
// Three things can leave a stake escrowed with nothing to play for, and the
// chain gives exactly one message to get out of each: MsgClaimSessionTimeout.
// What it does depends on the session:
//
//   ACTIVE, nobody ever played          void it, both stakes refunded, once
//                                       active_deadline_height passes
//                                       (~14h at the default params)
//   ACTIVE, no relay ever answered      the same void, but on the much
//                                       shorter relay answer deadline — the
//                                       players are blameless
//   RESULT_PENDING, opponent silent     mark it DISPUTED so the adjudicator
//                                       can decide, once
//                                       result_deadline_height passes
//                                       (~100s at the default params)
//
// A DISPUTED session is past that message and needs the other two, in order:
//
//   MsgSubmitSessionSecret              disclose this seat's per-hand key, so
//                                       the engine scores the cards this
//                                       player actually held instead of
//                                       treating the hand as forfeited
//   MsgAdjudicateSession                run the engine and pay out. Nothing
//                                       else releases a disputed escrow, and
//                                       until dispute_deadline_height only the
//                                       two players may send it
//
// A client that never offers these leaves the player watching an escrow they
// cannot touch. The native client does it from its retreat flow
// (client/session_recovery.cpp); this is the browser's smaller version of the
// same idea: say what is recoverable, and let the player press the button.

import { sessionIdentityForIntent } from "./session-vault";

export interface ChainGameSession {
  session_id: string;
  player_a: string;
  player_b: string;
  status: string;
  stake: string;
  active_deadline_height?: string;
  result_deadline_height?: string;
  relay_answer_deadline_height?: string;
  relay_endpoint_answer?: unknown;
  player_a_result?: unknown;
  player_b_result?: unknown;
  player_a_intent_id?: string;
  player_b_intent_id?: string;
  dispute_deadline_height?: string;
  adjudication?: unknown;
}

// What the client knows about a disputed session beyond the session record
// itself. Passed in rather than fetched here so this stays a pure function.
export interface DisputeContext {
  // This seat still holds an undisclosed session secret (session-vault.ts).
  heldSecret?: boolean;
  // Somebody has submitted evidence, so the engine has a hand to replay.
  evidenceOnChain?: boolean;
}

// Whether the claim can be sent yet.
export type RecoveryKind =
  // Claimable now.
  | "ready"
  // Claimable once `atHeight` passes.
  | "wait"
  // Nothing this client can do about it.
  | "none";

// What sending it will do. Kept separate from `kind` so a session that is
// still counting down can still be labelled honestly — a RESULT_PENDING
// session says "send to adjudication" while it waits, not "refund".
export type RecoveryAction = "refund" | "escalate" | "reveal" | "adjudicate";

export interface SessionRecovery {
  kind: RecoveryKind;
  action: RecoveryAction;
  // The height the claim becomes available, for "wait".
  atHeight: number;
  // One line for the player, phrased as what it does to their money.
  reason: string;
}

const ACTIVE = "GAME_SESSION_STATUS_ACTIVE";
const RESULT_PENDING = "GAME_SESSION_STATUS_RESULT_PENDING";
const DISPUTED = "GAME_SESSION_STATUS_DISPUTED";

// Which sessions to ask the chain about, as the numeric enum the gateway
// parses: ACTIVE, RESULT_PENDING, DISPUTED. (3 is SETTLED and 5 CANCELLED —
// both finished.)
export const UNFINISHED_SESSION_STATUSES = [1, 2, 4] as const;

export function sessionRecovery(
  session: ChainGameSession,
  chainHeight: number,
  me: string,
  dispute: DisputeContext = {}
): SessionRecovery {
  const none = (reason: string): SessionRecovery => ({
    kind: "none",
    action: "refund",
    atHeight: 0,
    reason,
  });
  const at = (
    deadline: number,
    action: RecoveryAction,
    ready: string,
    waiting: string
  ): SessionRecovery =>
    chainHeight >= deadline
      ? { kind: "ready", action, atHeight: deadline, reason: ready }
      : { kind: "wait", action, atHeight: deadline, reason: waiting };
  if (session.player_a !== me && session.player_b !== me) {
    return none("not your session");
  }

  if (session.status === ACTIVE) {
    // A session carrying a result is not abandoned, whatever its status says;
    // the chain refuses to void it and would be right to.
    if (session.player_a_result || session.player_b_result) {
      return none("a result has already been submitted");
    }
    // ADR-007: a session no relay ever answered has a much shorter deadline —
    // neither player could have played it.
    const answerDeadline = Number(session.relay_answer_deadline_height ?? "0");
    if (!session.relay_endpoint_answer && answerDeadline > 0) {
      return at(
        answerDeadline,
        "refund",
        "no relay took this game; both stakes can be refunded",
        "waiting for a relay to take this game"
      );
    }
    const activeDeadline = Number(session.active_deadline_height ?? "0");
    if (activeDeadline === 0) {
      return none("this chain does not time out abandoned sessions");
    }
    return at(
      activeDeadline,
      "refund",
      "nobody played this game; both stakes can be refunded",
      "abandoned, but the refund deadline has not passed yet"
    );
  }

  if (session.status === RESULT_PENDING) {
    const mine =
      session.player_a === me
        ? session.player_a_result
        : session.player_b_result;
    if (!mine) {
      // The chain only lets the seat that already submitted claim here, and
      // submitting is the better move anyway: two matching results settle.
      return none("submit your result first");
    }
    const deadline = Number(session.result_deadline_height ?? "0");
    if (deadline === 0) {
      return none("this session has no result deadline");
    }
    return at(
      deadline,
      "escalate",
      "your opponent never confirmed the result; this sends it to adjudication",
      "waiting for your opponent to confirm the result"
    );
  }

  if (session.status === DISPUTED) {
    // Reveal before verdict: an undisclosed secret is scored as a forfeit, so
    // asking for a verdict while still holding one throws the hand away.
    if (dispute.heldSecret) {
      return {
        kind: "ready",
        action: "reveal",
        atHeight: 0,
        reason:
          "under dispute — reveal your cards first, or the adjudicator " +
          "scores this hand as forfeited",
      };
    }
    if (dispute.evidenceOnChain) {
      return {
        kind: "ready",
        action: "adjudicate",
        atHeight: 0,
        reason: "under dispute — ask the chain for a verdict",
      };
    }
    // No evidence was ever submitted, so the engine has nothing to replay and
    // the chain rejects an adjudication outright. Past the dispute deadline it
    // stops rejecting and refunds each seat its own stake instead, which is
    // the only way this escrow ever comes back.
    const deadline = Number(session.dispute_deadline_height ?? "0");
    if (deadline === 0) {
      return none(
        "under dispute, with no evidence and no deadline to force a verdict"
      );
    }
    return at(
      deadline,
      "adjudicate",
      "nobody submitted evidence; a verdict now refunds both stakes",
      "under dispute, but nobody submitted evidence — a verdict is only possible after the deadline"
    );
  }

  return none("nothing to recover");
}

export interface RecoverableSession {
  session: ChainGameSession;
  recovery: SessionRecovery;
  // Set for a disputed session this seat can still reveal a secret for: the
  // intent the stored identity is filed under.
  intentId?: string;
}

// The intent this account committed its session pubkey in, which is where its
// stored secret is filed and which pubkey the chain checks a reveal against.
export function myIntentId(
  session: ChainGameSession,
  me: string
): string | undefined {
  if (session.player_a === me) {
    return session.player_a_intent_id;
  }
  if (session.player_b === me) {
    return session.player_b_intent_id;
  }
  return undefined;
}

// Whether anyone has put evidence on chain for this session — i.e. whether the
// adjudication engine has a hand to replay at all.
export async function fetchHasEvidence(
  lcdUrl: string,
  sessionId: string
): Promise<boolean> {
  try {
    const res = await fetch(
      `${lcdUrl.replace(
        /\/+$/,
        ""
      )}/pokerchain/pokerchain/v1/sessions/${sessionId}/evidence`
    );
    if (!res.ok) {
      return false;
    }
    const evidence = (await res.json())?.evidence;
    return Array.isArray(evidence) && evidence.length > 0;
  } catch {
    return false;
  }
}

// This account's sessions that have not finished, with what can be done about
// each. Sorted by what is actionable now.
export async function fetchRecoverableSessions(
  lcdUrl: string,
  address: string,
  chainHeight: number
): Promise<RecoverableSession[]> {
  const base = lcdUrl.replace(/\/+$/, "");
  const out: RecoverableSession[] = [];
  for (const status of UNFINISHED_SESSION_STATUSES) {
    let sessions: ChainGameSession[] = [];
    try {
      // The status enum goes over the wire as its NUMBER: this gateway parses
      // enum query parameters with strconv.ParseInt (the same trap the lobby
      // query hit).
      const res = await fetch(
        `${base}/pokerchain/pokerchain/v1/sessions?player=${address}&status=${status}`
      );
      if (!res.ok) {
        continue;
      }
      sessions = (await res.json())?.sessions ?? [];
    } catch {
      continue;
    }
    for (const session of sessions) {
      // Only a disputed session needs the extra two questions, and they cost a
      // request each.
      const intentId = myIntentId(session, address);
      const dispute: DisputeContext =
        session.status === DISPUTED
          ? {
              heldSecret: !!(intentId && sessionIdentityForIntent(intentId)),
              evidenceOnChain: await fetchHasEvidence(base, session.session_id),
            }
          : {};
      const recovery = sessionRecovery(session, chainHeight, address, dispute);
      if (recovery.kind !== "none") {
        out.push({ session, recovery, intentId });
      }
    }
  }
  const rank = (r: SessionRecovery): number => (r.kind === "wait" ? 1 : 0);
  return out.sort(
    (a, b) =>
      rank(a.recovery) - rank(b.recovery) ||
      Number(a.session.session_id) - Number(b.session.session_id)
  );
}
