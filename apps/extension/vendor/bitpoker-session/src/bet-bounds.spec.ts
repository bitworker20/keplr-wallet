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
      oppStack: 200, // opponent covers me: my own stack is the binding cap
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
    const v = zjhView({ currentDarkBet: 2, myStack: 40, oppStack: 40 });
    const b = computeBetBounds(v);
    expect(b.zjhCostMultiplier).toBe(1);
    expect(b.minTarget).toBe(2);
    expect(b.maxTarget).toBe(40);
    expect(betActionCost(v, 7)).toBe(7);
  });

  // ZJH stacks are chips owned, but every seat's commitment is capped at the
  // effective stake, so the deeper seat can only bet down to the shorter one.
  it("ZJH deep stack is capped by the shorter stack", () => {
    const v = zjhView({
      currentDarkBet: 2,
      myCommitted: 1,
      myStack: 100, // my total 101
      oppCommitted: 1,
      oppStack: 40, // opponent total 41 -> effective stake 41
    });
    const b = computeBetBounds(v);
    expect(b.hasBet).toBe(true);
    expect(b.maxTarget).toBe(40); // 41 effective - 1 already committed
    expect(b.maxIsTrueAllIn).toBe(false); // 60 chips stay behind
    expect(betActionCost(v, 100)).toBe(40);
  });

  it("ZJH short stack top level is a true all-in", () => {
    const v = zjhView({
      currentDarkBet: 2,
      myCommitted: 1,
      myStack: 40,
      oppCommitted: 1,
      oppStack: 100,
    });
    const b = computeBetBounds(v);
    expect(b.maxTarget).toBe(40);
    expect(b.maxIsTrueAllIn).toBe(true);
  });

  it("ZJH offers no bet once the short stack is covered", () => {
    const v = zjhView({
      currentDarkBet: 2,
      myCommitted: 40,
      myStack: 60,
      oppCommitted: 40,
      oppStack: 0,
    });
    expect(computeBetBounds(v).hasBet).toBe(false);
    expect(betActionCost(v, 5)).toBe(0);
  });

  it("TH raise cost is the delta above committed", () => {
    const v = thView({ currentBet: 200, myCommitted: 40, myStack: 900 });
    expect(betActionCost(v, 220)).toBe(180);
  });
});

// Omaha's sizing is Hold'em's: no-limit, same min-raise floor, same pot
// presets. Four hole cards change the showdown, not the betting. Pinned as an
// equality so a future "special case for O8" has to be a deliberate edit.
describe("Omaha Hi-Lo bet bounds", () => {
  const cases: ReadonlyArray<Partial<BetView>> = [
    {
      pot: 240,
      toCall: 40,
      currentBet: 80,
      lastRaiseSize: 40,
      bigBlind: 20,
      myCommitted: 40,
      myStack: 960,
      oppCommitted: 80,
      oppStack: 920,
    },
    {
      pot: 60,
      toCall: 0,
      currentBet: 0,
      bigBlind: 20,
      myCommitted: 0,
      myStack: 500,
      oppCommitted: 0,
      oppStack: 120,
    },
    {
      pot: 60,
      toCall: 0,
      currentBet: 0,
      bigBlind: 20,
      myCommitted: 0,
      myStack: 0,
      oppCommitted: 0,
      oppStack: 500,
    },
  ];

  it("matches Texas Hold'em field for field", () => {
    for (const over of cases) {
      const th = computeBetBounds(thView(over));
      const o8 = computeBetBounds(thView({ ...over, game: "O8" }));
      expect(o8).toEqual(th);
    }
  });

  it("prices an action the same way", () => {
    const over = cases[0];
    for (const amount of [80, 120, 240, 1000]) {
      expect(betActionCost(thView({ ...over, game: "O8" }), amount)).toBe(
        betActionCost(thView(over), amount)
      );
    }
  });
});
