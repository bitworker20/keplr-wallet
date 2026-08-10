// ADR-007 §3.1 browser side of the relay endpoint answer: the per-run
// secp256k1 transport keypair committed in the game intent, and the ECIES
// open of the encrypted endpoint blob the assigned relay posts on chain.
//
// Suite (pinned by Go's TestEndpointBlobGoldenVector and the C++
// relay_endpoint_crypto_test — all three implementations must agree byte for
// byte):
//   blob = ephemeral compressed pubkey (33B) || AES-GCM nonce (12B) || ct+tag
//   key  = HKDF-SHA256(secret = compressed ECDH point, salt = ∅,
//                      info = "adr007-ecies-v1")[0:32]
//   AAD  = "adr007-v1" || session_id (8B big-endian) || relay_id (UTF-8)
//
// ECDH runs on @noble/curves (getSharedSecret with compressed output IS the
// compressed shared point); HKDF on @noble/hashes; AES-256-GCM on WebCrypto.

import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

const KDF_INFO = "adr007-ecies-v1";
const AAD_PREFIX = "adr007-v1";
const COMPRESSED_PUBKEY_LEN = 33;
const GCM_NONCE_LEN = 12;
const GCM_TAG_LEN = 16;

export interface TransportKeypair {
  secretHex: string;
  pubkeyHex: string;
}

export interface RelayEndpointGrant {
  endpoint: string;
  connectToken: Uint8Array;
  expiresAtHeight: string;
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const hexToBytes = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string has odd length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export function generateTransportKeypair(): TransportKeypair {
  const secret = secp256k1.utils.randomPrivateKey();
  const pubkey = secp256k1.getPublicKey(secret, true);
  return { secretHex: bytesToHex(secret), pubkeyHex: bytesToHex(pubkey) };
}

function buildAAD(sessionId: string, relayId: string): Uint8Array {
  const prefix = new TextEncoder().encode(AAD_PREFIX);
  const relay = new TextEncoder().encode(relayId);
  const aad = new Uint8Array(prefix.length + 8 + relay.length);
  aad.set(prefix, 0);
  // uint64 big-endian; BigInt literals are unavailable at the current TS
  // target, so this uses the BigInt() constructor forms only.
  let id = BigInt(sessionId);
  const byteMask = BigInt(0xff);
  const eight = BigInt(8);
  for (let i = 7; i >= 0; i--) {
    aad[prefix.length + i] = Number(id & byteMask);
    id >>= eight;
  }
  aad.set(relay, prefix.length + 8);
  return aad;
}

// Decrypts a blob to its raw payload bytes. Throws on any authentication
// failure (wrong key, wrong session/relay binding, tampered blob).
export async function openEndpointBlobRaw(
  transportSecretHex: string,
  sessionId: string,
  relayId: string,
  blob: Uint8Array
): Promise<Uint8Array> {
  if (blob.length < COMPRESSED_PUBKEY_LEN + GCM_NONCE_LEN + GCM_TAG_LEN) {
    throw new Error("endpoint blob is too short");
  }
  const ephemeral = blob.slice(0, COMPRESSED_PUBKEY_LEN);
  const nonce = blob.slice(
    COMPRESSED_PUBKEY_LEN,
    COMPRESSED_PUBKEY_LEN + GCM_NONCE_LEN
  );
  const ciphertext = blob.slice(COMPRESSED_PUBKEY_LEN + GCM_NONCE_LEN);

  // Compressed shared point — the exact secret the Go/C++ sides derive.
  const shared = secp256k1.getSharedSecret(
    hexToBytes(transportSecretHex),
    ephemeral,
    true
  );
  const key = hkdf(sha256, shared, undefined, KDF_INFO, 32);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: buildAAD(sessionId, relayId),
        tagLength: GCM_TAG_LEN * 8,
      },
      cryptoKey,
      ciphertext
    );
    return new Uint8Array(plain);
  } catch {
    throw new Error(
      "endpoint blob authentication failed (wrong key, session, relay, or tampered blob)"
    );
  }
}

// Minimal proto reader for pokerchain.pokerchain.v1.RelayEndpointPayload
// { string endpoint = 1; bytes connect_token = 2; int64 expires_at_height = 3; }
export function parseRelayEndpointPayload(
  payload: Uint8Array
): RelayEndpointGrant {
  let pos = 0;
  const varint = (): bigint => {
    let value = BigInt(0);
    let shift = BigInt(0);
    const seven = BigInt(7);
    for (;;) {
      if (pos >= payload.length) {
        throw new Error("relay endpoint payload is truncated");
      }
      const byte = payload[pos++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return value;
      }
      shift += seven;
    }
  };
  const bytes = (): Uint8Array => {
    const len = Number(varint());
    if (pos + len > payload.length) {
      throw new Error("relay endpoint payload is truncated");
    }
    const out = payload.slice(pos, pos + len);
    pos += len;
    return out;
  };

  let endpoint = "";
  let connectToken = new Uint8Array(0);
  let expiresAtHeight = "0";
  while (pos < payload.length) {
    const tag = Number(varint());
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      endpoint = new TextDecoder().decode(bytes());
    } else if (field === 2 && wire === 2) {
      connectToken = bytes();
    } else if (field === 3 && wire === 0) {
      expiresAtHeight = varint().toString();
    } else if (wire === 2) {
      bytes(); // skip unknown length-delimited
    } else if (wire === 0) {
      varint(); // skip unknown varint
    } else {
      throw new Error(
        `relay endpoint payload has unsupported wire type ${wire}`
      );
    }
  }
  if (!endpoint) {
    throw new Error("relay endpoint payload has no endpoint");
  }
  return { endpoint, connectToken, expiresAtHeight };
}

export async function openEndpointBlob(
  transportSecretHex: string,
  sessionId: string,
  relayId: string,
  blob: Uint8Array
): Promise<RelayEndpointGrant> {
  return parseRelayEndpointPayload(
    await openEndpointBlobRaw(transportSecretHex, sessionId, relayId, blob)
  );
}

// "xpoker.tok.<base64url-no-pad(token)>" — the Sec-WebSocket-Protocol entry a
// browser WebSocket can carry the connect token in. Offered together with the
// base subprotocol the relay echoes back.
export const RELAY_SUBPROTOCOL_V1 = "xpoker.relay.v1";

export function connectTokenSubprotocol(token: Uint8Array): string {
  let binary = "";
  for (const byte of token) {
    binary += String.fromCharCode(byte);
  }
  const b64url = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `xpoker.tok.${b64url}`;
}

// Standard base64 decode (LCD JSON renders proto bytes fields as base64).
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
