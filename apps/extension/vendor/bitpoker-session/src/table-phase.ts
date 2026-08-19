// What the table is actually doing right now, derived once instead of being
// re-guessed by each widget.
//
// The raw table state carries three different notions of "where are we" —
// `stage` (the session), `phase` (the betting street, TH only) and `dealing`
// (the shuffle) — and none of them alone answers the question the UI keeps
// asking: may this player act, and if not, why not. Reading them separately is
// how the client ended up showing a live Preflop action bar over two face-down
// hole cards, and a full set of betting buttons at showdown.
//
// Two facts drive most of the subtlety here:
//
//   - `dealing` is only the SHUFFLE. In Texas Hold'em the hole cards arrive
//     afterwards, through the card-key exchange, so there is a window where
//     the table is "ready", the blinds are posted and the cards are still
//     face down. That window is `dealing` to a player, whatever the flag says.
//   - `settled` marks the end of the SESSION, not of a hand: the gamecore only
//     sets it when the two seats stop continuing (gamecore_embind.cpp
//     onSettleFrame). A hand ending mid-session is visible as `handsPlayed`
//     going up and nothing else.
//
// ZhaJinHua deliberately does not fit the second card rule: a player may bet
// blind, and their own cards stay undealt until they look. Missing cards there
// are a legal, playable state, so the rule is Texas Hold'em only.

import { GameSnapshot } from "./controller";
import { TableCard, TableState } from "./types";

export type TablePhase =
  // No hand on the table (before matching, or after leaving).
  | "idle"
  // Shuffling and proving the shuffle. Nothing is dealt yet.
  | "securing"
  // Shuffled; the seats are exchanging card keys so the cards can be read.
  | "dealing"
  // A live betting round. The only phase in which acting is possible.
  | "betting"
  // Cards are being revealed / compared. No more actions.
  | "showdown"
  // The hand and the session are over.
  | "settled";

export interface TableView {
  phase: TablePhase;
  // Short human label for the phase, for the felt's status chip.
  label: string;
  // Render the action bar at all. False everywhere but a live betting round,
  // so a fold button can never sit under a finished hand.
  canAct: boolean;
  // Enable the action bar. Implies canAct.
  myTurn: boolean;
  // The peer owes the next move. False while the table itself is busy
  // (shuffling, dealing, revealing), where "waiting for the opponent" would
  // misdescribe what is happening.
  waitingForPeer: boolean;
  // Highlight a seat as the current actor. Off outside a betting round: a
  // glowing seat plate at showdown reads as "their turn".
  showActor: boolean;
  // The hand to put on screen: the one being played, or — once the session is
  // over — the last one actually played. `handNumber` from the gamecore is the
  // NEXT hand's number, which is why a two-hand session used to end on
  // "Hand 3".
  handNumber: number;
  handsPlayed: number;
}

const PHASE_LABEL: Record<TablePhase, string> = {
  idle: "No hand",
  securing: "Shuffling securely",
  dealing: "Dealing",
  betting: "Betting",
  showdown: "Showdown",
  settled: "Hand over",
};

// TH street names, indexed by TableState.phase.
const STREET_LABEL = [
  "Preflop",
  "Flop",
  "Turn",
  "River",
  "Showdown",
  "Complete",
];

const TH_HOLE_CARDS = 2;
const TH_SHOWDOWN_PHASE = 4;

function dealt(cards?: TableCard[]): number {
  return cards?.length ?? 0;
}

// True once this seat can read its own hand. Texas Hold'em deals two hole
// cards up front; ZhaJinHua deals nothing until the player looks, so it has
// nothing to wait for.
function cardsReadable(t: TableState): boolean {
  if (t.game === "ZJH") {
    return true;
  }
  return dealt(t.myHoleCards) >= TH_HOLE_CARDS;
}

function inShowdown(t: TableState): boolean {
  if (t.game === "ZJH") {
    return t.showdownComplete === true;
  }
  return (t.phase ?? 0) >= TH_SHOWDOWN_PHASE;
}

export function deriveTablePhase(snapshot: GameSnapshot): TablePhase {
  const t = snapshot.table;
  const { stage } = snapshot;

  if (stage === "done" || stage === "error" || stage === "disputed") {
    return "settled";
  }
  if (!t || !t.ready) {
    // Between matching and the first shuffle frame there is no table yet, but
    // the session is already running and the player is waiting on the deal.
    return stage === "playing" ? "securing" : "idle";
  }
  // The session-level flag: both seats stopped continuing, so this is the end
  // of the last hand rather than a pause between two.
  if (t.settled) {
    return "settled";
  }
  if (inShowdown(t)) {
    return "showdown";
  }
  if (t.dealing) {
    return "securing";
  }
  if (!cardsReadable(t)) {
    return "dealing";
  }
  return "betting";
}

export function deriveTableView(snapshot: GameSnapshot): TableView {
  const t = snapshot.table;
  const phase = deriveTablePhase(snapshot);
  const canAct = phase === "betting";
  const myTurn = canAct && snapshot.wait === 0;

  const handsPlayed = t?.handsPlayed ?? 0;
  // handNumber counts the hand about to be played; once nothing more will be
  // played it overstates the session by one.
  const handNumber =
    phase === "settled" && handsPlayed > 0 ? handsPlayed : t?.handNumber ?? 1;

  // On a betting street the street name is more informative than the generic
  // phase; everywhere else the phase is the whole story.
  const label =
    phase === "betting" && t?.game !== "ZJH"
      ? STREET_LABEL[t?.phase ?? 0] ?? PHASE_LABEL[phase]
      : PHASE_LABEL[phase];

  return {
    phase,
    label,
    canAct,
    myTurn,
    waitingForPeer: canAct && !myTurn,
    showActor: canAct,
    handNumber,
    handsPlayed,
  };
}
