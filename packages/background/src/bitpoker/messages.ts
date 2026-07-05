import { Message } from "@keplr-wallet/router";
import { ROUTE } from "./constants";
import { BitpokerService } from "./service";

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
