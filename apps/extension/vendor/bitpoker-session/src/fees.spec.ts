import {
  adjustGas,
  adjudicateGasBound,
  evidenceGasBound,
  feeForGas,
  parseGasPrices,
  pickGasPrice,
} from "./fees";
import { MAX_MSG_GAS, MAX_STORED_EVIDENCE_BYTES } from "./gas-bounds.generated";

describe("parseGasPrices", () => {
  it("reads what the node service actually returns", () => {
    // Verbatim from /cosmos/base/node/v1beta1/config on pokerchaind 0.53.
    expect(parseGasPrices("0.025000000000000000uchip")).toEqual([
      { amount: "0.025", denom: "uchip" },
    ]);
  });

  it("reads a multi-denom list", () => {
    expect(parseGasPrices("0.01uchip,0.5stake")).toEqual([
      { amount: "0.01", denom: "uchip" },
      { amount: "0.5", denom: "stake" },
    ]);
  });

  it("reads a zero price as zero rather than as absent", () => {
    expect(parseGasPrices("0uchip")).toEqual([{ amount: "0", denom: "uchip" }]);
  });

  it("ignores junk instead of inventing a price", () => {
    expect(parseGasPrices("")).toEqual([]);
    expect(parseGasPrices("uchip")).toEqual([]);
    expect(parseGasPrices("0.01")).toEqual([]);
  });
});

describe("pickGasPrice", () => {
  const prices = parseGasPrices("0.5stake,0.01uchip");

  it("prefers the denom the wallet actually holds", () => {
    expect(pickGasPrice(prices, "uchip")).toEqual({
      amount: "0.01",
      denom: "uchip",
    });
  });

  it("falls back to the first advertised price", () => {
    expect(pickGasPrice(prices, "nonesuch")?.denom).toBe("stake");
    expect(pickGasPrice([])).toBeUndefined();
  });
});

describe("evidenceGasBound", () => {
  it("scales with the evidence payload", () => {
    expect(evidenceGasBound(0)).toBe("400000");
    expect(evidenceGasBound(16 * 1024)).toBe("1383040");
    // The whole 1 MiB the chain accepts, priced linearly. The saturation guard
    // must sit ABOVE this: clipping here would hand the caller a limit smaller
    // than the real cost, which is the failure this table exists to prevent.
    expect(evidenceGasBound(1024 * 1024)).toBe("63314560");
  });

  it("saturates only on a nonsense payload size", () => {
    expect(Number(evidenceGasBound(1024 * 1024 * 1024))).toBe(MAX_MSG_GAS);
  });

  it("refuses a size that is not a byte count", () => {
    expect(() => evidenceGasBound(-1)).toThrow();
    expect(() => evidenceGasBound(1.5)).toThrow();
  });
});

describe("adjudicateGasBound", () => {
  // Session 101: 515,703 bytes of evidence really cost 1,603,147 gas, against
  // the 500,000 the clients promised and the 200,000 relayd's permissionless
  // crank promised. Both numbers have to clear it now.
  it("clears what session 101 actually cost", () => {
    expect(Number(adjudicateGasBound(515703))).toBeGreaterThan(1603147);
  });

  it("prices the largest stored transcript when the size is unknown", () => {
    expect(adjudicateGasBound()).toBe(
      adjudicateGasBound(MAX_STORED_EVIDENCE_BYTES)
    );
    expect(Number(adjudicateGasBound())).toBeGreaterThan(
      Number(adjudicateGasBound(515703))
    );
  });
});

describe("feeForGas", () => {
  it("rounds up, the way the SDK's fee check does", () => {
    // 200000 * 0.025 = 5000 exactly
    expect(feeForGas(200000, { amount: "0.025", denom: "uchip" })).toEqual({
      denom: "uchip",
      amount: "5000",
    });
    // 100001 * 0.025 = 2500.025 -> 2501, not 2500: one unit short is rejected
    expect(feeForGas(100001, { amount: "0.025", denom: "uchip" })).toEqual({
      denom: "uchip",
      amount: "2501",
    });
  });

  it("keeps full precision on an 18-decimal price", () => {
    expect(
      feeForGas(1000000, { amount: "0.000000000000000001", denom: "uchip" })
    ).toEqual({ denom: "uchip", amount: "1" });
  });

  it("survives a gas limit past Number.MAX_SAFE_INTEGER", () => {
    expect(
      feeForGas("100000000000000000000", { amount: "1", denom: "u" })
    ).toEqual({ denom: "u", amount: "100000000000000000000" });
  });

  it("returns no coin at all for a zero price", () => {
    // A zero-amount Coin is not the same as an empty fee, and some ante
    // handlers reject it.
    expect(feeForGas(200000, { amount: "0", denom: "uchip" })).toBeUndefined();
  });
});

describe("adjustGas", () => {
  it("applies the default adjustment and rounds up", () => {
    expect(adjustGas(100000)).toBe("400000");
    expect(adjustGas(100001)).toBe("400004");
  });

  // The adjustment covers a message that simulates on one code path and
  // delivers on another: MsgOpenGameIntent simulates as "no match" (81,789 gas
  // on session 119) and delivers as "match" (291,459 in the chain's worst
  // case). 4.0 clears that 3.56x.
  it("covers the simulate-cheap deliver-heavy path change", () => {
    expect(Number(adjustGas(81789))).toBeGreaterThan(291459);
  });

  // This is the direction that flipped. Taking the LARGER made every message
  // reserve — and pay for — the padded bound; session 119 paid 10,000uchip for
  // a 1,000,000 reservation against 81,789 gas of real work.
  it("clamps to the bound instead of reserving it", () => {
    expect(adjustGas(81789, 4.0, 1000000)).toBe("327156");
    expect(adjustGas(500000, 4.0, 1000000)).toBe("1000000");
  });

  it("leaves the estimate unclamped when no bound is given", () => {
    expect(adjustGas(500000, 4.0, 0)).toBe("2000000");
  });
});
