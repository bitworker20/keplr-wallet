// Ask the chain what a transaction costs, instead of hard-coding it.
//
// Two numbers make up a fee, and each has its own source of truth:
//
//   gas limit   how much work the tx is. /cosmos/tx/v1beta1/simulate runs the
//               messages and reports gas_used; multiply by an adjustment,
//               because the simulated run and the real one differ slightly
//               (different sequence, signature bytes, and state moved on).
//   gas price   what the node charges per unit.
//               /cosmos/base/node/v1beta1/config reports minimum_gas_price
//               straight from the node's app.toml.
//
// Both are node-reported, not consensus: `minimum_gas_price` is *this* node's
// policy and another validator may want more. That is the same trust the
// client already places in its LCD for balances and session state, and it is
// strictly better than a number typed into a config file months ago — but it
// is why a client should keep a floor/ceiling of its own rather than sign
// whatever a node asks for.
//
// A chain with `minimum-gas-prices = "0uchip"` (the dev testnet) reports "0",
// which resolves to no fee coin at all — exactly what these clients sent
// before this module existed.

export interface GasPrice {
  // Decimal string, e.g. "0.025". Not a number: an sdk.DecCoin carries 18
  // fractional digits and float rounding here becomes a rejected tx.
  amount: string;
  denom: string;
}

export interface Coin {
  denom: string;
  amount: string;
}

// The simulated run never matches the real one exactly. 1.4 is what the Cosmos
// CLI's `--gas auto` defaults to (1.0 with a 0.4 adjustment on top).
export const DEFAULT_GAS_ADJUSTMENT = 1.4;

// BigInt LITERALS (18n) are unavailable at this package's TS target — the
// Keplr extension compiles these sources at ES2016 — so every bigint here is
// built with the constructor. Same rule as endpoint-blob.ts.
const DEC_PLACES = 18;
const DEC_ONE = BigInt("1" + "0".repeat(DEC_PLACES));
const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);

// "0.025000000000000000uchip" -> { amount: "0.025", denom: "uchip" }
// Also accepts a comma-separated list ("0.01uchip,0.5stake") and returns all.
export function parseGasPrices(spec: string): GasPrice[] {
  const out: GasPrice[] = [];
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^([0-9]*\.?[0-9]*)\s*([a-zA-Z][a-zA-Z0-9/:._-]*)$/.exec(
      trimmed
    );
    if (!match || match[1] === "" || match[1] === ".") {
      continue;
    }
    out.push({ amount: trimStrayZeros(match[1]), denom: match[2] });
  }
  return out;
}

// Which of several advertised prices to pay in. The caller knows the denom it
// holds; anything else on the list is a denom it cannot spend.
export function pickGasPrice(
  prices: readonly GasPrice[],
  preferredDenom?: string
): GasPrice | undefined {
  if (preferredDenom) {
    const match = prices.find((p) => p.denom === preferredDenom);
    if (match) {
      return match;
    }
  }
  return prices[0];
}

// What the node charges, or undefined when it will not say — an older SDK
// without the node service, a gateway that hides it, or a network error. The
// caller decides what to do with "unknown"; this function does not invent a
// price.
export async function fetchNodeGasPrice(
  lcdUrl: string,
  preferredDenom?: string
): Promise<GasPrice | undefined> {
  const base = lcdUrl.replace(/\/+$/, "");
  let body: { minimum_gas_price?: string } | undefined;
  try {
    const res = await fetch(`${base}/cosmos/base/node/v1beta1/config`);
    if (!res.ok) {
      return undefined;
    }
    body = await res.json();
  } catch {
    return undefined;
  }
  const spec = body?.minimum_gas_price;
  if (typeof spec !== "string" || spec.trim() === "") {
    return undefined;
  }
  return pickGasPrice(parseGasPrices(spec), preferredDenom);
}

// gas_used for a tx, from a real run against current state. txBytes is a
// base64 TxRaw whose signature may be junk — simulation skips verification —
// but the signer info must carry the right pubkey and sequence, because they
// are part of what is being measured.
export async function simulateGasUsed(
  lcdUrl: string,
  txBytesBase64: string
): Promise<number> {
  const base = lcdUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/cosmos/tx/v1beta1/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_bytes: txBytesBase64 }),
  });
  if (!res.ok) {
    throw new Error(`simulate failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const used = Number(body?.gas_info?.gas_used ?? 0);
  if (!Number.isFinite(used) || used <= 0) {
    throw new Error("simulate returned no gas_used");
  }
  return used;
}

// Round the measured gas up by the adjustment, never below `floor`.
export function adjustGas(
  gasUsed: number,
  adjustment: number = DEFAULT_GAS_ADJUSTMENT,
  floor = 0
): string {
  return String(Math.max(Math.ceil(gasUsed * adjustment), Math.ceil(floor)));
}

// ceil(gasLimit * price) in the price's denom, as an integer string — the same
// rounding the SDK's fee check applies, so a fee computed here is accepted at
// exactly the advertised price rather than one unit short.
//
// Returns undefined for a zero price: a zero-amount coin is not the same as no
// coin, and some ante handlers reject it.
export function feeForGas(
  gasLimit: string | number,
  price: GasPrice
): Coin | undefined {
  const units = decToUnits(price.amount);
  if (units === BIG_ZERO) {
    return undefined;
  }
  const gas = BigInt(String(gasLimit));
  const product = gas * units;
  const amount = (product + DEC_ONE - BIG_ONE) / DEC_ONE; // ceil
  if (amount === BIG_ZERO) {
    return undefined;
  }
  return { denom: price.denom, amount: amount.toString() };
}

// "0.025" -> 25000000000000000n (18-decimal fixed point, as sdk.Dec stores it)
function decToUnits(dec: string): bigint {
  const [whole, fraction = ""] = dec.split(".");
  const padded = (fraction + "0".repeat(DEC_PLACES)).slice(0, DEC_PLACES);
  return BigInt(whole || "0") * DEC_ONE + BigInt(padded || "0");
}

// "0.025000000000000000" -> "0.025"; "1." -> "1"
function trimStrayZeros(dec: string): string {
  if (!dec.includes(".")) {
    return dec === "" ? "0" : dec;
  }
  const trimmed = dec.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "0" ? "0" : trimmed;
}
