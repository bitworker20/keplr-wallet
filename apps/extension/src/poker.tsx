// Entry point for the extension's poker page (chrome-extension://<id>/poker.html).
//
// The page is this extension's own (src/poker/). What it shares with the
// standalone BitPoker web client is @bitpoker/poker-session — relay transport,
// the gamecore worker, the hand state machine — vendored under
// vendor/bitpoker-session/, so the protocol stays identical while the two UIs
// are free to look nothing alike.
//
// Everything host-specific stays here: mounting, the chain the page plays on,
// and — the part that matters — which wallet bridge the page gets. This entry
// hands it ExtensionWalletBridge, so the key stays in the background realm
// behind the router boundary. The web client hands it a bridge that holds the
// key in page memory, which is why that client is testnet-only.
import React from "react";
import { createRoot } from "react-dom/client";
import { PokerPage } from "./poker/page";
import { ExtensionWalletBridge } from "./wallet-bridge-extension";

const POKER_CHAIN_ID = "pokerchain-testnet-1";

const container = document.getElementById("app");
if (container) {
  createRoot(container).render(
    <PokerPage wallet={new ExtensionWalletBridge()} chainId={POKER_CHAIN_ID} />
  );
}
