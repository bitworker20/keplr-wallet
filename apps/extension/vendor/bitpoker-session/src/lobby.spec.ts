import {
  ChainGameIntent,
  chainGameTypeId,
  chainGameTypeName,
  intentExpired,
  joinableIntents,
  localGameName,
} from "./lobby";

const intent = (over: Partial<ChainGameIntent>): ChainGameIntent => ({
  expires_at_height: "0",
  intent_id: "1",
  creator: "xpoker1creator",
  opponent: "",
  game_type: "GAME_TYPE_TH",
  min_stake: "100",
  max_stake: "200",
  status: "GAME_INTENT_STATUS_PENDING",
  player_session_pubkey: "aa",
  matched_session_id: "0",
  ...over,
});

describe("lobby filtering", () => {
  const me = "xpoker1me";

  it("drops my own intents", () => {
    expect(joinableIntents([intent({ creator: me })], me)).toHaveLength(0);
  });

  it("keeps open intents from others", () => {
    expect(joinableIntents([intent({})], me)).toHaveLength(1);
    expect(joinableIntents([intent({ opponent: "ANY" })], me)).toHaveLength(1);
  });

  it("keeps private challenges aimed at me, drops others", () => {
    expect(joinableIntents([intent({ opponent: me })], me)).toHaveLength(1);
    expect(
      joinableIntents([intent({ opponent: "xpoker1other" })], me)
    ).toHaveLength(0);
  });

  it("drops intents that are no longer pending", () => {
    // The status query parameter is the first line of defence; this is what
    // catches a gateway that ignored it.
    expect(
      joinableIntents([intent({ status: "GAME_INTENT_STATUS_MATCHED" })], me)
    ).toHaveLength(0);
    expect(
      joinableIntents([intent({ status: "GAME_INTENT_STATUS_CANCELLED" })], me)
    ).toHaveLength(0);
  });

  it("drops offers the chain will no longer match", () => {
    // Expired intents stay PENDING on chain — nothing sweeps them — so this
    // is the only thing standing between the lobby and a game that cannot
    // start. Joining one costs a fee for an intent that can never match.
    const expiring = intent({ expires_at_height: "500" });
    expect(joinableIntents([expiring], me, 499)).toHaveLength(1);
    expect(joinableIntents([expiring], me, 500)).toHaveLength(0);
    expect(joinableIntents([expiring], me, 900)).toHaveLength(0);
  });

  it("keeps every offer when the height is unknown", () => {
    // The height query failed; an empty lobby would be a worse lie than a
    // stale one, and the native client makes the same choice.
    expect(
      joinableIntents([intent({ expires_at_height: "500" })], me, 0)
    ).toHaveLength(1);
  });

  it("treats a zero deadline as never expiring", () => {
    expect(intentExpired(intent({ expires_at_height: "0" }), 10_000)).toBe(
      false
    );
    expect(intentExpired(intent({}), 10_000)).toBe(false);
  });

  it("drops unplayable game types", () => {
    expect(
      joinableIntents([intent({ game_type: "GAME_TYPE_CC" })], me)
    ).toHaveLength(0);
  });

  it("maps chain game types to local names", () => {
    expect(localGameName("GAME_TYPE_TH")).toBe("TH");
    expect(localGameName("GAME_TYPE_ZJH")).toBe("ZJH");
    expect(localGameName("GAME_TYPE_CC")).toBeUndefined();
  });
});

// The chain enum and the local game name have to agree in BOTH directions: the
// lobby filters on one and the intent it opens carries the other, so a
// half-added game shows up as "joinable" and then seats the player in a
// different game.
describe("chain game type mapping", () => {
  const cases: ReadonlyArray<[string, string, "TH" | "ZJH" | "O8", number]> = [
    ["GAME_TYPE_ZJH", "2", "ZJH", 2],
    ["GAME_TYPE_TH", "3", "TH", 3],
    ["GAME_TYPE_O8", "4", "O8", 4],
  ];

  it("maps every playable type by name and by number", () => {
    for (const [name, id, local, num] of cases) {
      expect(localGameName(name)).toBe(local);
      expect(localGameName(id)).toBe(local);
      expect(chainGameTypeId(local)).toBe(num);
    }
  });

  it("leaves a type this client cannot deal unmapped", () => {
    // CC has no engine; the chain rejects it too. An unmapped type is what
    // keeps such an intent out of the lobby list.
    expect(localGameName("GAME_TYPE_CC")).toBeUndefined();
    expect(localGameName("1")).toBeUndefined();
    expect(localGameName("GAME_TYPE_UNSPECIFIED")).toBeUndefined();
  });

  it("labels approval-dialog game types without falling back to another game", () => {
    expect(chainGameTypeName(2)).toBe("ZhaJinHua");
    expect(chainGameTypeName(3)).toBe("Texas Hold'em");
    expect(chainGameTypeName(4)).toBe("Omaha Hi-Lo");
    expect(chainGameTypeName(99)).toBe("unknown game (type 99)");
  });
});
