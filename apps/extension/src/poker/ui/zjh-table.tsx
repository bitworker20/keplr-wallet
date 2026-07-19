import React from "react";
import { GameSnapshot } from "../controller";
import { TableState, ZjhActionKind, ZjhPlayer } from "../types";
import { Cards } from "./cards";

const zjhStyles = {
  block: {
    border: "1px solid #888",
    borderRadius: "0.5rem",
    padding: "0.75rem 1rem",
    margin: "1rem 0",
    overflowWrap: "anywhere" as const,
  },
  row: {
    display: "flex",
    gap: "0.5rem",
    flexWrap: "wrap" as const,
    alignItems: "center" as const,
    marginTop: "0.5rem",
  },
  turn: { color: "#0a0", fontWeight: 700 },
  ok: { color: "#0a0" },
};

// ZhaJinHua (three-card brag) table: 3 private cards, ante/pot/dark-bet, and
// the look/bet/call/raise/compare/fold action bar.
export const ZjhTable: React.FC<{
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
  const players = (t.players as ZjhPlayer[] | undefined) ?? [];
  const looked = players[me]?.looked ?? false;
  const darkBet = t.currentDarkBet ?? 0;
  const myBetCost = darkBet * (looked ? 2 : 1);
  return (
    <div style={zjhStyles.block}>
      <b>
        ZhaJinHua · Hand {t.handNumber ?? 1} · ante {t.ante} · pot {t.pot}
        {t.dealing ? " · dealing…" : ` · dark bet ${darkBet}`}
        {t.button === me ? " · you deal" : ""}
      </b>
      <div>
        me ({matched?.meFirst ? "first" : "second"}
        {looked ? ", looked" : ", blind"}
        {players[me]?.folded ? ", folded" : ""}, in pot {players[me]?.committed}
        ):{" "}
        <Cards
          cards={t.myCards}
          empty={looked ? "(revealing…)" : "🂠 🂠 🂠 (blind)"}
        />
        {myTurn ? <span style={zjhStyles.turn}> ← your turn</span> : null}
      </div>
      <div>
        opponent ({players[peer]?.looked ? "looked" : "blind"}
        {players[peer]?.folded ? ", folded" : ""}, in pot{" "}
        {players[peer]?.committed}): <Cards cards={t.peerCards} empty="🂠 🂠 🂠" />
      </div>

      {stage === "playing" ? (
        <React.Fragment>
          <div style={zjhStyles.row}>
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
              Call {myBetCost > 0 ? myBetCost : ""}
            </button>
            <input
              style={{ fontFamily: "monospace", width: "5rem" }}
              value={betAmount}
              onChange={(e) => setBetAmount(e.target.value)}
              disabled={!myTurn}
            />
            <button disabled={!myTurn} onClick={() => act(ZjhActionKind.Raise)}>
              Raise
            </button>
            <button
              disabled={!myTurn}
              onClick={() => act(ZjhActionKind.Compare)}
            >
              Compare (showdown)
            </button>
          </div>
          <div style={{ marginTop: "0.4rem" }}>
            <label>
              <input
                type="checkbox"
                checked={continueWish}
                onChange={(e) => setContinueWish(e.target.checked)}
              />{" "}
              Play another hand after this one
            </label>
          </div>
        </React.Fragment>
      ) : null}

      {(stage === "done" || stage === "disputed") && t.showdownComplete ? (
        <div
          style={{ ...zjhStyles.ok, marginTop: "0.5rem" }}
          data-testid="result"
        >
          showdown complete — {matched?.meFirst ? "first" : "second"} seat
        </div>
      ) : null}
    </div>
  );
};
