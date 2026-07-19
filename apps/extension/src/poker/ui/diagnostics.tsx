import React, { useState } from "react";
import { InExtensionMessageRequester } from "@keplr-wallet/router-extension";
import { BACKGROUND_PORT } from "@keplr-wallet/router";
import { BitpokerSignPayloadMsg } from "@keplr-wallet/background";
import { PokerGameController } from "../controller";
import { styles } from "./styles";

// Dev/e2e diagnostics: gamecore self-test in the worker and a raw background
// sign round-trip. Collapsed by default; the e2e driver keys off
// data-testid="selftest".
export const Diagnostics: React.FC<{
  controller: PokerGameController;
  chainId: string;
  children?: React.ReactNode;
}> = ({ controller, chainId, children }) => {
  const [diag, setDiag] = useState<{ selfTest?: string; sign?: string }>({});

  return (
    <details style={styles.block}>
      <summary>Diagnostics</summary>
      {children}
      <div>
        <button
          onClick={() => {
            setDiag((d) => ({ ...d, selfTest: "running…" }));
            controller
              .getWorker()
              .selfTest()
              .then((r) => setDiag((d) => ({ ...d, selfTest: r })))
              .catch((e) =>
                setDiag((d) => ({ ...d, selfTest: `ERROR: ${e.message}` }))
              );
          }}
        >
          Run gamecore selfTest (in worker)
        </button>
        <div
          style={diag.selfTest?.startsWith("OK") ? styles.ok : styles.err}
          data-testid="selftest"
        >
          {diag.selfTest}
        </div>
      </div>
      <div>
        <button
          onClick={() => {
            setDiag((d) => ({ ...d, sign: "signing…" }));
            new InExtensionMessageRequester()
              .sendMessage(
                BACKGROUND_PORT,
                new BitpokerSignPayloadMsg(
                  chainId,
                  "bitpoker-relay-client-hello-v1\npoker-page-test"
                )
              )
              .then((res) =>
                setDiag((d) => ({
                  ...d,
                  sign: `OK ${res.signature.length / 2} bytes: ${
                    res.signature
                  }`,
                }))
              )
              .catch((e) =>
                setDiag((d) => ({ ...d, sign: `ERROR: ${e.message ?? e}` }))
              );
          }}
        >
          Test background raw sign
        </button>
        <div style={diag.sign?.startsWith("OK") ? styles.ok : styles.err}>
          {diag.sign}
        </div>
      </div>
    </details>
  );
};
