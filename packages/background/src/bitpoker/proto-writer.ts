// Minimal proto3 writer for the pokerchain tx messages. The pokerchain protos
// are not part of @keplr-wallet/proto-types (fork-local module), and their tx
// messages are flat scalar records — a tiny hand encoder keeps the fork diff
// contained. Field numbers must match pokerchain/proto/pokerchain/pokerchain/v1.

export class ProtoWriter {
  protected readonly out: number[] = [];

  protected tag(field: number, wireType: number): void {
    this.varintValue((field << 3) | wireType);
  }

  protected varintValue(value: number | bigint): void {
    const zero = BigInt(0);
    const low7 = BigInt(0x7f);
    const shift = BigInt(7);
    let v = BigInt(value);
    if (v < zero) {
      throw new Error("negative varint is not supported");
    }
    for (;;) {
      const byte = Number(v & low7);
      v >>= shift;
      if (v === zero) {
        this.out.push(byte);
        return;
      }
      this.out.push(byte | 0x80);
    }
  }

  string(field: number, value?: string): this {
    if (!value) {
      return this;
    }
    const bytes = new TextEncoder().encode(value);
    this.tag(field, 2);
    this.varintValue(bytes.length);
    for (const b of bytes) {
      this.out.push(b);
    }
    return this;
  }

  bytes(field: number, value?: Uint8Array): this {
    if (!value || value.length === 0) {
      return this;
    }
    this.tag(field, 2);
    this.varintValue(value.length);
    for (const b of value) {
      this.out.push(b);
    }
    return this;
  }

  uint64(field: number, value?: number | string | bigint): this {
    if (value == null || value === 0 || value === "0") {
      return this;
    }
    this.tag(field, 0);
    this.varintValue(typeof value === "string" ? BigInt(value) : value);
    return this;
  }

  bool(field: number, value?: boolean): this {
    if (!value) {
      return this;
    }
    this.tag(field, 0);
    this.out.push(1);
    return this;
  }

  finish(): Uint8Array {
    return new Uint8Array(this.out);
  }
}

export const POKERCHAIN_GAME_TYPE_TH = 3;

export function encodeMsgOpenGameIntent(msg: {
  creator: string;
  gameType: number;
  minStake: string;
  maxStake: string;
  opponent: string;
  playerSessionPubkey: string;
}): Uint8Array {
  return new ProtoWriter()
    .string(1, msg.creator)
    .uint64(2, msg.gameType)
    .uint64(3, msg.minStake)
    .uint64(4, msg.maxStake)
    .string(5, msg.opponent)
    .string(6, msg.playerSessionPubkey)
    .finish();
}

export function encodeMsgSubmitSessionResult(msg: {
  creator: string;
  sessionId: string;
  winner: string;
  loser: string;
  finalStake: string;
  transcriptHash: string;
  resultSignature: string;
  splitPot: boolean;
  playerAAmount: string;
  playerBAmount: string;
}): Uint8Array {
  return new ProtoWriter()
    .string(1, msg.creator)
    .uint64(2, msg.sessionId)
    .string(3, msg.winner)
    .string(4, msg.loser)
    .uint64(5, msg.finalStake)
    .string(6, msg.transcriptHash)
    .string(7, msg.resultSignature)
    .bool(8, msg.splitPot)
    .uint64(9, msg.playerAAmount)
    .uint64(10, msg.playerBAmount)
    .finish();
}

export function encodeMsgSubmitSessionEvidence(msg: {
  creator: string;
  sessionId: string;
  evidenceHash: string;
  evidencePayload: Uint8Array;
  evidenceSignature: string;
  reason: string;
}): Uint8Array {
  return new ProtoWriter()
    .string(1, msg.creator)
    .uint64(2, msg.sessionId)
    .string(3, msg.evidenceHash)
    .bytes(4, msg.evidencePayload)
    .string(5, msg.evidenceSignature)
    .string(6, msg.reason)
    .finish();
}

export function encodeMsgSubmitSessionSecret(msg: {
  creator: string;
  sessionId: string;
  sessionSecretKey: Uint8Array;
  sessionPubkey: Uint8Array;
}): Uint8Array {
  return new ProtoWriter()
    .string(1, msg.creator)
    .uint64(2, msg.sessionId)
    .bytes(3, msg.sessionSecretKey)
    .bytes(4, msg.sessionPubkey)
    .finish();
}

export const MSG_OPEN_GAME_INTENT_TYPE_URL =
  "/pokerchain.pokerchain.v1.MsgOpenGameIntent";
export const MSG_SUBMIT_SESSION_RESULT_TYPE_URL =
  "/pokerchain.pokerchain.v1.MsgSubmitSessionResult";
export const MSG_SUBMIT_SESSION_EVIDENCE_TYPE_URL =
  "/pokerchain.pokerchain.v1.MsgSubmitSessionEvidence";
export const MSG_SUBMIT_SESSION_SECRET_TYPE_URL =
  "/pokerchain.pokerchain.v1.MsgSubmitSessionSecret";
