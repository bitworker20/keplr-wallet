// What a bitpoker transaction costs, asked of the chain rather than guessed.
//
// This mirrors webapp/packages/poker-session/src/fees.ts in the BitPoker
// monorepo. It is a copy for the same reason proto-writer.ts is: this package
// compiles with `rootDir: "src"` and cannot include sources from outside
// itself. Keep the two in step — the arithmetic is pinned by unit tests on
// both sides.
//
//   gas limit   /cosmos/tx/v1beta1/simulate runs the messages and reports
//               gas_used; x4.0, clamped to the message's published bound.
//   gas price   /cosmos/base/node/v1beta1/config reports minimum_gas_price
//               from the queried node's app.toml.
//
// Both are node-reported, not consensus: that node's policy is not necessarily
// another validator's. Neither is trusted blindly — a node that will not
// answer leaves the caller on its fixed gas limit and no fee coin, which is
// what this service sent before it learned to ask.
import { simpleFetch } from "@keplr-wallet/simple-fetch";
import {
  adjudicateSessionBound,
  GAS_CANCEL_GAME_INTENT,
  GAS_CLAIM_SESSION_TIMEOUT,
  GAS_OPEN_GAME_INTENT,
  GAS_SUBMIT_SESSION_RESULT,
  GAS_SUBMIT_SESSION_SECRET,
  MAX_STORED_EVIDENCE_BYTES,
  submitSessionEvidenceBound,
} from "./gas-bounds.generated";

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

// The multiplier on a simulated run, and the reason it is not the Cosmos CLI's
// 1.4. That 1.4 only covers the small drift between simulating and signing. It
// does not cover a message that simulates on one code path and DELIVERS on
// another, and this chain has one: MsgOpenGameIntent simulates as "no match,
// write an offer" and delivers as "match, escrow both stakes, draw a relay,
// write a session".
//
// Sized from that jump, measured at both ends: 81,789 gas simulated on the
// cheap path (session 119, live) against 291,459 for the match path in the
// worst state the chain can present it (keeper/gas_bounds_test.go) — 3.56x.
// 4.0 clears it, and the published bound clears anything it does not.
export const DEFAULT_GAS_ADJUSTMENT = 4.0;

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

// Round the measured gas up by the adjustment, never above `bound`.
//
// `bound` is the chain's published bound for the message (ADR-008 §2.1) and it
// is the CEILING, not the floor. It used to be the floor — `Math.max` — which
// meant every message reserved the bound, and the bound is padded for a cost
// term nothing caps yet: on session 119 an intent that used 81,789 gas
// reserved, and PAID for, 1,000,000. The fee is the declared amount, deducted
// in full by the ante handler, refunded never. Pass 0 to leave the estimate
// unclamped.
export function adjustGas(
  gasUsed: number,
  adjustment: number = DEFAULT_GAS_ADJUSTMENT,
  bound = 0
): string {
  const adjusted = Math.ceil(gasUsed * adjustment);
  if (bound <= 0) {
    return String(adjusted);
  }
  return String(Math.min(adjusted, Math.ceil(bound)));
}

// A dispute evidence tx carries the full protobuf transcript. Keep this in
// sync with webapp/packages/poker-session/src/fees.ts and the C++ gas bounds.
export function evidenceGasBound(payloadBytes: number): string {
  return String(submitSessionEvidenceBound(payloadBytes));
}

// What to reserve for an adjudication whose transcript size is unknown: the
// largest one the chain will store. Guessing low does not slow the transaction
// down — it fails it after CheckTx already reported success, and the escrow
// stays locked (ADR-008 §2.1).
export function adjudicateGasBound(evidencePayloadBytes?: number): string {
  return String(
    adjudicateSessionBound(evidencePayloadBytes ?? MAX_STORED_EVIDENCE_BYTES)
  );
}

// The ceiling for game messages whose cost does not scale with any client input.
export const GAS_BOUND_GAME_MESSAGE = String(
  Math.max(
    GAS_OPEN_GAME_INTENT,
    GAS_CANCEL_GAME_INTENT,
    GAS_SUBMIT_SESSION_RESULT,
    GAS_SUBMIT_SESSION_SECRET,
    GAS_CLAIM_SESSION_TIMEOUT
  )
);

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
