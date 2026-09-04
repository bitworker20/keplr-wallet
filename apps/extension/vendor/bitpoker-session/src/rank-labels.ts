// Human labels for the gamecore's hand-rank tags.
//
// to_string(HandRank) and to_string(ZhaJinHuaHandType) deliberately emit stable
// English SCREAMING_SNAKE tags and leave the wording to the consumer, so that
// the tag can be logged, compared and stored without a UI decision baked into
// it. This is the consumer side of that contract, shared by both front ends so
// they do not drift into calling the same hand two different things.
//
// Unknown tags come back title-cased rather than dropped: a rank the gamecore
// gains before this table does should still read as something.

import { PokerGame } from "./types";

const TEXAS_HOLDEM: Record<string, string> = {
  HIGH_CARD: "High card",
  ONE_PAIR: "One pair",
  TWO_PAIR: "Two pair",
  THREE_OF_KIND: "Three of a kind",
  STRAIGHT: "Straight",
  FLUSH: "Flush",
  FULL_HOUSE: "Full house",
  FOUR_OF_KIND: "Four of a kind",
  STRAIGHT_FLUSH: "Straight flush",
  ROYAL_FLUSH: "Royal flush",
};

// ZhaJinHua shares several tags with Hold'em but orders them differently (a
// three of a kind beats a straight flush) and adds the 2-3-5 special.
const ZHAJINHUA: Record<string, string> = {
  HIGH_CARD: "High card",
  PAIR: "Pair",
  STRAIGHT: "Straight",
  FLUSH: "Flush",
  STRAIGHT_FLUSH: "Straight flush",
  THREE_OF_KIND: "Three of a kind",
  SPECIAL_235: "2-3-5",
};

function titleCase(tag: string): string {
  const words = tag.toLowerCase().split("_").filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  return (
    words[0].charAt(0).toUpperCase() +
    words[0].slice(1) +
    (words.length > 1 ? " " + words.slice(1).join(" ") : "")
  );
}

export function handRankLabel(tag: string, game?: PokerGame): string {
  if (tag === "") {
    return "";
  }
  // Omaha ranks its high half with the same categories as Hold'em (its low
  // half is not a HandRank at all -- see lowHandLabel).
  const table = game === "ZJH" ? ZHAJINHUA : TEXAS_HOLDEM;
  return table[tag] ?? titleCase(tag);
}

// Omaha Hi-Lo's low half. The engine emits "LOW_8_6_4_3_A": the five low card
// ranks, highest first, ace as A. Rendered as "8-6-4-3-A low", the way the
// hand is actually named at a table. An empty tag means no qualifying low,
// and comes back as the empty string so a caller can test it directly.
export function lowHandLabel(tag: string): string {
  if (tag === "") {
    return "";
  }
  const parts = tag.split("_");
  if (parts[0] !== "LOW" || parts.length < 2) {
    return titleCase(tag);
  }
  return parts.slice(1).join("-") + " low";
}

// Move-log verbs for the action tags the gamecore reports. Amounts are the
// caller's to format and append — only it knows the display denom.
//
// Two persons, because the log names the local player as "You": third-person
// verbs against a second-person subject give you "You calls", which is the
// kind of thing that makes a whole screen feel unfinished.
const ACTION_THIRD: Record<string, string> = {
  FOLD: "folds",
  CHECK: "checks",
  CALL: "calls",
  BET: "bets",
  RAISE: "raises to",
  ALLIN: "is all in",
  LOOK: "looks at their cards",
  COMPARE: "calls for a compare",
};

const ACTION_SECOND: Record<string, string> = {
  FOLD: "fold",
  CHECK: "check",
  CALL: "call",
  BET: "bet",
  RAISE: "raise to",
  ALLIN: "are all in",
  LOOK: "look at your cards",
  COMPARE: "call for a compare",
};

// Every tag the gamecore can report as a move. Exported so a spec can hold the
// two verb tables to it — a tag missing from one of them silently falls back
// to the lowercased tag, which happens to read fine for "fold" and wrong for
// "raise".
export const ACTION_TAGS = [
  "FOLD",
  "CHECK",
  "CALL",
  "BET",
  "RAISE",
  "ALLIN",
  "LOOK",
  "COMPARE",
] as const;

export function actionLabel(tag: string, secondPerson = false): string {
  const table = secondPerson ? ACTION_SECOND : ACTION_THIRD;
  return table[tag] ?? tag.toLowerCase();
}

// Test seam for the parity check above; not meant for rendering.
export function hasActionLabels(tag: string): boolean {
  return tag in ACTION_THIRD && tag in ACTION_SECOND;
}

// Whether the verb reads naturally with an amount after it. "folds 0" and
// "is all in 0" are the kind of thing that makes a log look machine-generated.
export function actionTakesAmount(tag: string): boolean {
  return tag === "BET" || tag === "RAISE" || tag === "CALL";
}
