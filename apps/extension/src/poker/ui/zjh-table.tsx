import React, { useEffect, useState } from "react";
import { GameSnapshot } from "../controller";
import { TableState, ZjhActionKind, ZjhPlayer } from "../types";
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

// ZhaJinHua (three-card brag) table on the shared felt chrome: 3 private
// cards, ante/pot/dark-bet, bounds-validated raise levels, and the
// look/call/raise/compare/fold action bar.
export const ZjhTable: React.FC<{
  t: TableState;
  me: number;
  peer: number;
  myTurn: boolean;
  snapshot: GameSnapshot;
  continueWish: boolean;
  act: (kind: number, amount?: number) => void;
  setContinueWish: (wish: boolean) => void;
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
  const players = (t.players as ZjhPlayer[] | undefined) ?? [];
  const my = players[me];
  const opp = players[peer];
  const looked = my?.looked ?? false;
  const darkBet = t.currentDarkBet ?? 0;
  const myCallCost = darkBet * (looked ? 2 : 1);

  // Session standings (matchmaking order) double as the ZJH stack source:
  // the ZJH table state has no per-seat stack, but stack = session chips
  // carried into this hand minus what this hand has committed.
  const mySession = matched?.meFirst
    ? t.sessionFirstChips
    : t.sessionSecondChips;
  const oppSession = matched?.meFirst
    ? t.sessionSecondChips
    : t.sessionFirstChips;
  const myStack = Math.max(0, (mySession ?? 0) - (my?.committed ?? 0));
  const oppStack = Math.max(0, (oppSession ?? 0) - (opp?.committed ?? 0));

  const betView: BetView = {
    game: "ZJH",
    pot: t.pot ?? 0,
    toCall: 0,
    currentBet: 0,
    lastRaiseSize: 0,
    bigBlind: 0,
    myCommitted: my?.committed ?? 0,
    myStack,
    oppCommitted: opp?.committed ?? 0,
    oppStack,
    currentDarkBet: darkBet,
    hasLooked: looked,
  };
  const bounds = computeBetBounds(betView);

  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (myTurn && bounds.hasBet) {
      setLevel((cur) =>
        cur >= bounds.minTarget && cur <= bounds.maxTarget
          ? cur
          : bounds.minTarget
      );
    }
  }, [myTurn, bounds.hasBet, bounds.minTarget, bounds.maxTarget]);
  const clamped = Math.min(Math.max(level, bounds.minTarget), bounds.maxTarget);
  const cost = betActionCost(betView, clamped);

  const standings =
    mySession !== undefined && oppSession !== undefined
      ? `you ${fmt(mySession)} / opponent ${fmt(oppSession)}`
      : undefined;

  return (
    <div style={felt}>
      <b>
        ZhaJinHua · Hand {t.handNumber ?? 1} · ante {fmt(t.ante ?? 0)} · pot{" "}
        {fmt(t.pot ?? 0)}
        {t.dealing ? " · dealing…" : ` · dark bet ${fmt(darkBet)}`}
        {t.button === me ? " · you deal" : ""}
      </b>

      <div style={seatPlate}>
        <span style={feltMuted}>opponent</span> ·{" "}
        {opp?.looked ? "looked" : "blind"}
        {opp?.folded ? " · folded" : ""} · in pot {fmt(opp?.committed ?? 0)} ·
        stack {fmt(oppStack)}
        <div style={{ marginTop: "0.25rem" }}>
          {t.peerCards && t.peerCards.length > 0 ? (
            <Cards cards={t.peerCards} empty="" />
          ) : (
            <CardBacks count={3} />
          )}
        </div>
      </div>

      <div style={seatPlate}>
        <span style={feltMuted}>me</span> (
        {matched?.meFirst ? "first" : "second"}
        {looked ? ", looked" : ", blind"}
        {my?.folded ? ", folded" : ""}) · in pot {fmt(my?.committed ?? 0)} ·
        stack {fmt(myStack)}
        {myTurn ? <span style={turnMark}> ← your turn</span> : null}
        <div style={{ marginTop: "0.25rem" }}>
          {t.myCards && t.myCards.length > 0 ? (
            <Cards cards={t.myCards} empty="" />
          ) : looked ? (
            <span style={feltMuted}>(revealing…)</span>
          ) : (
            <CardBacks count={3} />
          )}
        </div>
      </div>

      <ResultBanner
        t={t}
        text={`hand ${t.handsPlayed ?? 0} settled${
          standings ? ` — ${standings}` : ""
        }`}
      />

      {stage === "playing" ? (
        <React.Fragment>
          <div style={{ ...styles.row, marginTop: "0.5rem" }}>
            <button disabled={!myTurn} onClick={() => act(ZjhActionKind.Fold)}>
              Fold
            </button>
            <button
              disabled={!myTurn || looked}
              onClick={() => act(ZjhActionKind.Look)}
            >
              Look
            </button>
            <button disabled={!myTurn} onClick={() => act(ZjhActionKind.Call)}>
              Call {myCallCost > 0 ? fmt(myCallCost) : ""}
            </button>
            <button
              disabled={!myTurn}
              onClick={() => act(ZjhActionKind.Compare)}
            >
              Compare (showdown)
            </button>
          </div>
          {bounds.hasBet ? (
            <div style={{ ...styles.row, marginTop: "0.4rem" }}>
              <input
                type="range"
                min={bounds.minTarget}
                max={bounds.maxTarget}
                value={clamped}
                onChange={(e) => setLevel(parseInt(e.target.value, 10))}
                disabled={!myTurn}
                style={{ width: "12rem" }}
              />
              <input
                style={{ ...styles.input, width: "5rem" }}
                value={String(clamped)}
                onChange={(e) => setLevel(parseInt(e.target.value, 10) || 0)}
                disabled={!myTurn}
              />
              <button
                disabled={!myTurn}
                onClick={() => act(ZjhActionKind.Raise, clamped)}
              >
                Raise to {fmt(clamped)} · pays {fmt(cost)}
                {looked ? " (looked ×2)" : ""}
              </button>
              <span style={feltMuted}>
                {fmt(bounds.minTarget)} – {fmt(bounds.maxTarget)} (top = all-in)
              </span>
            </div>
          ) : null}
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
        </React.Fragment>
      ) : null}

      <SessionStrip snapshot={snapshot} standings={standings} />

      {(stage === "done" || stage === "disputed") && t.showdownComplete ? (
        <div style={{ ...turnMark, marginTop: "0.5rem" }} data-testid="result">
          showdown complete — {matched?.meFirst ? "first" : "second"} seat
          {standings ? ` · ${standings}` : ""}
        </div>
      ) : null}
    </div>
  );
};
