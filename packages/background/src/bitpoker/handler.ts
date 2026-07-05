import {
  Env,
  Handler,
  InternalHandler,
  KeplrError,
  Message,
} from "@keplr-wallet/router";
import { BitpokerService } from "./service";
import { BitpokerSignPayloadMsg } from "./messages";

export const getHandler: (service: BitpokerService) => Handler = (
  service: BitpokerService
) => {
  return (env: Env, msg: Message<unknown>) => {
    switch (msg.constructor) {
      case BitpokerSignPayloadMsg:
        return handleBitpokerSignPayloadMsg(service)(
          env,
          msg as BitpokerSignPayloadMsg
        );
      default:
        throw new KeplrError("bitpoker", 100, "Unknown msg type");
    }
  };
};

const handleBitpokerSignPayloadMsg: (
  service: BitpokerService
) => InternalHandler<BitpokerSignPayloadMsg> = (service) => {
  return (env, msg) => {
    return service.signPayload(env, msg.chainId, msg.payload);
  };
};
