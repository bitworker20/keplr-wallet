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

// Sum and difference on uchip integer strings.
//
// String arithmetic rather than BigInt, for the same reason the conversions
// above avoid floats — and one more: the Keplr extension compiles this package
// at target ES2016, where BigInt does not exist. A helper that works in only
// one of the two front ends is not a shared helper.
function normalize(value: string): string {
  const text = value.trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`invalid uchip amount "${value}" (whole number expected)`);
  }
  return stripLeadingZeros(text);
}

export function uchipAdd(a: string, b: string): string {
  const x = normalize(a);
  const y = normalize(b);
  let carry = 0;
  let out = "";
  for (let i = 0; i < Math.max(x.length, y.length) || carry > 0; i++) {
    const dx = i < x.length ? Number(x[x.length - 1 - i]) : 0;
    const dy = i < y.length ? Number(y[y.length - 1 - i]) : 0;
    const sum = dx + dy + carry;
    out = String(sum % 10) + out;
    carry = sum >= 10 ? 1 : 0;
  }
  return out === "" ? "0" : out;
}

// a - b. Throws when b > a: these amounts are unsigned on the wire, and a
// negative payout is a bug worth surfacing rather than rendering.
export function uchipSub(a: string, b: string): string {
  const x = normalize(a);
  const y = normalize(b);
  if (uchipLessThan(x, y)) {
    throw new Error(`uchip subtraction would go negative: ${x} - ${y}`);
  }
  let borrow = 0;
  let out = "";
  for (let i = 0; i < x.length; i++) {
    const dx = Number(x[x.length - 1 - i]);
    const dy = i < y.length ? Number(y[y.length - 1 - i]) : 0;
    let digit = dx - dy - borrow;
    borrow = digit < 0 ? 1 : 0;
    if (digit < 0) {
      digit += 10;
    }
    out = String(digit) + out;
  }
  return stripLeadingZeros(out);
}

export function uchipEquals(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

// --- Compact display amounts -------------------------------------------------
//
// Blinds are a percentage of the effective stack and are recomputed every
// hand, so from the second hand on almost every amount is a six-decimal
// fraction ("0.761904"). Those strings set the width of seat plates, action
// buttons and log lines, and on a narrow screen they push the felt past the
// edge. Four decimals is 0.0001 CHIP = 100 uchip of display precision.
//
// Rounding is AWAY FROM ZERO, not to nearest: a number the player is about to
// pay must never be shown as less than it is. (The Qt client does the same —
// its comment says "half-up" but its code ceilings, and ceiling is what its
// stated reason requires.) This is display only; every action still sends the
// exact integer, and chipIsRounded() lets a surface offer the exact value
// where the difference could matter.
const COMPACT_DECIMALS = 4;
// uchip per displayed step: 10^(6-4).
const COMPACT_STEP = 100;

function compactRemainder(digits: string): number {
  const tail = digits.length >= 2 ? digits.slice(-2) : digits;
  return Number(tail) % COMPACT_STEP;
}

// True when showing this amount at four decimals loses digits, so a caller can
// attach the exact figure rather than quietly rounding money.
export function chipIsRounded(uchip: string | number): boolean {
  return compactRemainder(normalize(String(uchip))) !== 0;
}

// The amount rounded up to the next displayable step.
export function uchipToCompact(uchip: string | number): string {
  const digits = normalize(String(uchip));
  const remainder = compactRemainder(digits);
  return remainder === 0
    ? digits
    : uchipAdd(digits, String(COMPACT_STEP - remainder));
}

// "761904" -> "0.762 CHIP". Trailing zeros are already trimmed by uchipToChip,
// and the rounded value is a multiple of COMPACT_STEP, so the result never
// carries more than COMPACT_DECIMALS decimals.
export function formatChipCompact(uchip: string | number): string {
  return formatChip(uchipToCompact(uchip));
}

// Guard for the claim above, exported so a spec can hold the pair together.
export function compactDecimals(): number {
  return COMPACT_DECIMALS;
}

// xpoker1abcdefgh…wxyz — raw bech32 addresses are unreadable in a list.
export function shortAddress(address: string): string {
  if (address.length <= 20) {
    return address;
  }
  return `${address.slice(0, 12)}…${address.slice(-6)}`;
}
