import { Router } from "@keplr-wallet/router";
import { BitpokerService } from "./service";
import {
  BitpokerGetKeyMsg,
  BitpokerCancelIntentMsg,
  BitpokerOpenIntentMsg,
  BitpokerSignPayloadMsg,
  BitpokerSubmitEvidenceMsg,
  BitpokerSubmitResultMsg,
  BitpokerSubmitSecretMsg,
} from "./messages";
import { ROUTE } from "./constants";
import { getHandler } from "./handler";

export function init(router: Router, service: BitpokerService): void {
  router.registerMessage(BitpokerSignPayloadMsg);
  router.registerMessage(BitpokerGetKeyMsg);
  router.registerMessage(BitpokerOpenIntentMsg);
  router.registerMessage(BitpokerCancelIntentMsg);
  router.registerMessage(BitpokerSubmitResultMsg);
  router.registerMessage(BitpokerSubmitEvidenceMsg);
  router.registerMessage(BitpokerSubmitSecretMsg);

  router.addHandler(ROUTE, getHandler(service));
}
