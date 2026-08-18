import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import {
  buildReceiptSigningPayload,
  encodeRelayReceipt,
  packRelayFrame,
  RelayType,
  unpackRelayFrame,
} from "./relay-client";

// The other half of the cross-language golden vector in
// pokerchain/x/pokerchain/relay/protocol_js_interop_test.go
// (TestJavaScriptSignedRelayReceiptIsAcceptedByGoVerifier). Both sides pin the
// same bytes, so a change to the receipt payload or its proto encoding fails
// here and there rather than quietly costing relays their fee: the receipt text
// moved to v2 in the C++/Go signers while the browser wallet bridges kept a v1
// allowlist, and with nothing comparing the two, browser seats stopped being
// able to acknowledge their relay at all.
const FIXTURE_PRIV_KEY = Uint8Array.from(
  Buffer.from(
    "21B9CED055A26FCACFCA81C43BC63164EC45512C6EA0294E6DF4811D060C30E4",
    "hex"
  )
);
const CHAIN_ID = "pokerchain-dev";
const SESSION_ID = 7777;
const RELAY_ID = "relay-local";
const GOLDEN_PAYLOAD_HEX =
  "0a61032fb5c4c9f2925792214e0b69b5ed63cce3eb34a56856c8a4a54f8c41e7f7d5" +
  "22447cafaf35c8fdc488daee920a1fedbad54007a6a65e9701553888ac45a1550073" +
  "753fd3299807d965a686a26f0d3403e41898c2f9e7ce3a09585f573a67a03810e13c";

function signReceipt(): Uint8Array {
  const text = buildReceiptSigningPayload(CHAIN_ID, SESSION_ID, RELAY_ID);
  const signature = secp256k1.sign(
    sha256(new TextEncoder().encode(text)),
    FIXTURE_PRIV_KEY
  );
  return new Uint8Array([
    ...secp256k1.getPublicKey(FIXTURE_PRIV_KEY, true),
    ...signature.toCompactRawBytes(),
  ]);
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe("relay reward receipt", () => {
  it("builds the canonical v2 signing payload the relay and chain verify", () => {
    expect(buildReceiptSigningPayload(CHAIN_ID, SESSION_ID, RELAY_ID)).toBe(
      "bitpoker-relay-receipt-v2\npokerchain-dev\n7777\nrelay-local"
    );
  });

  it("carries a bitpoker- domain prefix so the wallet bridges will sign it", () => {
    expect(buildReceiptSigningPayload(CHAIN_ID, SESSION_ID, RELAY_ID)).toMatch(
      /^bitpoker-/
    );
  });

  it("encodes the RelayReceipt proto byte-for-byte as the Go verifier expects", () => {
    expect(toHex(encodeRelayReceipt(signReceipt(), SESSION_ID))).toBe(
      GOLDEN_PAYLOAD_HEX
    );
  });

  it("rides a Receipt frame the relay consumes instead of forwarding", () => {
    const payload = encodeRelayReceipt(signReceipt(), SESSION_ID);
    const frame = unpackRelayFrame(
      packRelayFrame(RelayType.Receipt, 1, payload)
    );
    expect(frame?.type).toBe(RelayType.Receipt);
    expect(toHex(frame!.payload)).toBe(GOLDEN_PAYLOAD_HEX);
  });
});
