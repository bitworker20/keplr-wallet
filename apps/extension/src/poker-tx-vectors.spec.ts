// Drift guard between the two pokerchain transaction encoders.
//
// The extension signs in the background (packages/background/src/bitpoker) and
// the standalone web client signs in the page (webapp/src/wallet/chain-tx.ts).
// They cannot share the encoder file: the background package compiles with
// `rootDir: "src"`, so it cannot include sources from outside itself. Instead
// both are pinned to one fixture — the golden vectors below, which ship with
// the shared session package and are asserted by the web client's spec too.
//
// If a pokerchain proto changes a field number or type, update the fixture and
// BOTH encoders; whichever one lags will fail here or there.
import vectors from "@bitpoker/poker-session/fixtures/chain-tx-vectors.json";
import {
  encodeMsgOpenGameIntent,
  encodeMsgSubmitSessionEvidence,
  encodeMsgSubmitSessionResult,
  encodeMsgSubmitSessionSecret,
} from "../../../packages/background/src/bitpoker/proto-writer";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fromHex = (text: string): Uint8Array =>
  Uint8Array.from(Buffer.from(text, "hex"));

describe("background pokerchain encoder matches the shared golden vectors", () => {
  it("encodes MsgOpenGameIntent", () => {
    expect(hex(encodeMsgOpenGameIntent(vectors.openGameIntent.input))).toBe(
      vectors.openGameIntent.hex
    );
  });

  it("omits empty opponent and transport pubkey", () => {
    expect(
      hex(encodeMsgOpenGameIntent(vectors.openGameIntentOpenMatch.input))
    ).toBe(vectors.openGameIntentOpenMatch.hex);
  });

  it("encodes MsgSubmitSessionResult", () => {
    expect(
      hex(encodeMsgSubmitSessionResult(vectors.submitSessionResult.input))
    ).toBe(vectors.submitSessionResult.hex);
  });

  it("encodes a split pot and a session id beyond 2^53", () => {
    expect(
      hex(encodeMsgSubmitSessionResult(vectors.submitSessionResultSplit.input))
    ).toBe(vectors.submitSessionResultSplit.hex);
  });

  it("encodes MsgSubmitSessionEvidence", () => {
    const v = vectors.submitSessionEvidence;
    expect(
      hex(
        encodeMsgSubmitSessionEvidence({
          ...v.input,
          evidencePayload: fromHex(v.input.evidencePayloadHex),
        })
      )
    ).toBe(v.hex);
  });

  it("encodes MsgSubmitSessionSecret", () => {
    const v = vectors.submitSessionSecret;
    expect(
      hex(
        encodeMsgSubmitSessionSecret({
          ...v.input,
          sessionSecretKey: fromHex(v.input.sessionSecretKeyHex),
          sessionPubkey: fromHex(v.input.sessionPubkeyHex),
        })
      )
    ).toBe(v.hex);
  });
});
