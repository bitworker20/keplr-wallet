import { Router } from "@keplr-wallet/router";
import { BitpokerService } from "./service";
import {
  BitpokerGetKeyMsg,
  BitpokerOpenIntentMsg,
  BitpokerSignPayloadMsg,
  BitpokerSubmitResultMsg,
} from "./messages";
import { ROUTE } from "./constants";
import { getHandler } from "./handler";

export function init(router: Router, service: BitpokerService): void {
  router.registerMessage(BitpokerSignPayloadMsg);
  router.registerMessage(BitpokerGetKeyMsg);
  router.registerMessage(BitpokerOpenIntentMsg);
  router.registerMessage(BitpokerSubmitResultMsg);

  router.addHandler(ROUTE, getHandler(service));
}
