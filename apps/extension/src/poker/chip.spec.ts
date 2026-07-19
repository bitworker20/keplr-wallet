import {
  chipToUchip,
  uchipToChip,
  formatChip,
  uchipLessThan,
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
