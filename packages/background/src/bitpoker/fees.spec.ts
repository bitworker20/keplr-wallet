// Pins this copy of the fee arithmetic against the same cases as
// webapp/packages/poker-session/src/fees.spec.ts in the BitPoker monorepo. If
// one side changes, this fails and says so.
import { adjustGas, feeForGas, parseGasPrices, pickGasPrice } from "./fees";

describe("bitpoker fee arithmetic", () => {
  it("reads what the node service actually returns", () => {
    // Verbatim from /cosmos/base/node/v1beta1/config on pokerchaind 0.53.
    expect(parseGasPrices("0.025000000000000000uchip")).toEqual([
      { amount: "0.025", denom: "uchip" },
    ]);
    expect(parseGasPrices("0.01uchip,0.5stake")).toHaveLength(2);
    expect(parseGasPrices("")).toEqual([]);
  });

  it("prefers the denom the wallet holds", () => {
    const prices = parseGasPrices("0.5stake,0.01uchip");
    expect(pickGasPrice(prices, "uchip")?.denom).toBe("uchip");
    expect(pickGasPrice(prices, "nonesuch")?.denom).toBe("stake");
  });

  it("rounds the fee up, the way the SDK's fee check does", () => {
    expect(feeForGas(200000, { amount: "0.025", denom: "uchip" })).toEqual({
      denom: "uchip",
      amount: "5000",
    });
    // 100001 * 0.025 = 2500.025 -> 2501: one unit short is rejected.
    expect(feeForGas(100001, { amount: "0.025", denom: "uchip" })).toEqual({
      denom: "uchip",
      amount: "2501",
    });
  });

  it("returns no coin at all for a zero price", () => {
    expect(feeForGas(200000, { amount: "0", denom: "uchip" })).toBeUndefined();
  });

  it("keeps the caller's floor over a cheap estimate", () => {
    expect(adjustGas(100000)).toBe("140000");
    expect(adjustGas(100000, 1.4, 400000)).toBe("400000");
    expect(adjustGas(500000, 1.4, 400000)).toBe("700000");
  });
});
