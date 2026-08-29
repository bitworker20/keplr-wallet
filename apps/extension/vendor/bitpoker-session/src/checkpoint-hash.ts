// The ADR-010 checkpoint transcript hash: the value MsgSubmitSessionResult
// carries, and the one the chain's sameResult() compares when it decides
// whether two independently submitted results settle cooperatively or send the
// session to a dispute.
//
// Four different producers have to agree on it byte for byte:
//
//   - the native settlement sink (chain_settlement_sink.cpp),
//   - the wasm gamecore both browser clients call (gamecore_embind.cpp),
//   - the native retreat path, rebuilding it from the settle it persisted
//     (session_recovery.cpp),
//   - anything on this side that later does the same from transcript-vault.ts.
//
// Disagreeing is silent: both peers finish the hand happily, both file a
// result, the chain sees two different transcript hashes and refuses to settle
// cooperatively. See checkpoint-hash.spec.ts for the golden vector shared with
// the C++ tests.

/** Lowercase hex, the encoding BytesToHexString produces on the C++ side. */
export function toCheckpointHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * The exact string the hash is taken over. Kept separate from the digest so a
 * test can pin the preimage as well — a wrong separator hashes just as happily
 * as a right one.
 */
export function checkpointTranscriptPreimage(
  chainSessionId: string,
  handId: number,
  packedSettle: Uint8Array
): string {
  if (!/^[0-9]+$/.test(chainSessionId) || chainSessionId === "0") {
    throw new Error("checkpoint transcript requires a non-zero session id");
  }
  if (!Number.isInteger(handId) || handId < 0) {
    throw new Error("checkpoint transcript requires a whole hand id");
  }
  if (packedSettle.length === 0) {
    throw new Error("checkpoint transcript requires packed settle bytes");
  }
  return `CHECKPOINT|${chainSessionId}|${handId}|${toCheckpointHex(
    packedSettle
  )}`;
}

/**
 * SHA-256 hex of the preimage above. `chainSessionId` stays a decimal string:
 * session ids are uint64 and JS numbers lose precision past 2^53.
 */
export async function makeCheckpointTranscriptHash(
  chainSessionId: string,
  handId: number,
  packedSettle: Uint8Array
): Promise<string> {
  const preimage = checkpointTranscriptPreimage(
    chainSessionId,
    handId,
    packedSettle
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(preimage)
  );
  return toCheckpointHex(new Uint8Array(digest));
}
