// Entry point for the extension's poker page (chrome-extension://<id>/poker.html).
//
// The page itself is not in this repo any more: it lives in the monorepo's
// webapp/src/poker and is shared verbatim with the standalone web client, so
// a fix to the controller, the relay client or a table lands in both at once.
// Webpack resolves the @bitpoker/poker-core alias to that directory (see
// webpack.config.js), and tsconfig mirrors the alias for typecheck.
//
// Everything host-specific stays here: mounting, the chain the page plays on,
// and — the part that matters — which wallet bridge the page gets. This entry
// hands it ExtensionWalletBridge, so the key stays in the background realm
// behind the router boundary. The web client hands it a bridge that holds the
// key in page memory, which is why that client is testnet-only.
import React from "react";
import { createRoot } from "react-dom/client";
import { PokerPage } from "@bitpoker/poker-core/page";
import { ExtensionWalletBridge } from "./wallet-bridge-extension";

const POKER_CHAIN_ID = "pokerchain-testnet-1";

const container = document.getElementById("app");
if (container) {
  createRoot(container).render(
    <PokerPage wallet={new ExtensionWalletBridge()} chainId={POKER_CHAIN_ID} />
  );
}
