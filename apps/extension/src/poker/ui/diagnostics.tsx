import React, { useState } from "react";
import { PokerGameController } from "@bitpoker/poker-session/controller";
import { PokerWalletBridge } from "@bitpoker/poker-session/wallet-bridge";
import { styles } from "./styles";

// Dev/e2e diagnostics: gamecore self-test in the worker and a raw sign
// round-trip through the wallet bridge. Collapsed by default; the e2e driver
// keys off data-testid="selftest".
export const Diagnostics: React.FC<{
  controller: PokerGameController;
  wallet: PokerWalletBridge;
  chainId: string;
  children?: React.ReactNode;
}> = ({ controller, wallet, chainId, children }) => {
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
              .runSelfTest()
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
            wallet
              .signPayload(
                chainId,
                "bitpoker-relay-client-hello-v1\npoker-page-test"
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
