import React from "react";
import { GameSnapshot } from "../controller";
import {
  PHASE_NAMES,
  PokerActionKind,
  TablePlayer,
  TableState,
} from "../types";
import { Cards } from "./cards";
import { styles } from "./styles";

// Texas Hold'em table: board + hole cards, stacks, and the
// fold/check/call/bet/raise/all-in action bar.
export const ThTable: React.FC<{
  t: TableState;
  me: number;
  peer: number;
  myTurn: boolean;
  matched?: GameSnapshot["matched"];
  stage: GameSnapshot["stage"];
  continueWish: boolean;
  betAmount: string;
  setBetAmount: (v: string) => void;
  act: (kind: number) => void;
  setContinueWish: (wish: boolean) => void;
}> = ({
  t,
  me,
  peer,
  myTurn,
  matched,
  stage,
  continueWish,
  betAmount,
  setBetAmount,
  act,
  setContinueWish,
}) => {
  const toCall = t.toCall ?? 0;
  const thPlayers = t.players as TablePlayer[] | undefined;
  const settle = t.settlement;
  const mySettle = settle
    ? me === 0
      ? settle.firstAmount
      : settle.secondAmount
    : undefined;
  const totalSettle = settle ? settle.firstAmount + settle.secondAmount : 0;

  return (
    <div style={styles.block}>
      <b>
        Hand {t.handNumber ?? 1} — {PHASE_NAMES[t.phase ?? 0]} · pot {t.pot}
        {t.currentBet ? ` · bet ${t.currentBet}` : ""}
        {t.dealing ? " · dealing…" : ""}
        {t.button === me ? " · you have the button" : ""}
      </b>
      <div>
        board: <Cards cards={t.communityCards} empty="(no cards yet)" />
      </div>
      <div>
        me ({matched?.meFirst ? "first" : "second"}, stack{" "}
        {thPlayers?.[me]?.stack}
        {thPlayers?.[me]?.folded ? ", folded" : ""}):{" "}
        <Cards cards={t.myHoleCards} empty="(dealing…)" />
        {myTurn ? <span style={styles.turn}> ← your turn</span> : null}
      </div>
      <div>
        opponent (stack {thPlayers?.[peer]?.stack}
        {thPlayers?.[peer]?.folded ? ", folded" : ""}):{" "}
        <Cards cards={t.peerHoleCards} empty="🂠 🂠" />
      </div>

      {stage === "playing" ? (
        <div style={{ marginTop: "0.4rem" }}>
          <label>
            <input
              type="checkbox"
              checked={continueWish}
              onChange={(e) => setContinueWish(e.target.checked)}
            />{" "}
            Play another hand after this one
            {!continueWish ? " (leaving after this hand)" : ""}
          </label>
        </div>
      ) : null}

      {stage === "playing" ? (
        <div style={{ ...styles.row, marginTop: "0.5rem" }}>
          <button disabled={!myTurn} onClick={() => act(PokerActionKind.Fold)}>
            Fold
          </button>
          <button
            disabled={!myTurn || toCall > 0}
            onClick={() => act(PokerActionKind.Check)}
          >
            Check
          </button>
          <button
            disabled={!myTurn || toCall === 0}
            onClick={() => act(PokerActionKind.Call)}
          >
            Call {toCall > 0 ? toCall : ""}
          </button>
          <input
            style={{ ...styles.input, width: "5rem" }}
            value={betAmount}
            onChange={(e) => setBetAmount(e.target.value)}
            disabled={!myTurn}
          />
          <button
            disabled={!myTurn || toCall > 0}
            onClick={() => act(PokerActionKind.Bet)}
          >
            Bet
          </button>
          <button
            disabled={!myTurn || toCall === 0}
            onClick={() => act(PokerActionKind.Raise)}
          >
            Raise to
          </button>
          <button disabled={!myTurn} onClick={() => act(PokerActionKind.AllIn)}>
            All-in
          </button>
        </div>
      ) : null}

      {stage === "done" && settle ? (
        <div style={{ ...styles.ok, marginTop: "0.5rem" }} data-testid="result">
          settled: you {mySettle} / opponent {totalSettle - (mySettle ?? 0)} —{" "}
          {(mySettle ?? 0) === totalSettle
            ? "you win"
            : (mySettle ?? 0) === 0
            ? "opponent wins"
            : "split pot"}
        </div>
      ) : null}
    </div>
  );
};
