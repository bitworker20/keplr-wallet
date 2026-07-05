// BitPoker dev/integration page (chrome-extension://<id>/poker.html).
//
// This page proves the three integration prerequisites inside the real
// extension environment, before any game UI exists:
//  1. gamecore.wasm loads and runs under the MV3 CSP ('wasm-unsafe-eval') —
//     selfTest() exercises FourQ, SHA-256, SchnorrQ, a real mental-poker
//     shuffle + NIZK verify, protobuf-lite, and a full Texas Hold'em hand;
//  2. the background BitpokerSignPayloadMsg round-trip works (internal-only
//     raw secp256k1-over-sha256 signing with the selected account's key);
//  3. the pokerchain embedded chain is known to the wallet.
//
// The future game UI replaces this page; the loader + signing plumbing stay.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { InExtensionMessageRequester } from "@keplr-wallet/router-extension";
import { BACKGROUND_PORT } from "@keplr-wallet/router";
import { BitpokerSignPayloadMsg } from "@keplr-wallet/background";

const POKER_CHAIN_ID = "pokerchain-testnet-1";

// gamecore.js is an emscripten MODULARIZE bundle (EXPORT_NAME=createGamecore)
// vendored as a plain asset and loaded as a classic script, so webpack never
// parses the emscripten glue. Both files are copied to the build root.
function loadGamecore(): Promise<any> {
  return new Promise((resolve, reject) => {
    const existing = (window as any).createGamecore;
    if (existing) {
      resolve(existing());
      return;
    }
    const script = document.createElement("script");
    script.src = "gamecore.js";
    script.onload = () => {
      const factory = (window as any).createGamecore;
      if (!factory) {
        reject(new Error("gamecore.js loaded but createGamecore is missing"));
        return;
      }
      resolve(factory());
    };
    script.onerror = () => reject(new Error("failed to load gamecore.js"));
    document.head.appendChild(script);
  });
}

const styles = {
  page: {
    fontFamily: "monospace",
    maxWidth: "56rem",
    margin: "2rem auto",
    padding: "0 1rem",
    lineHeight: 1.6,
  },
  block: {
    border: "1px solid #888",
    borderRadius: "0.5rem",
    padding: "0.75rem 1rem",
    margin: "1rem 0",
    overflowWrap: "anywhere",
  },
  ok: { color: "#0a0" },
  err: { color: "#c00" },
} satisfies Record<string, React.CSSProperties>;

const PokerDevPage: React.FC = () => {
  const [selfTest, setSelfTest] = useState<string>("running…");
  const [realHand, setRealHand] = useState<string>("running…");
  const [signResult, setSignResult] = useState<string>("");

  useEffect(() => {
    loadGamecore()
      .then((m) => {
        setSelfTest(m.selfTest());
        setRealHand(m.runRealHand());
      })
      .catch((e) => {
        setSelfTest(`ERROR: ${e.message ?? e}`);
        setRealHand("skipped");
      });
  }, []);

  const testSign = async () => {
    setSignResult("signing…");
    try {
      const res = await new InExtensionMessageRequester().sendMessage(
        BACKGROUND_PORT,
        new BitpokerSignPayloadMsg(
          POKER_CHAIN_ID,
          "bitpoker-relay-client-hello-v1\npoker-dev-page-test"
        )
      );
      setSignResult(`OK ${res.signature.length / 2} bytes: ${res.signature}`);
    } catch (e: any) {
      setSignResult(`ERROR: ${e.message ?? e}`);
    }
  };

  const statusStyle = (s: string) =>
    s.startsWith("OK") ? styles.ok : s.startsWith("running") ? {} : styles.err;

  return (
    <div style={styles.page}>
      <h1>BitPoker integration self-test</h1>
      <div style={styles.block}>
        <b>gamecore.wasm selfTest()</b>
        <div style={statusStyle(selfTest)}>{selfTest}</div>
      </div>
      <div style={styles.block}>
        <b>runRealHand()</b>
        <div style={statusStyle(realHand)}>{realHand}</div>
      </div>
      <div style={styles.block}>
        <b>background raw sign ({POKER_CHAIN_ID})</b>
        <div>
          <button onClick={testSign}>Sign test payload</button>
          {" requires an unlocked wallet with an account"}
        </div>
        {signResult ? (
          <div style={statusStyle(signResult)}>{signResult}</div>
        ) : null}
      </div>
    </div>
  );
};

const container = document.getElementById("app");
if (container) {
  createRoot(container).render(<PokerDevPage />);
}
