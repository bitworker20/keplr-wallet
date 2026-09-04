// The states the client used to get wrong, pinned as fixtures: a Texas Hold'em
// table whose hole cards have not arrived yet (which used to render a live
// Preflop action bar over two card backs), a showdown (which used to keep the
// full betting bar), and a finished two-hand session (which used to announce
// "Hand 3").
import { GameSnapshot } from "./controller";
import { TableCard, TableState } from "./types";
import { deriveTablePhase, deriveTableView } from "./table-phase";

const card = (index: number, name: string): TableCard => ({ index, name });

const thTable = (over: Partial<TableState> = {}): TableState => ({
  ready: true,
  game: "TH",
  phase: 0,
  pot: 30000,
  dealing: false,
  settled: false,
  handNumber: 1,
  handsPlayed: 0,
  myHoleCards: [card(0, "AS"), card(1, "KD")],
  communityCards: [],
  ...over,
});

// Omaha's felt behaves like Hold'em except that a seat is waiting for FOUR
// hole cards, not two.
const o8Table = (over: Partial<TableState> = {}): TableState => ({
  ready: true,
  game: "O8",
  phase: 0,
  pot: 30000,
  dealing: false,
  settled: false,
  handNumber: 1,
  handsPlayed: 0,
  myHoleCards: [card(0, "AS"), card(1, "KD"), card(2, "7C"), card(3, "2H")],
  communityCards: [],
  ...over,
});

const zjhTable = (over: Partial<TableState> = {}): TableState => ({
  ready: true,
  game: "ZJH",
  pot: 20000,
  dealing: false,
  settled: false,
  handNumber: 1,
  handsPlayed: 0,
  showdownComplete: false,
  myCards: [],
  ...over,
});

const snap = (
  table: TableState | undefined,
  over: Partial<GameSnapshot> = {}
): GameSnapshot => ({
  stage: "playing",
  message: "",
  wait: 0,
  table,
  ...over,
});

describe("deriveTablePhase", () => {
  it("is securing while the deck is being shuffled and proved", () => {
    expect(deriveTablePhase(snap(thTable({ dealing: true })))).toBe("securing");
  });

  it("is securing before the table exists but the session is live", () => {
    expect(deriveTablePhase(snap(undefined))).toBe("securing");
    expect(deriveTablePhase(snap({ ready: false } as TableState))).toBe(
      "securing"
    );
  });

  it("is idle when no session is running", () => {
    expect(deriveTablePhase(snap(undefined, { stage: "idle" }))).toBe("idle");
    expect(deriveTablePhase(snap(undefined, { stage: "matching" }))).toBe(
      "idle"
    );
  });

  it("is dealing while Hold'em hole cards are still encrypted", () => {
    // The regression: `dealing` covers only the shuffle, so this window used
    // to look like a normal, actionable Preflop with two face-down cards.
    expect(deriveTablePhase(snap(thTable({ myHoleCards: [] })))).toBe(
      "dealing"
    );
    expect(
      deriveTablePhase(snap(thTable({ myHoleCards: [card(0, "AS")] })))
    ).toBe("dealing");
  });

  it("is betting once both hole cards can be read", () => {
    expect(deriveTablePhase(snap(thTable()))).toBe("betting");
  });

  it("treats ZhaJinHua's undealt own cards as playable", () => {
    // Betting blind is the game, not a missing deal: ZJH hands out a player's
    // own cards only when they look.
    expect(deriveTablePhase(snap(zjhTable({ myCards: [] })))).toBe("betting");
  });

  it("is showdown on the Hold'em showdown and complete streets", () => {
    expect(deriveTablePhase(snap(thTable({ phase: 4 })))).toBe("showdown");
    expect(deriveTablePhase(snap(thTable({ phase: 5 })))).toBe("showdown");
  });

  it("is showdown once ZhaJinHua has compared", () => {
    expect(deriveTablePhase(snap(zjhTable({ showdownComplete: true })))).toBe(
      "showdown"
    );
  });

  it("is settled when the session ends, however it ends", () => {
    expect(deriveTablePhase(snap(thTable(), { stage: "done" }))).toBe(
      "settled"
    );
    expect(deriveTablePhase(snap(thTable(), { stage: "error" }))).toBe(
      "settled"
    );
    expect(deriveTablePhase(snap(thTable(), { stage: "disputed" }))).toBe(
      "settled"
    );
    expect(deriveTablePhase(snap(thTable({ settled: true })))).toBe("settled");
  });
});

describe("deriveTableView", () => {
  it("only allows acting during a betting round", () => {
    const actionable = (table: TableState) =>
      deriveTableView(snap(table, { wait: 0 }));

    expect(actionable(thTable()).canAct).toBe(true);
    expect(actionable(thTable()).myTurn).toBe(true);

    // Each of these used to leave a live-looking action bar on screen.
    for (const table of [
      thTable({ myHoleCards: [] }),
      thTable({ dealing: true }),
      thTable({ phase: 4 }),
      thTable({ settled: true }),
    ]) {
      expect(actionable(table).canAct).toBe(false);
      expect(actionable(table).myTurn).toBe(false);
    }
  });

  it("does not call it my turn while the peer owes a move", () => {
    const view = deriveTableView(snap(thTable(), { wait: 1 }));
    expect(view.canAct).toBe(true);
    expect(view.myTurn).toBe(false);
    expect(view.waitingForPeer).toBe(true);
  });

  it("does not blame the opponent for the table's own work", () => {
    // Shuffling, dealing and revealing are not the opponent being slow.
    for (const table of [
      thTable({ dealing: true }),
      thTable({ myHoleCards: [] }),
      thTable({ phase: 4 }),
    ]) {
      expect(deriveTableView(snap(table, { wait: 1 })).waitingForPeer).toBe(
        false
      );
    }
  });

  it("highlights an actor only during a betting round", () => {
    expect(deriveTableView(snap(thTable())).showActor).toBe(true);
    expect(deriveTableView(snap(thTable({ phase: 4 }))).showActor).toBe(false);
    expect(deriveTableView(snap(thTable({ settled: true }))).showActor).toBe(
      false
    );
  });

  it("counts the hand being played, not the next one", () => {
    const playing = deriveTableView(
      snap(thTable({ handNumber: 2, handsPlayed: 1 }))
    );
    expect(playing.handNumber).toBe(2);

    // Two hands played, session over: the gamecore's handNumber is 3 because
    // it names the hand that would come next.
    const over = deriveTableView(
      snap(thTable({ handNumber: 3, handsPlayed: 2, settled: true }))
    );
    expect(over.handNumber).toBe(2);
    expect(over.handsPlayed).toBe(2);
  });

  it("does not claim a hand was played when the session died first", () => {
    const over = deriveTableView(
      snap(thTable({ handNumber: 1, handsPlayed: 0 }), { stage: "error" })
    );
    expect(over.handNumber).toBe(1);
    expect(over.handsPlayed).toBe(0);
  });

  it("names the street while betting and the phase otherwise", () => {
    expect(deriveTableView(snap(thTable({ phase: 1 }))).label).toBe("Flop");
    expect(deriveTableView(snap(thTable({ phase: 4 }))).label).toBe("Showdown");
    expect(deriveTableView(snap(thTable({ dealing: true }))).label).toBe(
      "Shuffling securely"
    );
    expect(deriveTableView(snap(thTable({ myHoleCards: [] }))).label).toBe(
      "Dealing"
    );
    // ZJH has no streets to name.
    expect(deriveTableView(snap(zjhTable())).label).toBe("Betting");
  });
});

describe("Omaha Hi-Lo", () => {
  it("is still dealing while only two of the four hole cards have arrived", () => {
    // Two cards is a complete Hold'em hand and an incomplete Omaha one. Reading
    // the count with Hold'em's threshold would open the action bar over two
    // card backs.
    const partial = o8Table({
      myHoleCards: [card(0, "AS"), card(1, "KD")],
    });
    expect(deriveTablePhase(snap(partial))).toBe("dealing");
  });

  it("is betting once all four hole cards are dealt", () => {
    expect(deriveTablePhase(snap(o8Table()))).toBe("betting");
  });

  it("uses the street name on the felt, like Hold'em and unlike ZJH", () => {
    const flop = o8Table({
      phase: 1,
      communityCards: [card(4, "2D"), card(5, "9S"), card(6, "JH")],
    });
    expect(deriveTableView(snap(flop)).label).toBe(
      deriveTableView(snap(thTable({ phase: 1 }))).label
    );
  });

  it("reaches showdown on the phase number, like Hold'em", () => {
    expect(deriveTablePhase(snap(o8Table({ phase: 4 })))).toBe("showdown");
  });
});
