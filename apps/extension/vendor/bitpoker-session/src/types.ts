// Shared types for the poker page <-> worker <-> relay plumbing.

export interface HandEffect {
  frames: Uint8Array[];
  // 0=LocalAction (our turn), 1=PeerMessage, 2=Done
  wait: number;
}

export interface MatchedResult {
  error?: string;
  sessionId?: Uint8Array;
  meFirst?: boolean;
  firstName?: string;
  secondName?: string;
  betAmount?: number;
}

export interface TableCard {
  index: number;
  name: string; // e.g. "AS", "2D"
}

export interface TablePlayer {
  stack: number;
  committedRound: number;
  committedHand: number;
  folded: boolean;
  allIn: boolean;
}

export interface ZjhPlayer {
  committed: number;
  looked: boolean;
  folded: boolean;
}

export interface TableState {
  ready: boolean;
  game?: "TH" | "ZJH";
  phase?: number; // TH: 0=Preflop 1=Flop 2=Turn 3=River 4=Showdown 5=Complete
  pot?: number;
  currentBet?: number;
  smallBlind?: number;
  bigBlind?: number;
  lastRaiseSize?: number;
  localSeat?: number;
  button?: number;
  currentActor?: number;
  players?: TablePlayer[] | ZjhPlayer[];
  myHoleCards?: TableCard[];
  peerHoleCards?: TableCard[];
  communityCards?: TableCard[];
  settlement?: { firstAmount: number; secondAmount: number };
  settled?: boolean;
  wait?: number;
  toCall?: number;
  // Multi-hand
  handNumber?: number;
  handsPlayed?: number;
  continueWish?: boolean;
  dealing?: boolean;
  // Session standings carried across hands, in MATCHMAKING seat order
  // (updated at each hand's settlement). Cumulative session results — and,
  // for ZJH, the stack figure (session chips - committed) bet bounds need.
  sessionFirstChips?: number;
  sessionSecondChips?: number;
  // ZJH-specific
  ante?: number;
  currentDarkBet?: number;
  myCards?: TableCard[];
  peerCards?: TableCard[];
  showdownComplete?: boolean;
}

// ZJH action kinds for onLocalAction (matches zjhActionFromKind in the wasm).
export enum ZjhActionKind {
  Fold = 0,
  Check = 1,
  Call = 2,
  Bet = 3,
  Raise = 4,
  Look = 5,
  Compare = 6,
}

// kind values for onLocalAction (matches the wasm boundary)
export enum PokerActionKind {
  Fold = 0,
  Check = 1,
  Call = 2,
  Bet = 3,
  Raise = 4,
  AllIn = 5,
}

export const PHASE_NAMES = [
  "Preflop",
  "Flop",
  "Turn",
  "River",
  "Showdown",
  "Complete",
];
