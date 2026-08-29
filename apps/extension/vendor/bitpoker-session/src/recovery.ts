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
//   DISPUTED, long past its deadline    pure refund with no engine, once the
//                                       session's snapshotted
//                                       dispute_refund_height passes. This
//                                       is the backstop for when adjudication
//                                       itself cannot run (node without cgo,
//                                       out-of-gas on a huge transcript).
//
// A DISPUTED session otherwise needs the other three, in order:
//
//   MsgSubmitSessionEvidence            put this hand's transcript on chain
//                                       before dispute_response_height.
//                                       A dispute is decided by whichever
//                                       transcript reaches the engine, and with
//                                       none on chain the engine decides
//                                       nothing — past the deadline that is a
//                                       refund, which is precisely what the
//                                       loser of a finished hand is angling for
//                                       (session 40). transcript-vault.ts is
//                                       what still has it after the tab that
//                                       played the hand is gone.
//   MsgSubmitSessionSecret              disclose this seat's per-hand key
//                                       before the same response height, so
//                                       the engine scores the cards this
//                                       player actually held instead of
//                                       treating the hand as forfeited
//   MsgAdjudicateSession                at dispute_response_height, run the
//                                       engine once over both frozen response
//                                       slots and pay out.
//
// A client that never offers these leaves the player watching an escrow they
// cannot touch. The native client does it from its retreat flow
// (client/session_recovery.cpp); this is the browser's smaller version of the
// same idea: say what is recoverable, and let the player press the button.

import { sessionIdentityForIntent } from "./session-vault";
import { checkpointForSession, transcriptForSession } from "./transcript-vault";

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
  // Evidence/secret submissions close and adjudication opens at this height.
  dispute_response_height?: string;
  // Snapshotted on entry to DISPUTED. Zero/absent means legacy state has not
  // been migrated; never reconstruct it from mutable params in the client.
  dispute_refund_height?: string;
  adjudication?: unknown;
}

// What the client knows about a disputed session beyond the session record
// itself. Passed in rather than fetched here so this stays a pure function.
export interface DisputeContext {
  // This seat still holds an undisclosed session secret (session-vault.ts).
  heldSecret?: boolean;
  // Somebody has submitted evidence, so the engine has a hand to replay.
  evidenceOnChain?: boolean;
  // This browser still holds the transcript of the hand (transcript-vault.ts)
  // and has not put it on chain yet. Proof this seat has and the chain does not
  // is the difference between a verdict and a refund.
  keptTranscript?: boolean;
  myEvidenceOnChain?: boolean;
  // A MsgAdjudicateSession for this session has already been refused by the
  // chain. Set it after an attempt comes back with a non-zero code — a
  // validator built without the cgo engine rejects every one of them, and no
  // amount of gas or patience changes that. It is the only thing that opens the
  // no-engine refund, so the verdict always gets its chance first.
  adjudicationRefused?: boolean;
  // This browser holds the last double-signed settle of a completed hand
  // (transcript-vault.ts). It is the ADR-010 checkpoint, and it turns an
  // interrupted session from "wait fourteen hours and get your buy-in back"
  // into "file what both of us already signed" — which, when both seats do it
  // independently, settles cooperatively at the real standings.
  keptCheckpoint?: boolean;
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
export type RecoveryAction =
  | "refund"
  | "escalate"
  | "prove"
  | "reveal"
  | "adjudicate"
  // File the last double-signed settle as this session's result (ADR-010).
  | "checkpoint";

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
    // A checkpoint beats every deadline below it. Those all pay the buy-ins
    // back, which is the wrong answer for a session that got two hands in: the
    // hands that finished were settled by both signatures and the money has
    // already moved. Filing it is also the only exit that does not need the
    // opponent to be present — an identical filing from them settles
    // cooperatively, and a contradicting one goes to an engine that will read
    // the same checkpoint.
    if (dispute.keptCheckpoint) {
      return {
        kind: "ready",
        action: "checkpoint",
        atHeight: 0,
        reason:
          "file the last hand you and your opponent both signed, and settle at " +
          "those standings instead of waiting out the abandonment timeout",
      };
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
      if (dispute.keptCheckpoint) {
        return {
          kind: "ready",
          action: "checkpoint",
          atHeight: 0,
          reason:
            "your opponent filed a result — file the last hand you both signed; " +
            "if it agrees the session settles, and if it does not the engine decides",
        };
      }
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
    const responseAt = Number(session.dispute_response_height ?? "0");
    const hasResponseBoundary =
      Number.isSafeInteger(responseAt) && responseAt > 0;
    const responseOpen = !hasResponseBoundary || chainHeight < responseAt;
    const refundAt = Number(session.dispute_refund_height ?? "0");
    const hatchOpen =
      Number.isSafeInteger(refundAt) && refundAt > 0 && chainHeight >= refundAt;

    // A VERDICT FIRST, always — even once the engine-independent hatch is open.
    //
    // This used to offer the refund the moment the hatch opened, on the
    // reasoning that it avoided a needless key disclosure. That trade was never
    // real: adjudication scores an UNDISCLOSED secret as a forfeit, so revealing
    // is never worse for this seat than staying quiet, and the key is per-hand
    // and spent the moment the hand was disputed (the chain refuses to let it be
    // committed again). What it cost instead was the outcome — on a session
    // where the engine would forfeit the other seat, whichever client polled
    // first refunded, and "who ticks first" replaced the verdict as the
    // settlement rule (ADR-008 §2.5).
    //
    // So the hatch is only offered once the chain has actually refused a
    // verdict, which the caller reports through the dispute context.
    if (hatchOpen && dispute.adjudicationRefused) {
      return {
        kind: "ready",
        action: "refund",
        atHeight: refundAt,
        reason:
          "the chain will not produce a verdict for this dispute; both stakes can be refunded without the engine",
      };
    }
    // Proof before anything else. The engine decides this hand from the
    // transcripts on chain; holding the only copy of ours while asking for a
    // verdict asks the chain to decide on the opponent's version of it — or,
    // with nothing on chain at all, to refund a hand we may have won.
    if (responseOpen && dispute.keptTranscript && !dispute.myEvidenceOnChain) {
      return {
        kind: "ready",
        action: "prove",
        atHeight: 0,
        reason:
          "under dispute — file this hand's transcript, or the chain decides " +
          "it without your side of the story",
      };
    }
    // Reveal before verdict: an undisclosed secret is scored as a forfeit, so
    // asking for a verdict while still holding one throws the hand away.
    if (responseOpen && dispute.heldSecret) {
      return {
        kind: "ready",
        action: "reveal",
        atHeight: 0,
        reason:
          "under dispute — reveal your cards first, or the adjudicator " +
          "scores this hand as forfeited",
      };
    }
    if (hasResponseBoundary) {
      return chainHeight < responseAt
        ? {
            kind: "wait",
            action: "adjudicate",
            atHeight: responseAt,
            reason:
              "your response is complete — waiting for the opponent's response window to close",
          }
        : {
            kind: "ready",
            action: "adjudicate",
            atHeight: responseAt,
            reason: hatchOpen
              ? "responses are frozen — ask the chain for a verdict; if it cannot give one, a no-engine refund is available"
              : "responses are frozen — ask the chain for a verdict",
          };
    }
    const deadline = Number(session.dispute_deadline_height ?? "0");
    if (dispute.evidenceOnChain) {
      return {
        kind: "ready",
        action: "adjudicate",
        atHeight: 0,
        reason: hatchOpen
          ? "under dispute — ask the chain for a verdict; if it cannot give one, " +
            "a no-engine refund of both stakes is already available"
          : "under dispute — ask the chain for a verdict",
      };
    }
    // No evidence was ever submitted, so the engine has nothing to replay and
    // the chain rejects an adjudication outright. Past the dispute deadline it
    // stops rejecting and refunds each seat its own stake instead, which is
    // the only way this escrow ever comes back before the long hatch.
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

// Who has put evidence on chain for this session. Two different questions are
// asked of this list: whether the engine has any hand to replay at all, and
// whether OUR transcript is among them — the chain keeps one canonical payload
// per player and refuses a second, so filing twice is a wasted fee.
export async function fetchEvidenceSubmitters(
  lcdUrl: string,
  sessionId: string
): Promise<string[]> {
  try {
    const res = await fetch(
      `${lcdUrl.replace(
        /\/+$/,
        ""
      )}/pokerchain/pokerchain/v1/sessions/${sessionId}/evidence`
    );
    if (!res.ok) {
      return [];
    }
    const evidence = (await res.json())?.evidence;
    if (!Array.isArray(evidence)) {
      return [];
    }
    return evidence
      .map((item: { submitter?: string }) => item?.submitter ?? "")
      .filter((submitter: string) => submitter.length > 0);
  } catch {
    return [];
  }
}

// Whether anyone has put evidence on chain for this session — i.e. whether the
// adjudication engine has a hand to replay at all.
export async function fetchHasEvidence(
  lcdUrl: string,
  sessionId: string
): Promise<boolean> {
  return (await fetchEvidenceSubmitters(lcdUrl, sessionId)).length > 0;
}

// This account's sessions that have not finished, with what can be done about
// each. Sorted by what is actionable now.
export async function fetchRecoverableSessions(
  lcdUrl: string,
  address: string,
  chainHeight: number,
  // Session ids whose adjudication this client has already seen the chain
  // refuse. Without it a session on an engine-less node would offer "ask for a
  // verdict" forever and never the refund that actually works; with it, the
  // refund appears only after the verdict route has been tried and failed
  // (ADR-008 §2.5).
  adjudicationRefused: ReadonlySet<string> = new Set()
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
      // The checkpoint question is asked for every unfinished session, not only
      // disputed ones: it is what ACTIVE and RESULT_PENDING now offer instead
      // of waiting out a timeout, and it is a local read.
      let dispute: DisputeContext = {
        keptCheckpoint: !!(await checkpointForSession(
          session.session_id,
          address
        )),
      };
      if (session.status === DISPUTED) {
        const submitters = await fetchEvidenceSubmitters(
          base,
          session.session_id
        );
        dispute = {
          ...dispute,
          heldSecret: !!(intentId && sessionIdentityForIntent(intentId)),
          evidenceOnChain: submitters.length > 0,
          keptTranscript: !!(await transcriptForSession(
            session.session_id,
            address
          )),
          myEvidenceOnChain: submitters.includes(address),
          adjudicationRefused: adjudicationRefused.has(session.session_id),
        };
      }
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
