// What a bitpoker transaction costs, asked of the chain rather than guessed.
//
// This mirrors webapp/packages/poker-session/src/fees.ts in the BitPoker
// monorepo. It is a copy for the same reason proto-writer.ts is: this package
// compiles with `rootDir: "src"` and cannot include sources from outside
// itself. Keep the two in step — the arithmetic is pinned by unit tests on
// both sides.
//
//   gas limit   /cosmos/tx/v1beta1/simulate runs the messages and reports
//               gas_used; x1.4, the adjustment the Cosmos CLI's `--gas auto`
//               applies.
//   gas price   /cosmos/base/node/v1beta1/config reports minimum_gas_price
//               from the queried node's app.toml.
//
// Both are node-reported, not consensus: that node's policy is not necessarily
// another validator's. Neither is trusted blindly — a node that will not
// answer leaves the caller on its fixed gas limit and no fee coin, which is
// what this service sent before it learned to ask.
import { simpleFetch } from "@keplr-wallet/simple-fetch";

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

export const DEFAULT_GAS_ADJUSTMENT = 1.4;
const EVIDENCE_GAS_BASE = 400000;
const EVIDENCE_GAS_PER_BYTE = 60;
const MAX_EVIDENCE_GAS = 40000000;

const DEC_PLACES = 18;
const DEC_ONE = BigInt("1" + "0".repeat(DEC_PLACES));
const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);

// "0.025000000000000000uchip" -> [{ amount: "0.025", denom: "uchip" }].
// Also accepts a comma-separated list ("0.01uchip,0.5stake").
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

// ceil(gasLimit * price), the SDK's own rounding, in 18-decimal fixed point.
// Undefined for a zero price: a zero-amount Coin is not the same as no coin.
export function feeForGas(
  gasLimit: string | number,
  price: GasPrice
): Coin | undefined {
  const units = decToUnits(price.amount);
  if (units === BIG_ZERO) {
    return undefined;
  }
  const amount =
    (BigInt(String(gasLimit)) * units + DEC_ONE - BIG_ONE) / DEC_ONE;
  if (amount === BIG_ZERO) {
    return undefined;
  }
  return { denom: price.denom, amount: amount.toString() };
}

// Round the measured gas up by the adjustment, never below `floor`.
export function adjustGas(
  gasUsed: number,
  adjustment: number = DEFAULT_GAS_ADJUSTMENT,
  floor = 0
): string {
  return String(Math.max(Math.ceil(gasUsed * adjustment), Math.ceil(floor)));
}

// A dispute evidence tx carries the full protobuf transcript. Keep this in
// sync with webapp/packages/poker-session/src/fees.ts and the C++ gas floors.
export function evidenceGasFloor(payloadBytes: number): string {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
    throw new Error("evidence payload size must be a non-negative integer");
  }
  return String(
    Math.min(
      EVIDENCE_GAS_BASE + EVIDENCE_GAS_PER_BYTE * payloadBytes,
      MAX_EVIDENCE_GAS
    )
  );
}

// What the node charges, or undefined when it will not say.
export async function fetchNodeGasPrice(
  rest: string,
  preferredDenom?: string
): Promise<GasPrice | undefined> {
  try {
    const res = await simpleFetch<{ minimum_gas_price?: string }>(
      rest,
      "/cosmos/base/node/v1beta1/config"
    );
    const spec = res.data?.minimum_gas_price;
    if (typeof spec !== "string" || spec.trim() === "") {
      return undefined;
    }
    return pickGasPrice(parseGasPrices(spec), preferredDenom);
  } catch {
    return undefined;
  }
}

// gas_used for a tx against current state. The signature in txBytes may be
// junk — simulation skips verification — but the signer info must carry the
// right pubkey and sequence, because they are part of what is measured.
export async function simulateGasUsed(
  rest: string,
  txBytesBase64: string
): Promise<number> {
  const res = await simpleFetch<{ gas_info?: { gas_used?: string } }>(
    rest,
    "/cosmos/tx/v1beta1/simulate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_bytes: txBytesBase64 }),
    }
  );
  const used = Number(res.data?.gas_info?.gas_used ?? 0);
  if (!Number.isFinite(used) || used <= 0) {
    throw new Error("simulate returned no gas_used");
  }
  return used;
}

function decToUnits(dec: string): bigint {
  const [whole, fraction = ""] = dec.split(".");
  const padded = (fraction + "0".repeat(DEC_PLACES)).slice(0, DEC_PLACES);
  return BigInt(whole || "0") * DEC_ONE + BigInt(padded || "0");
}

function trimStrayZeros(dec: string): string {
  if (!dec.includes(".")) {
    return dec === "" ? "0" : dec;
  }
  const trimmed = dec.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "0" ? "0" : trimmed;
}
