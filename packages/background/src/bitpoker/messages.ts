import { Message } from "@keplr-wallet/router";
import { ROUTE } from "./constants";
import { BitpokerService } from "./service";

export class BitpokerGetKeyMsg extends Message<{
  bech32Address: string;
  pubkeyHex: string;
}> {
  public static type() {
    return "bitpoker-get-key";
  }

  constructor(public readonly chainId: string) {
    super();
  }

  validateBasic(): void {
    if (!this.chainId) {
      throw new Error("chain id is empty");
    }
  }

  route(): string {
    return ROUTE;
  }

  type(): string {
    return BitpokerGetKeyMsg.type();
  }
}

export class BitpokerOpenIntentMsg extends Message<{
  txHash: string;
  code: number;
  rawLog: string;
}> {
  public static type() {
    return "bitpoker-open-intent";
  }

  constructor(
    public readonly chainId: string,
    // pokerchain GameType enum: 2=ZJH, 3=TH.
    public readonly gameType: number,
    public readonly minStake: string,
    public readonly maxStake: string,
    public readonly opponent: string,
    public readonly playerSessionPubkey: string
  ) {
    super();
  }

  validateBasic(): void {
    if (!this.chainId) {
      throw new Error("chain id is empty");
    }
    if (this.gameType !== 2 && this.gameType !== 3) {
      throw new Error("game type must be 2 (ZJH) or 3 (TH)");
    }
    if (!/^[0-9]+$/.test(this.minStake) || !/^[0-9]+$/.test(this.maxStake)) {
      throw new Error("stakes must be decimal integers");
    }
    if (!this.playerSessionPubkey) {
      throw new Error("player session pubkey is empty");
    }
  }

  route(): string {
    return ROUTE;
  }

  type(): string {
    return BitpokerOpenIntentMsg.type();
  }
}

export class BitpokerSubmitResultMsg extends Message<{
  txHash: string;
  code: number;
  rawLog: string;
}> {
  public static type() {
    return "bitpoker-submit-result";
  }

  constructor(
    public readonly chainId: string,
    public readonly sessionId: string,
    public readonly winner: string,
    public readonly loser: string,
    public readonly finalStake: string,
    public readonly transcriptHash: string,
    public readonly resultSignature: string,
    public readonly splitPot: boolean
  ) {
    super();
  }

  validateBasic(): void {
    if (!this.chainId) {
      throw new Error("chain id is empty");
    }
    if (!/^[0-9]+$/.test(this.sessionId)) {
      throw new Error("session id must be a decimal integer");
    }
    if (!/^[0-9a-f]{64}$/.test(this.transcriptHash)) {
      throw new Error("transcript hash must be sha256 hex");
    }
    if (!/^[0-9a-f]+$/.test(this.resultSignature)) {
      throw new Error("result signature must be hex");
    }
  }

  route(): string {
    return ROUTE;
  }

  type(): string {
    return BitpokerSubmitResultMsg.type();
  }
}

export class BitpokerSubmitEvidenceMsg extends Message<{
  txHash: string;
  code: number;
  rawLog: string;
}> {
  public static type() {
    return "bitpoker-submit-evidence";
  }

  constructor(
    public readonly chainId: string,
    public readonly sessionId: string,
    public readonly evidenceHash: string,
    public readonly evidencePayloadHex: string,
    public readonly evidenceSignature: string,
    public readonly reason: string
  ) {
    super();
  }

  validateBasic(): void {
    if (!this.chainId) {
      throw new Error("chain id is empty");
    }
    if (!/^[0-9]+$/.test(this.sessionId)) {
      throw new Error("session id must be a decimal integer");
    }
    if (!/^[0-9a-f]{64}$/.test(this.evidenceHash)) {
      throw new Error("evidence hash must be sha256 hex");
    }
    if (!/^[0-9a-f]+$/.test(this.evidencePayloadHex)) {
      throw new Error("evidence payload must be hex");
    }
  }

  route(): string {
    return ROUTE;
  }

  type(): string {
    return BitpokerSubmitEvidenceMsg.type();
  }
}

export class BitpokerSubmitSecretMsg extends Message<{
  txHash: string;
  code: number;
  rawLog: string;
}> {
  public static type() {
    return "bitpoker-submit-secret";
  }

  constructor(
    public readonly chainId: string,
    public readonly sessionId: string,
    public readonly sessionSecretKeyHex: string,
    public readonly sessionPubkeyHex: string
  ) {
    super();
  }

  validateBasic(): void {
    if (!this.chainId) {
      throw new Error("chain id is empty");
    }
    if (!/^[0-9]+$/.test(this.sessionId)) {
      throw new Error("session id must be a decimal integer");
    }
    // 32-byte scalar, 96-byte FiatShamir key.
    if (!/^[0-9a-f]{64}$/.test(this.sessionSecretKeyHex)) {
      throw new Error("session secret key must be 32-byte hex");
    }
    if (!/^[0-9a-f]{192}$/.test(this.sessionPubkeyHex)) {
      throw new Error("session pubkey must be 96-byte hex");
    }
  }

  route(): string {
    return ROUTE;
  }

  type(): string {
    return BitpokerSubmitSecretMsg.type();
  }
}

export class BitpokerSignPayloadMsg extends Message<{
  // hex of compressed_pubkey(33) || r(32) || s(32)
  signature: string;
}> {
  public static type() {
    return "bitpoker-sign-payload";
  }

  constructor(
    public readonly chainId: string,
    public readonly payload: string
  ) {
    super();
  }

  validateBasic(): void {
    if (!this.chainId) {
      throw new Error("chain id is empty");
    }
    if (!this.payload) {
      throw new Error("payload is empty");
    }
    if (!BitpokerService.isAllowedPayload(this.payload)) {
      throw new Error(
        "payload must start with an allowed bitpoker domain prefix"
      );
    }
  }

  // Deliberately NO approveExternal() override: raw payload signing must never
  // be reachable from webpages or content scripts, only from internal
  // extension pages.

  route(): string {
    return ROUTE;
  }

  type(): string {
    return BitpokerSignPayloadMsg.type();
  }
}
