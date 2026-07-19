// Ported from bitpoker/test/common/bet_bounds_test.cpp — same fixtures, same
// expectations, so the TS mirror cannot drift silently.
import { BetView, betActionCost, computeBetBounds } from "./bet-bounds";

const thView = (over: Partial<BetView>): BetView => ({
  game: "TH",
  pot: 0,
  toCall: 0,
  currentBet: 0,
  lastRaiseSize: 0,
  bigBlind: 0,
  myCommitted: 0,
  myStack: 0,
  oppCommitted: 0,
  oppStack: 0,
  currentDarkBet: 0,
  hasLooked: false,
  ...over,
});

const zjhView = (over: Partial<BetView>): BetView =>
  thView({ game: "ZJH", ...over });

describe("computeBetBounds (bet_bounds.hpp port)", () => {
  it("TH raise presets include the pending call", () => {
    const b = computeBetBounds(
      thView({
        pot: 240,
        toCall: 40,
        currentBet: 80,
        lastRaiseSize: 40,
        bigBlind: 20,
        myCommitted: 40,
        myStack: 880,
        oppCommitted: 80,
        oppStack: 760,
      })
    );
    expect(b.hasBet).toBe(true);
    expect(b.minTarget).toBe(120); // currentBet + lastRaiseSize
    expect(b.halfPotTarget).toBe(220);
    expect(b.potTarget).toBe(360);
    expect(b.maxTarget).toBe(840); // opp effective total
    expect(b.maxIsTrueAllIn).toBe(false);
  });

  it("TH shorter stack max is a true all-in", () => {
    const b = computeBetBounds(
      thView({
        pot: 100,
        toCall: 50,
        currentBet: 50,
        lastRaiseSize: 50,
        bigBlind: 20,
        myStack: 200,
        oppCommitted: 50,
        oppStack: 500,
      })
    );
    expect(b.maxTarget).toBe(200);
    expect(b.maxIsTrueAllIn).toBe(true);
  });

  it("TH all-in-for-less collapses the bounds", () => {
    const b = computeBetBounds(
      thView({
        pot: 400,
        toCall: 100,
        currentBet: 200,
        lastRaiseSize: 200,
        bigBlind: 20,
        myCommitted: 100,
        myStack: 150,
        oppCommitted: 200,
        oppStack: 800,
      })
    );
    expect(b.hasBet).toBe(true);
    expect(b.minTarget).toBe(250);
    expect(b.maxTarget).toBe(250);
    expect(b.maxIsTrueAllIn).toBe(true);
  });

  it("TH no raise when the opponent is all-in", () => {
    const b = computeBetBounds(
      thView({
        pot: 400,
        toCall: 100,
        currentBet: 200,
        lastRaiseSize: 200,
        bigBlind: 20,
        myCommitted: 100,
        myStack: 500,
        oppCommitted: 200,
        oppStack: 0,
      })
    );
    expect(b.hasBet).toBe(false);
  });

  it("TH open bet bounds", () => {
    const b = computeBetBounds(
      thView({
        pot: 120,
        bigBlind: 20,
        myStack: 500,
        oppStack: 300,
      })
    );
    expect(b.hasBet).toBe(true);
    expect(b.minTarget).toBe(20);
    expect(b.maxTarget).toBe(300); // opponent can only call 300
    expect(b.maxIsTrueAllIn).toBe(false);
    expect(b.halfPotTarget).toBe(60);
    expect(b.potTarget).toBe(120);
  });

  it("ZJH looked doubles the cost and caps the level", () => {
    const v = zjhView({
      currentDarkBet: 5,
      myStack: 101,
      hasLooked: true,
    });
    const b = computeBetBounds(v);
    expect(b.hasBet).toBe(true);
    expect(b.zjhCostMultiplier).toBe(2);
    expect(b.minTarget).toBe(5);
    expect(b.maxTarget).toBe(51); // ceil(101 / 2)
    expect(b.maxIsTrueAllIn).toBe(true);
    expect(betActionCost(v, 5)).toBe(10);
    expect(betActionCost(v, 51)).toBe(101); // engine-capped at the stack
  });

  it("ZJH blind pays face value", () => {
    const v = zjhView({ currentDarkBet: 2, myStack: 40 });
    const b = computeBetBounds(v);
    expect(b.zjhCostMultiplier).toBe(1);
    expect(b.minTarget).toBe(2);
    expect(b.maxTarget).toBe(40);
    expect(betActionCost(v, 7)).toBe(7);
  });

  it("TH raise cost is the delta above committed", () => {
    const v = thView({ currentBet: 200, myCommitted: 40, myStack: 900 });
    expect(betActionCost(v, 220)).toBe(180);
  });
});
