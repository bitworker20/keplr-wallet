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

// The peer's latest betting move, as the gamecore saw it. `seq` is monotonic
// per session so a poller can append to a move log exactly once; `label` is a
// stable English tag (FOLD/CHECK/CALL/BET/RAISE/ALLIN, plus LOOK/COMPARE for
// ZhaJinHua) that the UI localizes and pairs with its own amount formatting.
export interface PeerAction {
  seq: number;
  label: string;
  amount: number;
}

// How a hand ended, captured by the gamecore at settlement (the next hand
// destroys the core that knows it). Mirrors the native HandResult so the web
// and desktop clients tell the player the same story.
export interface HandResult {
  handNumber: number;
  // 0 = split / no change, 1 = local player, 2 = opponent.
  winner: number;
  pot: number;
  myStack: number;
  oppStack: number;
  // Change in this seat's session chips over the hand, signed.
  myDelta: number;
  // Empty unless the hand reached a real compare — a fold leaves nothing to
  // rank, and that absence is how the UI decides whether to show a comparison.
  myHandRank: string;
  oppHandRank: string;
  myBestCards: TableCard[];
  oppBestCards: TableCard[];
  // The opponent's revealed cards; empty when they folded uncalled.
  oppCards: TableCard[];
  // Omaha Hi-Lo's second half. The fields above always describe the HIGH hand;
  // these describe the qualifying 8-or-better low, and are empty for a game
  // with no low half (TH, ZJH) or a seat that made none -- which is also how
  // the UI decides whether to draw a second row.
  myLowRank?: string;
  oppLowRank?: string;
  myLowCards?: TableCard[];
  oppLowCards?: TableCard[];
  // Who took the low half: 0 (or absent) = nobody qualified, or the lows tied;
  // 1 = local player, 2 = opponent. Not derivable from the two tags above --
  // both seats can hold a qualifying low and only one of them wins it.
  lowWinner?: number;
}

// The games this client can actually deal. Lives here rather than in
// controller.ts because the lobby needs it too, and controller.ts imports the
// lobby.
export type PokerGame = "TH" | "ZJH" | "O8";

export interface TableState {
  ready: boolean;
  game?: PokerGame;
  // Community-card games (TH, O8): 0=Preflop 1=Flop 2=Turn 3=River 4=Showdown
  // 5=Complete.
  phase?: number;
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
  // Set once the peer has made a move this session; see PeerAction.
  peerAction?: PeerAction;
  // Set once at least one hand has settled; replaced at each settlement.
  handResult?: HandResult;
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
