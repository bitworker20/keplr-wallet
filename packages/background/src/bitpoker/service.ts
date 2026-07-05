import { Env } from "@keplr-wallet/router";
import { Buffer } from "buffer/";
import { KeyRingService } from "../keyring";

// The bitpoker protocol authenticates relay connections and on-chain dispute
// evidence with a raw secp256k1 signature over sha256(payload) — the payload is
// a domain-prefixed text, NOT a Cosmos SignDoc (see bitpoker's
// game::signSecp256k1Sha256Payload). Raw signing is dangerous, so this service
// is fenced twice:
//  - the message has no approveExternal(), so webpages/content scripts can
//    never reach it, and the handler additionally rejects non-internal envs;
//  - the payload must start with one of these domain-separation prefixes, so
//    the signer cannot be repurposed to sign transactions, ADR-36 docs, or any
//    other byte string.
const ALLOWED_PAYLOAD_PREFIXES = [
  // Relay ClientHello auth ("cosmos-signature-v1"), relay_protocol.cpp
  "bitpoker-relay-client-hello-v1\n",
  // Relay reward receipt (ADR-005 / M5.3)
  "bitpoker-relay-receipt-v1\n",
  // submit-session-evidence authentication (ADR-003)
  "bitpoker-session-evidence-v1\n",
];

export class BitpokerService {
  constructor(protected readonly keyRingService: KeyRingService) {}

  static isAllowedPayload(payload: string): boolean {
    return ALLOWED_PAYLOAD_PREFIXES.some((prefix) =>
      payload.startsWith(prefix)
    );
  }

  // Returns compressed_pubkey(33) || r(32) || s(32) as hex — the 97-byte layout
  // bitpoker's verifySecp256k1Sha256Payload and the relay's cosmos-signature-v1
  // verifier expect — signed with the selected account's key for chainId.
  async signPayload(
    env: Env,
    chainId: string,
    payload: string
  ): Promise<{ signature: string }> {
    if (!env.isInternalMsg) {
      throw new Error("bitpoker sign is only allowed for internal messages");
    }
    if (!BitpokerService.isAllowedPayload(payload)) {
      throw new Error(
        "bitpoker sign payload must start with an allowed bitpoker domain prefix"
      );
    }

    const pubKey = await this.keyRingService.getPubKeySelected(chainId);
    const signature = await this.keyRingService.signSelected(
      chainId,
      Buffer.from(payload, "utf8"),
      "sha256"
    );

    return {
      signature: Buffer.concat([
        Buffer.from(pubKey.toBytes()),
        Buffer.from(signature.r),
        Buffer.from(signature.s),
      ]).toString("hex"),
    };
  }
}
