// CHIP <-> uchip conversion, string-only arithmetic.
//
// The pokerchain base denom is uchip (6 decimals); CHIP is the display unit
// (1 CHIP = 1_000_000 uchip — the single knob lives in pokerchain app config).
// Stakes, pots and balances cross the LCD as uint64-as-string uchip amounts,
// which can exceed Number.MAX_SAFE_INTEGER, so every conversion here works on
// digit strings and never round-trips through floats.

export const UCHIP_PER_CHIP = 1_000_000;
const CHIP_DECIMALS = 6;

function stripLeadingZeros(digits: string): string {
  const stripped = digits.replace(/^0+/, "");
  return stripped.length === 0 ? "0" : stripped;
}

// "1.5" CHIP -> "1500000" uchip. Accepts a plain decimal with at most six
// fraction digits; throws on anything else (empty, sign, exponent, >6 dp).
export function chipToUchip(chip: string): string {
  const m = /^([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(chip.trim());
  if (!m) {
    throw new Error(
      `invalid CHIP amount "${chip}" (whole number with up to ${CHIP_DECIMALS} decimals)`
    );
  }
  const fraction = (m[2] ?? "").padEnd(CHIP_DECIMALS, "0");
  return stripLeadingZeros(m[1] + fraction);
}

// "1500000" uchip -> "1.5" CHIP (trailing fraction zeros trimmed).
export function uchipToChip(uchip: string | number): string {
  const text = String(uchip).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`invalid uchip amount "${uchip}" (whole number expected)`);
  }
  const digits = stripLeadingZeros(text);
  if (digits.length <= CHIP_DECIMALS) {
    const fraction = digits.padStart(CHIP_DECIMALS, "0").replace(/0+$/, "");
    return fraction.length === 0 ? "0" : `0.${fraction}`;
  }
  const whole = digits.slice(0, digits.length - CHIP_DECIMALS);
  const fraction = digits
    .slice(digits.length - CHIP_DECIMALS)
    .replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

// "1500000" -> "1.5 CHIP" — the one formatter every money surface goes through.
export function formatChip(uchip: string | number): string {
  return `${uchipToChip(uchip)} CHIP`;
}

// Compare two uchip integer strings (a < b) without BigInt/Number: normalize,
// then length-first lexicographic order.
export function uchipLessThan(a: string, b: string): boolean {
  const na = stripLeadingZeros(a.trim());
  const nb = stripLeadingZeros(b.trim());
  return na.length !== nb.length ? na.length < nb.length : na < nb;
}

// xpoker1abcdefgh…wxyz — raw bech32 addresses are unreadable in a list.
export function shortAddress(address: string): string {
  if (address.length <= 20) {
    return address;
  }
  return `${address.slice(0, 12)}…${address.slice(-6)}`;
}
