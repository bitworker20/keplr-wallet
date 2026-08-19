import {
  chipToUchip,
  uchipToChip,
  formatChip,
  chipIsRounded,
  compactDecimals,
  formatChipCompact,
  uchipAdd,
  uchipEquals,
  uchipToCompact,
  uchipLessThan,
  uchipSub,
  shortAddress,
} from "./chip";

describe("chip <-> uchip conversion", () => {
  it("converts whole CHIP", () => {
    expect(chipToUchip("1")).toBe("1000000");
    expect(chipToUchip("100")).toBe("100000000");
    expect(chipToUchip("0")).toBe("0");
  });

  it("converts fractional CHIP up to six decimals", () => {
    expect(chipToUchip("1.5")).toBe("1500000");
    expect(chipToUchip("0.000001")).toBe("1");
    expect(chipToUchip("2.000001")).toBe("2000001");
  });

  it("rejects malformed CHIP input", () => {
    for (const bad of ["", ".", "1.", ".5", "1.2345678", "-1", "1e6", "abc"]) {
      expect(() => chipToUchip(bad)).toThrow();
    }
  });

  it("converts uchip back to CHIP with trimmed zeros", () => {
    expect(uchipToChip("1500000")).toBe("1.5");
    expect(uchipToChip("1000000")).toBe("1");
    expect(uchipToChip("1")).toBe("0.000001");
    expect(uchipToChip("0")).toBe("0");
    expect(uchipToChip(250000)).toBe("0.25");
  });

  it("round-trips values beyond Number.MAX_SAFE_INTEGER", () => {
    // 18446744073709551615 uchip is uint64 max — must survive untouched.
    const big = "18446744073709551615";
    expect(chipToUchip(uchipToChip(big))).toBe(big);
  });

  it("formats with the CHIP suffix", () => {
    expect(formatChip("1500000")).toBe("1.5 CHIP");
  });

  it("compares uchip strings without numeric overflow", () => {
    expect(uchipLessThan("999", "1000")).toBe(true);
    expect(uchipLessThan("1000", "999")).toBe(false);
    expect(uchipLessThan("0100", "100")).toBe(false); // equal after normalize
    expect(uchipLessThan("18446744073709551614", "18446744073709551615")).toBe(
      true
    );
  });

  it("shortens long addresses only", () => {
    expect(shortAddress("xpoker1short")).toBe("xpoker1short");
    expect(shortAddress("xpoker1y6xl2wyt7y5mchl7srr835qza254yexq2xra2e")).toBe(
      "xpoker1y6xl2…2xra2e"
    );
  });
});

describe("uchip arithmetic", () => {
  // Deliberately not BigInt: the Keplr extension compiles this package at
  // target ES2016. These have to be right on their own.
  it("adds and subtracts small amounts", () => {
    expect(uchipAdd("0", "0")).toBe("0");
    expect(uchipAdd("1", "9")).toBe("10");
    expect(uchipAdd("999", "1")).toBe("1000");
    expect(uchipSub("1000", "1")).toBe("999");
    expect(uchipSub("1000", "1000")).toBe("0");
    expect(uchipSub("980", "962")).toBe("18");
  });

  it("carries and borrows across many digits", () => {
    expect(uchipAdd("99999999999999999999", "1")).toBe("100000000000000000000");
    expect(uchipSub("100000000000000000000", "1")).toBe("99999999999999999999");
  });

  it("stays exact past Number.MAX_SAFE_INTEGER", () => {
    // 2^53 + 1: the first integer a float cannot represent. A stake this size
    // is a legal uint64 and must not be rounded on its way to a payout line.
    expect(uchipAdd("9007199254740992", "1")).toBe("9007199254740993");
    expect(uchipSub("9007199254740993", "1")).toBe("9007199254740992");
    expect(uchipAdd("18446744073709551615", "0")).toBe("18446744073709551615");
  });

  it("normalizes leading zeros on both sides", () => {
    expect(uchipAdd("007", "003")).toBe("10");
    expect(uchipSub("0010", "0001")).toBe("9");
    expect(uchipEquals("007", "7")).toBe(true);
    expect(uchipEquals("7", "8")).toBe(false);
  });

  it("refuses to produce a negative amount", () => {
    // These are unsigned on the wire; a negative payout is a bug to surface,
    // not a number to render.
    expect(() => uchipSub("1", "2")).toThrow(/negative/);
  });

  it("rejects anything that is not a whole number", () => {
    expect(() => uchipAdd("1.5", "1")).toThrow(/invalid uchip/);
    expect(() => uchipAdd("-1", "1")).toThrow(/invalid uchip/);
    expect(() => uchipSub("", "1")).toThrow(/invalid uchip/);
  });
});

describe("compact display amounts", () => {
  it("keeps amounts that already fit", () => {
    expect(formatChipCompact("1000000")).toBe("1 CHIP");
    expect(formatChipCompact("30000")).toBe("0.03 CHIP");
    expect(formatChipCompact("0")).toBe("0 CHIP");
    expect(chipIsRounded("30000")).toBe(false);
  });

  it("never shows less than the real amount", () => {
    // The whole reason for rounding away from zero: a call button that reads
    // 0.7619 for a 0.761904 payment is understating what it costs.
    expect(formatChipCompact("761904")).toBe("0.762 CHIP");
    expect(formatChipCompact("133056")).toBe("0.1331 CHIP");
    expect(formatChipCompact("1")).toBe("0.0001 CHIP");
    expect(formatChipCompact("99")).toBe("0.0001 CHIP");
  });

  it("rounds up even when to-nearest would round down", () => {
    // 0.000101 is nearer 0.0001 than 0.0002, but showing 0.0001 would
    // understate it. Half-up would fail this.
    expect(formatChipCompact("101")).toBe("0.0002 CHIP");
    expect(formatChipCompact("100001")).toBe("0.1001 CHIP");
  });

  it("reports whether the display lost anything", () => {
    expect(chipIsRounded("761904")).toBe(true);
    expect(chipIsRounded("762000")).toBe(false);
    expect(chipIsRounded("1")).toBe(true);
  });

  it("never emits more than the advertised decimals", () => {
    const inputs = ["1", "99", "101", "761904", "133056", "999999", "1000001"];
    for (const value of inputs) {
      const fraction =
        formatChipCompact(value).split(" ")[0].split(".")[1] ?? "";
      expect(fraction.length).toBeLessThanOrEqual(compactDecimals());
    }
  });

  it("stays exact past Number.MAX_SAFE_INTEGER", () => {
    expect(uchipToCompact("9007199254740993")).toBe("9007199254741000");
  });

  it("carries when rounding up crosses a digit boundary", () => {
    expect(uchipToCompact("999999")).toBe("1000000");
    expect(formatChipCompact("999999")).toBe("1 CHIP");
  });
});
