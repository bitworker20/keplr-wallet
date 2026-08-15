// Betting-bounds math for the bet/raise sizing UI — a line-for-line TS port of
// bitpoker/include/common/bet_bounds.hpp (keep the two in sync; the C++ side
// is unit-tested against the engine rules in test/common/bet_bounds_test.cpp,
// and the same cases are ported to bet-bounds.spec.ts here).
//
// Conventions (mirroring the engines):
//   - TH with currentBet == 0: amount is CHIPS TO ADD this action (a Bet).
//   - TH with currentBet  > 0: amount is the RAISE-TO street total (RaiseTo).
//   - ZJH: amount is the DARK-BET LEVEL; the chips actually paid are
//     level x multiplier (x2 once the actor has looked), capped by the stack.

export interface BetView {
  game: "TH" | "ZJH";
  pot: number;
  toCall: number;
  currentBet: number;
  lastRaiseSize: number;
  bigBlind: number;
  myCommitted: number;
  myStack: number;
  oppCommitted: number;
  oppStack: number;
  // ZJH
  currentDarkBet: number;
  hasLooked: boolean;
}

export interface BetBounds {
  hasBet: boolean;
  minTarget: number;
  maxTarget: number;
  // True when maxTarget commits our whole remaining stack ("All-in");
  // false when it merely covers the opponent's shorter stack ("Max").
  maxIsTrueAllIn: boolean;
  halfPotTarget: number;
  potTarget: number;
  zjhCostMultiplier: number;
}

const clampInto = (x: number, min: number, max: number): number =>
  Math.min(Math.max(x, min), max);

// Chips this action actually moves for a chosen amount ("raise to 220 · pays
// 180"): TH raise-to pays target - myCommitted; a TH bet pays the amount
// itself; ZJH pays level x multiplier capped by the stack.
export function betActionCost(v: BetView, amount: number): number {
  if (v.game === "ZJH") {
    const mult = v.hasLooked ? 2 : 1;
    return Math.min(amount * mult, v.myStack);
  }
  if (v.currentBet > 0) {
    return amount > v.myCommitted ? amount - v.myCommitted : 0;
  }
  return Math.min(amount, v.myStack);
}

export function computeBetBounds(v: BetView): BetBounds {
  const b: BetBounds = {
    hasBet: false,
    minTarget: 0,
    maxTarget: 0,
    maxIsTrueAllIn: false,
    halfPotTarget: 0,
    potTarget: 0,
    zjhCostMultiplier: 1,
  };

  if (v.game === "ZJH") {
    b.zjhCostMultiplier = v.hasLooked ? 2 : 1;
    if (v.myStack === 0) {
      return b; // fully committed: no bet entry
    }
    b.hasBet = true;
    b.minTarget = Math.max(1, v.currentDarkBet);
    // Top level = the smallest dark level whose actual cost consumes the
    // whole remaining stack (the engine caps the payment there).
    b.maxTarget = Math.max(
      b.minTarget,
      Math.ceil(v.myStack / b.zjhCostMultiplier)
    );
    b.maxIsTrueAllIn = true;
    return b;
  }

  const myTotal = v.myCommitted + v.myStack;
  const oppTotal = v.oppCommitted + v.oppStack;

  if (v.currentBet > 0) {
    // RaiseTo. Legal only if we can exceed currentBet and the opponent still
    // has chips to call into.
    const cap = Math.min(myTotal, oppTotal);
    if (v.myStack === 0 || v.oppStack === 0 || cap <= v.currentBet) {
      return b;
    }
    b.hasBet = true;
    b.maxTarget = cap;
    // Min-raise floor; a shorter stack may only have all-in-for-less, which
    // the engine accepts at exactly the capped target.
    b.minTarget = Math.min(
      v.currentBet + Math.max(v.lastRaiseSize, v.bigBlind),
      b.maxTarget
    );
    b.maxIsTrueAllIn = b.maxTarget >= myTotal;
    const potAfterCall = v.pot + v.toCall;
    b.halfPotTarget = clampInto(
      v.currentBet + Math.floor(potAfterCall / 2),
      b.minTarget,
      b.maxTarget
    );
    b.potTarget = clampInto(
      v.currentBet + potAfterCall,
      b.minTarget,
      b.maxTarget
    );
    return b;
  }

  // Open bet: chips to add. Anything above what the opponent can still call
  // is dead sizing, so cap by their remaining stack too.
  if (v.myStack === 0 || v.oppStack === 0) {
    return b;
  }
  b.hasBet = true;
  b.maxTarget = Math.min(v.myStack, v.oppStack);
  // Bets under the big blind are rejected unless they are all-in-for-less.
  b.minTarget = Math.min(v.bigBlind > 0 ? v.bigBlind : 1, b.maxTarget);
  b.maxIsTrueAllIn = b.maxTarget >= v.myStack;
  b.halfPotTarget = clampInto(Math.floor(v.pot / 2), b.minTarget, b.maxTarget);
  b.potTarget = clampInto(v.pot, b.minTarget, b.maxTarget);
  return b;
}
