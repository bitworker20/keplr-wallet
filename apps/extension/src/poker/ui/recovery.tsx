import React, { useCallback, useEffect, useRef, useState } from "react";
import { formatChip } from "@bitpoker/poker-session/chip";
import { fetchChainHeight } from "@bitpoker/poker-session/lobby";
import {
  ChainGameSession,
  RecoverableSession,
  RecoveryAction,
  fetchRecoverableSessions,
} from "@bitpoker/poker-session/recovery";
import {
  forgetSessionIdentity,
  sessionIdentityForIntent,
} from "@bitpoker/poker-session/session-vault";
import {
  checkpointForSession,
  transcriptForSession,
} from "@bitpoker/poker-session/transcript-vault";
import { checkpointResult } from "@bitpoker/poker-session/checkpoint-result";
import { txFailureClass } from "@bitpoker/poker-session/tx-failure";
import { PokerWalletBridge } from "@bitpoker/poker-session/wallet-bridge";
import { styles } from "./styles";

// Sessions that stopped moving, and the one button that gets the money out.
//
// This page had none of this, and the omission was not cosmetic. A matched
// session escrows both stakes, and a hand that has been PLAYED is not finished
// until the chain says SETTLED: the opponent can still file a contradicting
// result, and the chain then decides the hand from whichever transcript reaches
// it. A player who closed the tab after winning could not file theirs, so the
// loser of a finished hand could open a dispute, wait out the window, and
// collect a refund of a hand they had lost — the session-40 attack, still live
// for this client while the standalone web client had already been fixed.
//
// The vendored session package already kept the transcript (transcript-vault)
// and already knew which step comes next (recovery); what was missing was
// somewhere to press the button. This is that. It renders on the same terms as
// the standalone client's card and carries out the chain's decision — it does
// not make one.
const ACTION_LABELS: Record<RecoveryAction, string> = {
  refund: "Refund",
  escalate: "Send to adjudication",
  prove: "File your transcript",
  reveal: "Reveal your cards",
  adjudicate: "Ask for a verdict",
  checkpoint: "File the last settled hand",
};

export const Recovery: React.FC<{
  wallet: PokerWalletBridge;
  chainId: string;
  lcdUrl: string;
  myAddress: string;
  enabled: boolean;
}> = ({ wallet, chainId, lcdUrl, myAddress, enabled }) => {
  const [sessions, setSessions] = useState<RecoverableSession[]>([]);
  const [height, setHeight] = useState(0);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  // Sessions whose adjudication this chain has already refused. A validator
  // built without the cgo engine rejects every one of them, so without this the
  // card would offer "ask for a verdict" forever and never the refund that
  // actually works. A ref, not state: the refresh that runs immediately after a
  // failed attempt has to see it (ADR-008 §2.5).
  const adjudicationRefused = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    if (!myAddress) {
      setSessions([]);
      return;
    }
    try {
      const chainHeight = await fetchChainHeight(lcdUrl);
      setHeight(chainHeight);
      setSessions(
        await fetchRecoverableSessions(
          lcdUrl,
          myAddress,
          chainHeight,
          adjudicationRefused.current
        )
      );
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [lcdUrl, myAddress]);

  useEffect(() => {
    void refresh();
    // Slower than the lobby: these move on a deadline, not on an opponent.
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = useCallback(
    async (
      action: RecoveryAction,
      sessionId: string,
      intentId: string | undefined,
      session: ChainGameSession
    ) => {
      // ADR-010: an interrupted session that already settled hands is not an
      // abandoned one. Filing the last hand both seats signed settles at the
      // real standings; waiting out the timeout instead pays the buy-ins back
      // and erases them.
      if (action === "checkpoint") {
        const checkpoint = await checkpointForSession(sessionId, myAddress);
        if (!checkpoint) {
          throw new Error(
            "this browser no longer holds a settled hand for that session"
          );
        }
        // Derived from the double-signed bytes, not from anything stored
        // beside them: what this files has to be what the opponent's own
        // independent filing produces, or the two collide into a dispute.
        const result = await checkpointResult({
          chainSessionId: sessionId,
          playerA: session.player_a,
          playerB: session.player_b,
          finalStake: session.stake,
          localAddress: myAddress,
          settleHex: checkpoint.settleHex,
        });
        if (result.error) {
          throw new Error(result.error);
        }
        return wallet.submitResult(chainId, {
          sessionId,
          winner: result.winner ?? "",
          loser: result.loser ?? "",
          finalStake: result.finalStake ?? session.stake,
          transcriptHash: result.transcriptHash ?? "",
          resultSignature: result.resultSignature ?? "",
          splitPot: result.splitPot ?? false,
          playerAAmount: result.playerAAmount ?? "0",
          playerBAmount: result.playerBAmount ?? "0",
        });
      }
      if (action === "prove") {
        const kept = await transcriptForSession(sessionId, myAddress);
        if (!kept) {
          throw new Error(
            "this browser no longer holds the transcript for that session"
          );
        }
        return wallet.submitEvidence(chainId, {
          sessionId,
          evidenceHash: kept.evidenceHash,
          payloadHex: kept.payloadHex,
          signature: kept.signature,
          reason: kept.reason,
        });
      }
      if (action === "reveal") {
        const identity = intentId
          ? sessionIdentityForIntent(intentId)
          : undefined;
        if (!identity) {
          throw new Error(
            "this browser no longer holds the secret for that session"
          );
        }
        return wallet.submitSecret(chainId, {
          sessionId,
          secretKeyHex: identity.secretKeyHex,
          pubkeyHex: identity.pubkeyHex,
        });
      }
      if (action === "adjudicate") {
        return wallet.adjudicateSession(chainId, sessionId);
      }
      return wallet.claimSessionTimeout(chainId, sessionId);
    },
    [wallet, chainId, myAddress]
  );

  const claim = useCallback(
    async ({ session, recovery, intentId }: RecoverableSession) => {
      const sessionId = session.session_id;
      setBusyId(sessionId);
      setError("");
      try {
        const result = await run(recovery.action, sessionId, intentId, session);
        if (result.code !== 0) {
          setError(
            result.rawLog || `the chain refused it (code ${result.code})`
          );
          // Only a TERMINAL refusal closes the verdict route. A sequence we
          // raced or a busy mempool says nothing about the message, and
          // treating one as a refusal would offer the refund to a player whose
          // verdict was still perfectly obtainable (ADR-008 §2.6).
          if (
            recovery.action === "adjudicate" &&
            txFailureClass(result.code, result.codespace) === "terminal"
          ) {
            adjudicationRefused.current.add(sessionId);
          }
        } else if (recovery.action === "reveal" && intentId) {
          // On chain now, so the next poll offers the verdict instead. Keeping
          // it would also offer to reveal it again forever.
          forgetSessionIdentity(intentId);
        }
      } catch (e: any) {
        // A thrown error is a transport problem or a tx that never got indexed,
        // not the chain's answer: nothing is learned, so nothing is recorded.
        setError(e?.message ?? String(e));
      } finally {
        setBusyId("");
        await refresh();
      }
    },
    [run, refresh]
  );

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div style={styles.block} data-testid="recovery">
      <b>Unfinished sessions</b>
      <div style={{ opacity: 0.7, marginBottom: "0.4rem" }}>
        These still hold your stake. Block {height}.
      </div>
      {error ? <div style={styles.err}>recovery: {error}</div> : null}
      {sessions.map(({ session, recovery, intentId }) => {
        const ready = recovery.kind === "ready";
        return (
          <div
            key={session.session_id}
            style={{ ...styles.row, margin: "0.4rem 0" }}
          >
            <span style={{ fontWeight: 700, minWidth: "5rem" }}>
              #{session.session_id}
            </span>
            <span>{formatChip(session.stake)}</span>
            <span style={{ opacity: 0.75, flex: "1 1 16rem" }}>
              {recovery.reason}
            </span>
            <button
              disabled={!enabled || !ready || busyId === session.session_id}
              onClick={() => void claim({ session, recovery, intentId })}
            >
              {busyId === session.session_id
                ? "…"
                : ready
                ? ACTION_LABELS[recovery.action]
                : `at block ${recovery.atHeight}`}
            </button>
          </div>
        );
      })}
    </div>
  );
};
