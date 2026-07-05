import { Router } from "@keplr-wallet/router";
import { BitpokerService } from "./service";
import { BitpokerSignPayloadMsg } from "./messages";
import { ROUTE } from "./constants";
import { getHandler } from "./handler";

export function init(router: Router, service: BitpokerService): void {
  router.registerMessage(BitpokerSignPayloadMsg);

  router.addHandler(ROUTE, getHandler(service));
}
