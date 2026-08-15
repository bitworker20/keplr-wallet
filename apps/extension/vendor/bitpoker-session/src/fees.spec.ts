import { adjustGas, feeForGas, parseGasPrices, pickGasPrice } from "./fees";

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
  it("applies the CLI's default adjustment and rounds up", () => {
    expect(adjustGas(100000)).toBe("140000");
    expect(adjustGas(100001)).toBe("140002");
  });

  it("honours a floor for messages whose simulation understates them", () => {
    expect(adjustGas(100000, 1.4, 400000)).toBe("400000");
    expect(adjustGas(500000, 1.4, 400000)).toBe("700000");
  });
});
