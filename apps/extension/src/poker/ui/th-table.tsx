import React, { useEffect, useState } from "react";
import { GameSnapshot } from "../controller";
import {
  PHASE_NAMES,
  PokerActionKind,
  TablePlayer,
  TableState,
} from "../types";
import { BetView, betActionCost, computeBetBounds } from "../bet-bounds";
import { Cards, CardBacks } from "./cards";
import { styles } from "./styles";
import {
  ResultBanner,
  SessionStrip,
  felt,
  feltMuted,
  seatPlate,
  turnMark,
} from "./table-chrome";

// Texas Hold'em table on a felt surface: board + hole cards, seat plates,
// bounds-validated bet sizing (slider + amount clamped to the engine rules),
// the auto-hiding hand banner and the persistent session strip.
export const ThTable: React.FC<{
  t: TableState;
  me: number;
  peer: number;
  myTurn: boolean;
  snapshot: GameSnapshot;
  continueWish: boolean;
  act: (kind: number, amount?: number) => void;
  setContinueWish: (wish: boolean) => void;
  // Formats in-game chip amounts (chain sessions: uchip -> CHIP; dev play:
  // plain numbers).
  fmt: (amount: number) => string;
}> = ({
  t,
  me,
  peer,
  myTurn,
  snapshot,
  continueWish,
  act,
  setContinueWish,
  fmt,
}) => {
  const { stage, matched } = snapshot;
  const toCall = t.toCall ?? 0;
  const players = t.players as TablePlayer[] | undefined;
  const my = players?.[me];
  const opp = players?.[peer];

  const betView: BetView = {
    game: "TH",
    pot: t.pot ?? 0,
    toCall,
    currentBet: t.currentBet ?? 0,
    lastRaiseSize: t.lastRaiseSize ?? 0,
    bigBlind: t.bigBlind ?? 0,
    myCommitted: my?.committedRound ?? 0,
    myStack: my?.stack ?? 0,
    oppCommitted: opp?.committedRound ?? 0,
    oppStack: opp?.stack ?? 0,
    currentDarkBet: 0,
    hasLooked: false,
  };
  const bounds = computeBetBounds(betView);
  const isRaise = (t.currentBet ?? 0) > 0;

  // Bet amount as a number clamped into the legal bounds; re-anchor to the
  // minimum whenever the bounds move (a new decision arrived).
  const [amount, setAmount] = useState(0);
  useEffect(() => {
    if (myTurn && bounds.hasBet) {
      setAmount((cur) =>
        cur >= bounds.minTarget && cur <= bounds.maxTarget
          ? cur
          : bounds.minTarget
      );
    }
  }, [myTurn, bounds.hasBet, bounds.minTarget, bounds.maxTarget]);
  const clamped = Math.min(
    Math.max(amount, bounds.minTarget),
    bounds.maxTarget
  );
  const cost = betActionCost(betView, clamped);
  const atAllIn = bounds.maxIsTrueAllIn && clamped >= bounds.maxTarget;

  // Session standings (matchmaking order -> me/opponent via matched.meFirst).
  const mySession = matched?.meFirst
    ? t.sessionFirstChips
    : t.sessionSecondChips;
  const oppSession = matched?.meFirst
    ? t.sessionSecondChips
    : t.sessionFirstChips;
  const standings =
    mySession !== undefined && oppSession !== undefined
      ? `you ${fmt(mySession)} / opponent ${fmt(oppSession)}`
      : undefined;
  const total = (mySession ?? 0) + (oppSession ?? 0);
  const outcome =
    mySession !== undefined && oppSession !== undefined
      ? mySession * 2 > total
        ? "you are ahead"
        : mySession * 2 < total
        ? "opponent is ahead"
        : "even"
      : "";

  const submitBet = () => {
    if (atAllIn) {
      act(PokerActionKind.AllIn);
    } else if (isRaise) {
      act(PokerActionKind.Raise, clamped);
    } else {
      act(PokerActionKind.Bet, clamped);
    }
  };

  return (
    <div style={felt}>
      <b>
        Hand {t.handNumber ?? 1} — {PHASE_NAMES[t.phase ?? 0]} · pot{" "}
        {fmt(t.pot ?? 0)}
        {t.currentBet ? ` · bet ${fmt(t.currentBet)}` : ""}
        {t.dealing ? " · dealing…" : ""}
        {t.button === me ? " · you have the button" : ""}
      </b>

      <div style={seatPlate}>
        <span style={feltMuted}>opponent</span> · stack {fmt(opp?.stack ?? 0)}
        {opp?.committedRound ? ` · in ${fmt(opp.committedRound)}` : ""}
        {opp?.folded ? " · folded" : ""}
        {opp?.allIn ? " · ALL-IN" : ""}
        <div style={{ marginTop: "0.25rem" }}>
          {t.peerHoleCards && t.peerHoleCards.length > 0 ? (
            <Cards cards={t.peerHoleCards} empty="" />
          ) : (
            <CardBacks count={2} />
          )}
        </div>
      </div>

      <div style={{ margin: "0.5rem 0" }}>
        <span style={feltMuted}>board </span>
        <Cards cards={t.communityCards} empty="(no cards yet)" />
      </div>

      <div style={seatPlate}>
        <span style={feltMuted}>me</span> (
        {matched?.meFirst ? "first" : "second"}) · stack {fmt(my?.stack ?? 0)}
        {my?.committedRound ? ` · in ${fmt(my.committedRound)}` : ""}
        {my?.folded ? " · folded" : ""}
        {my?.allIn ? " · ALL-IN" : ""}
        {myTurn ? <span style={turnMark}> ← your turn</span> : null}
        <div style={{ marginTop: "0.25rem" }}>
          <Cards cards={t.myHoleCards} empty="(dealing…)" />
        </div>
      </div>

      <ResultBanner
        t={t}
        text={`hand ${t.handsPlayed ?? 0} settled${
          standings ? ` — ${standings} (${outcome})` : ""
        }`}
      />

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
            Call {toCall > 0 ? fmt(toCall) : ""}
          </button>
        </div>
      ) : null}

      {stage === "playing" && bounds.hasBet ? (
        <div style={{ ...styles.row, marginTop: "0.4rem" }}>
          <input
            type="range"
            min={bounds.minTarget}
            max={bounds.maxTarget}
            value={clamped}
            onChange={(e) => setAmount(parseInt(e.target.value, 10))}
            disabled={!myTurn}
            style={{ width: "12rem" }}
          />
          <input
            style={{ ...styles.input, width: "6rem" }}
            value={String(clamped)}
            onChange={(e) => setAmount(parseInt(e.target.value, 10) || 0)}
            disabled={!myTurn}
          />
          <button disabled={!myTurn} onClick={submitBet}>
            {atAllIn
              ? `All-in · pays ${fmt(cost)}`
              : isRaise
              ? `Raise to ${fmt(clamped)} · pays ${fmt(cost)}`
              : `Bet ${fmt(clamped)}`}
          </button>
          <span style={feltMuted}>
            {fmt(bounds.minTarget)} – {fmt(bounds.maxTarget)}
            {bounds.maxIsTrueAllIn ? " (all-in)" : ""}
          </span>
        </div>
      ) : null}

      {stage === "playing" ? (
        <div style={{ marginTop: "0.4rem" }}>
          <label>
            <input
              type="checkbox"
              checked={!continueWish}
              onChange={(e) => setContinueWish(!e.target.checked)}
            />{" "}
            Leave after this hand
            {!continueWish ? " (session ends at this hand's settlement)" : ""}
          </label>
        </div>
      ) : null}

      <SessionStrip snapshot={snapshot} standings={standings} />

      {stage === "done" && standings ? (
        <div style={{ ...turnMark, marginTop: "0.5rem" }} data-testid="result">
          settled: {standings} —{" "}
          {outcome === "you are ahead"
            ? "you win"
            : outcome === "opponent is ahead"
            ? "opponent wins"
            : "split pot"}
        </div>
      ) : null}
    </div>
  );
};
