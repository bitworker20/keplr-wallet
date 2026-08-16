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
// A client that never offers this leaves the player watching an escrow they
// cannot touch. The native client does it from its retreat flow
// (client/session_recovery.cpp); this is the browser's smaller version of the
// same idea: say what is recoverable, and let the player press the button.

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
}

export type RecoveryKind =
  // Claimable now: the escrow comes back to both players.
  | "refund"
  // Claimable now: escalates to adjudication (the opponent owes a result).
  | "escalate"
  // Claimable later; `atHeight` says when.
  | "wait"
  // Nothing this client can do about it.
  | "none";

export interface SessionRecovery {
  kind: RecoveryKind;
  // The height the claim becomes available, for "wait".
  atHeight: number;
  // One line for the player, phrased as what it does to their money.
  reason: string;
}

const ACTIVE = "GAME_SESSION_STATUS_ACTIVE";
const RESULT_PENDING = "GAME_SESSION_STATUS_RESULT_PENDING";

// Which sessions to ask the chain about. DISPUTED is deliberately absent: it
// is already on its way to adjudication and MsgClaimSessionTimeout does not
// apply to it.
export const UNFINISHED_SESSION_STATUSES = [1, 2] as const;

export function sessionRecovery(
  session: ChainGameSession,
  chainHeight: number,
  me: string
): SessionRecovery {
  const none = (reason: string): SessionRecovery => ({
    kind: "none",
    atHeight: 0,
    reason,
  });
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
      return chainHeight >= answerDeadline
        ? {
            kind: "refund",
            atHeight: answerDeadline,
            reason: "no relay took this game; both stakes can be refunded",
          }
        : {
            kind: "wait",
            atHeight: answerDeadline,
            reason: "waiting for a relay to take this game",
          };
    }
    const activeDeadline = Number(session.active_deadline_height ?? "0");
    if (activeDeadline === 0) {
      return none("this chain does not time out abandoned sessions");
    }
    return chainHeight >= activeDeadline
      ? {
          kind: "refund",
          atHeight: activeDeadline,
          reason: "nobody played this game; both stakes can be refunded",
        }
      : {
          kind: "wait",
          atHeight: activeDeadline,
          reason: "abandoned, but the refund deadline has not passed yet",
        };
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
    return chainHeight >= deadline
      ? {
          kind: "escalate",
          atHeight: deadline,
          reason:
            "your opponent never confirmed the result; this sends it to " +
            "adjudication",
        }
      : {
          kind: "wait",
          atHeight: deadline,
          reason: "waiting for your opponent to confirm the result",
        };
  }

  return none("nothing to recover");
}

export interface RecoverableSession {
  session: ChainGameSession;
  recovery: SessionRecovery;
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
      const recovery = sessionRecovery(session, chainHeight, address);
      if (recovery.kind !== "none") {
        out.push({ session, recovery });
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
