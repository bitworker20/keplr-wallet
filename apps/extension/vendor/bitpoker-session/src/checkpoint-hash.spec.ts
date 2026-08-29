import {
  checkpointTranscriptPreimage,
  makeCheckpointTranscriptHash,
  toCheckpointHex,
} from "./checkpoint-hash";

describe("checkpoint transcript hash", () => {
  // CROSS-LANGUAGE GOLDEN VECTOR (ADR-010 §4.3). The same triple and the same
  // digest are pinned in C++ by
  // ChainSettlementSinkTest.CheckpointTranscriptHashGoldenVector. If these two
  // ever disagree, a browser peer and a native peer finish a hand, both file a
  // result, and the chain refuses to settle it cooperatively — with no error
  // anywhere until the session lands in a dispute.
  const GOLDEN_SESSION_ID = "9";
  const GOLDEN_HAND_ID = 3;
  const GOLDEN_SETTLE = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
  const GOLDEN_DIGEST =
    "865471659a6294f5594c88ffbe225a687d6ad5283c8d5099b2f1baf3298b8a73";

  it("matches the C++ golden vector", async () => {
    await expect(
      makeCheckpointTranscriptHash(
        GOLDEN_SESSION_ID,
        GOLDEN_HAND_ID,
        GOLDEN_SETTLE
      )
    ).resolves.toBe(GOLDEN_DIGEST);
  });

  it("hashes the documented preimage", () => {
    // Pinned separately from the digest: a wrong separator or a wrong hex case
    // produces a perfectly valid-looking hash of the wrong string.
    expect(
      checkpointTranscriptPreimage(
        GOLDEN_SESSION_ID,
        GOLDEN_HAND_ID,
        GOLDEN_SETTLE
      )
    ).toBe("CHECKPOINT|9|3|0102030405");
  });

  it("encodes bytes as lowercase, zero-padded hex", () => {
    expect(toCheckpointHex(new Uint8Array([0x00, 0x0f, 0xa0, 0xff]))).toBe(
      "000fa0ff"
    );
  });

  it("keeps session ids as decimal strings past 2^53", () => {
    const huge = "18446744073709551615";
    expect(checkpointTranscriptPreimage(huge, 0, new Uint8Array([0xab]))).toBe(
      `CHECKPOINT|${huge}|0|ab`
    );
  });

  it("refuses inputs that cannot identify a checkpoint", () => {
    expect(() =>
      checkpointTranscriptPreimage("0", 1, new Uint8Array([0x01]))
    ).toThrow(/session id/);
    expect(() =>
      checkpointTranscriptPreimage("7", 1, new Uint8Array())
    ).toThrow(/packed settle/);
  });
});
