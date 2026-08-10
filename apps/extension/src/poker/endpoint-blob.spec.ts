import {
  base64ToBytes,
  connectTokenSubprotocol,
  generateTransportKeypair,
  openEndpointBlobRaw,
  parseRelayEndpointPayload,
} from "./endpoint-blob";

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

// The exact vector pinned by Go's TestEndpointBlobGoldenVector
// (x/pokerchain/relay/endpoint_blob_test.go) and the C++
// relay_endpoint_crypto_test. If any side changes, the wire format diverged.
const GOLDEN_SECRET_HEX =
  "1111111111111111111111111111111111111111111111111111111111111111";
const GOLDEN_SESSION_ID = "42";
const GOLDEN_RELAY_ID = "relay-golden";
const GOLDEN_PAYLOAD = "adr007 golden payload";
const GOLDEN_BLOB_HEX =
  "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27" +
  "333333333333333333333333" +
  "fe40681cbe3aa881681872d8654f89676a135f6c4e48b4b2bb68c63be332fd5788ee533df9";

describe("endpoint-blob", () => {
  it("opens the Go golden vector", async () => {
    const payload = await openEndpointBlobRaw(
      GOLDEN_SECRET_HEX,
      GOLDEN_SESSION_ID,
      GOLDEN_RELAY_ID,
      hexToBytes(GOLDEN_BLOB_HEX)
    );
    expect(new TextDecoder().decode(payload)).toBe(GOLDEN_PAYLOAD);
  });

  it("rejects the wrong session, relay, key, and tampering", async () => {
    const blob = hexToBytes(GOLDEN_BLOB_HEX);
    await expect(
      openEndpointBlobRaw(GOLDEN_SECRET_HEX, "43", GOLDEN_RELAY_ID, blob)
    ).rejects.toThrow();
    await expect(
      openEndpointBlobRaw(GOLDEN_SECRET_HEX, GOLDEN_SESSION_ID, "relay-x", blob)
    ).rejects.toThrow();
    await expect(
      openEndpointBlobRaw(
        "2222222222222222222222222222222222222222222222222222222222222222",
        GOLDEN_SESSION_ID,
        GOLDEN_RELAY_ID,
        blob
      )
    ).rejects.toThrow();
    const tampered = blob.slice();
    tampered[tampered.length - 1] ^= 0x01;
    await expect(
      openEndpointBlobRaw(
        GOLDEN_SECRET_HEX,
        GOLDEN_SESSION_ID,
        GOLDEN_RELAY_ID,
        tampered
      )
    ).rejects.toThrow();
  });

  it("parses a RelayEndpointPayload proto", () => {
    // Hand-encoded: endpoint="wss://a:1", token=0xAB 0xCD, expires=4242.
    const endpoint = new TextEncoder().encode("wss://a:1");
    const payload = new Uint8Array([
      0x0a,
      endpoint.length,
      ...endpoint,
      0x12,
      0x02,
      0xab,
      0xcd,
      0x18,
      0x92,
      0x21,
    ]);
    const grant = parseRelayEndpointPayload(payload);
    expect(grant.endpoint).toBe("wss://a:1");
    expect(Array.from(grant.connectToken)).toEqual([0xab, 0xcd]);
    expect(grant.expiresAtHeight).toBe("4242");
    expect(() => parseRelayEndpointPayload(new Uint8Array(0))).toThrow();
  });

  it("generates well-formed transport keypairs", () => {
    const keypair = generateTransportKeypair();
    expect(keypair.secretHex).toHaveLength(64);
    expect(keypair.pubkeyHex).toHaveLength(66);
    expect(["02", "03"]).toContain(keypair.pubkeyHex.slice(0, 2));
    expect(generateTransportKeypair().secretHex).not.toBe(keypair.secretHex);
  });

  it("builds the subprotocol entry the relay parses", () => {
    // Matches Go base64.RawURLEncoding (connect_token_test.go).
    const token = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
    expect(connectTokenSubprotocol(token)).toBe(
      "xpoker.tok.MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"
    );
  });

  it("decodes LCD base64 bytes fields", () => {
    expect(Array.from(base64ToBytes("AQIDBA=="))).toEqual([1, 2, 3, 4]);
  });
});
