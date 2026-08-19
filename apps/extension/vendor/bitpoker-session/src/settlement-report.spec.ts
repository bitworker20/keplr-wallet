// Fixtures taken from a real wasm session (the gamecore probe run): stake
// 1000, final stacks 980/1020, relay fee 37 apportioned by largest remainder
// to 18/19. The point of the assertions is the identities, since a reconciled
// figure that does not add up is worse than no figure at all.
import { uchipAdd } from "./chip";
import { buildSettlementReport } from "./settlement-report";

const AMOUNTS = {
  playerAAmount: "980",
  playerBAmount: "1020",
  netPlayerAAmount: "962",
  netPlayerBAmount: "1001",
  relayFee: "37",
  splitPot: false,
};

describe("buildSettlementReport", () => {
  it("reads the seat's own side of the settlement", () => {
    const a = buildSettlementReport({
      sessionId: "7",
      localIsPlayerA: true,
      stake: "1000",
      amounts: AMOUNTS,
      submitted: true,
    });
    expect(a.grossMine).toBe("980");
    expect(a.grossTheirs).toBe("1020");
    expect(a.netMine).toBe("962");
    expect(a.feeMine).toBe("18");
    expect(a.won).toBe(false);
    expect(a.error).toBeUndefined();

    const b = buildSettlementReport({
      sessionId: "7",
      localIsPlayerA: false,
      stake: "1000",
      amounts: AMOUNTS,
      submitted: true,
    });
    // Same settlement, other seat: every pair is mirrored.
    expect(b.grossMine).toBe("1020");
    expect(b.netMine).toBe("1001");
    expect(b.feeMine).toBe("19");
    expect(b.won).toBe(true);
    expect(b.error).toBeUndefined();
  });

  it("splits the whole relay fee between the two seats", () => {
    const r = buildSettlementReport({
      sessionId: "7",
      localIsPlayerA: true,
      stake: "1000",
      amounts: AMOUNTS,
      submitted: true,
    });
    expect(uchipAdd(r.feeMine, r.feeTheirs)).toBe(r.relayFeeTotal);
  });

  it("flags a settlement that does not conserve the escrow", () => {
    const r = buildSettlementReport({
      sessionId: "7",
      localIsPlayerA: true,
      stake: "1000",
      // Internally consistent, just short of the escrow: 980 + 999 != 2000.
      amounts: { ...AMOUNTS, playerBAmount: "999", netPlayerBAmount: "980" },
      submitted: true,
    });
    expect(r.error).toMatch(/conserve the escrow/);
  });

  it("reports a net above gross instead of throwing mid-render", () => {
    const r = buildSettlementReport({
      sessionId: "7",
      localIsPlayerA: true,
      stake: "1000",
      amounts: { ...AMOUNTS, netPlayerAAmount: "1200" },
      submitted: true,
    });
    expect(r.error).toMatch(/paid more than it won/);
    expect(r.feeMine).toBe("0");
  });

  it("flags a fee that does not reconcile against the gross", () => {
    const r = buildSettlementReport({
      sessionId: "7",
      localIsPlayerA: true,
      stake: "1000",
      amounts: { ...AMOUNTS, relayFee: "40" },
      submitted: true,
    });
    expect(r.error).toMatch(/relay fee does not reconcile/);
  });

  it("does not claim the money landed when the result was not filed", () => {
    // RESULT_PENDING: our tx failed or never went out, so the escrow is still
    // locked however good the numbers look.
    const r = buildSettlementReport({
      sessionId: "7",
      localIsPlayerA: true,
      stake: "1000",
      amounts: AMOUNTS,
      submitted: false,
    });
    expect(r.submitted).toBe(false);
  });

  it("handles amounts beyond Number.MAX_SAFE_INTEGER", () => {
    // Stakes cross the LCD as uint64 strings; rounding one into a float here
    // would misreport a payout by an arbitrary amount.
    const huge = "9007199254740993"; // 2^53 + 1
    const r = buildSettlementReport({
      sessionId: "7",
      localIsPlayerA: true,
      stake: huge,
      amounts: {
        playerAAmount: huge,
        playerBAmount: huge,
        netPlayerAAmount: huge,
        netPlayerBAmount: huge,
        relayFee: "0",
      },
      submitted: true,
    });
    expect(r.error).toBeUndefined();
    expect(r.grossMine).toBe(huge);
    expect(r.feeMine).toBe("0");
  });

  it("treats a split pot as neither seat winning", () => {
    const r = buildSettlementReport({
      sessionId: "7",
      localIsPlayerA: true,
      stake: "1000",
      amounts: {
        playerAAmount: "1000",
        playerBAmount: "1000",
        netPlayerAAmount: "990",
        netPlayerBAmount: "990",
        relayFee: "20",
        splitPot: true,
      },
      submitted: true,
    });
    expect(r.splitPot).toBe(true);
    expect(r.won).toBe(false);
    expect(r.error).toBeUndefined();
  });
});
