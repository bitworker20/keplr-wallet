import React, { useEffect, useState } from "react";
import { GameSnapshot } from "@bitpoker/poker-session/controller";
import {
  PHASE_NAMES,
  PokerActionKind,
  TablePlayer,
  TableState,
} from "@bitpoker/poker-session/types";
import {
  BetView,
  betActionCost,
  computeBetBounds,
} from "@bitpoker/poker-session/bet-bounds";
import { lowHandLabel } from "@bitpoker/poker-session/rank-labels";
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

// The community-card table on a felt surface, shared by Texas Hold'em and
// Omaha Hi-Lo: board + hole cards, seat plates, bounds-validated bet sizing
// (slider + amount clamped to the engine rules), the auto-hiding hand banner
// and the persistent session strip.
//
// The two games differ here only in how many hole cards arrive -- rendered
// from the array rather than a constant -- and in the low half of the
// showdown, which the hand banner draws.
export const CommunityTable: React.FC<{
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
    // The real game, not a constant: bet-bounds treats the community-card
    // games identically today, and pinning "TH" here would hide it the day
    // that stops being true.
    game: t.game ?? "TH",
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
  // Omaha splits the pot, and a player who took only half needs to be told
  // why. The banner is one line here, so the low half is a suffix rather than
  // its own block; a seat with no qualifying low is still named, because
  // "nobody had one" and "the other player had one" are different answers.
  // The suffix appears for every hi-lo hand, including the one where neither
  // seat qualified: "the pot was not split because nobody made a low" is not
  // the same message as saying nothing at all, which reads as "this game does
  // not split pots".
  const result = t.handResult;
  const lowHalfNote =
    result && t.game === "O8"
      ? result.myLowRank || result.oppLowRank
        ? ` · low half: you ${lowHandLabel(result.myLowRank ?? "") || "none"}` +
          `, opponent ${lowHandLabel(result.oppLowRank ?? "") || "none"}`
        : " · low half: nobody qualified, so the high hand takes the whole pot"
      : "";
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
        }${lowHalfNote}`}
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
