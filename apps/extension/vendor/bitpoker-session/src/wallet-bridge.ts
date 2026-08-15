// The only seam between the poker session logic and whatever holds the
// account key.
//
// Everything else in this package is transport and game state — it never
// touches a key, a signature or a chain transaction directly, it asks a
// bridge. Two implementations exist:
//
//   - ExtensionWalletBridge (keplr-wallet/apps/extension/src/wallet-bridge-extension.ts)
//     talks to the Keplr background service over the router, so the key stays
//     in the background realm and the raw signer keeps its domain-prefix
//     allowlist.
//   - BrowserKeyBridge (webapp/src/wallet/) holds the key in page memory. That
//     is strictly weaker and is why the web client is testnet-only; see
//     docs/webapp-threat-model.md.
//
// Keep this interface semantic, not raw: callers ask for "open an intent" or
// "submit this result", never "sign these bytes for me" (signPayload is the
// one exception and it is fenced by the bitpoker- domain prefixes on both
// sides). That property is what lets a bridge live behind a process or origin
// boundary later without redesigning every call site.

export interface PokerAccountKey {
  bech32Address: string;
  pubkeyHex: string;
}

export interface PokerTxResult {
  txHash: string;
  code: number;
  rawLog: string;
}

export interface OpenIntentArgs {
  // pokerchain GameType enum: TH = 3, ZJH = 2.
  gameType: number;
  minStake: string;
  maxStake: string;
  // "" = open matchmaking; a bech32 address = private challenge.
  opponent: string;
  playerSessionPubkey: string;
  playerTransportPubkey: string;
}

export interface SubmitResultArgs {
  sessionId: string;
  winner: string;
  loser: string;
  finalStake: string;
  transcriptHash: string;
  resultSignature: string;
  splitPot: boolean;
  playerAAmount: string;
  playerBAmount: string;
}

export interface SubmitEvidenceArgs {
  sessionId: string;
  evidenceHash: string;
  payloadHex: string;
  signature: string;
  reason: string;
}

export interface SubmitSecretArgs {
  sessionId: string;
  secretKeyHex: string;
  pubkeyHex: string;
}

export interface PokerWalletBridge {
  // Bech32 address + compressed pubkey of the account playing on chainId.
  getKey(chainId: string): Promise<PokerAccountKey>;

  // Raw secp256k1 signature over sha256(payload), returned as
  // compressed_pubkey(33) || r(32) || s(32) in hex — the 97-byte layout the
  // relay's cosmos-signature-v1 verifier and the chain's evidence check
  // expect. payload MUST carry one of the bitpoker- domain prefixes;
  // implementations reject anything else so this can never be repurposed into
  // a general-purpose signer.
  signPayload(chainId: string, payload: string): Promise<{ signature: string }>;

  // The only fund-locking transaction in the session flow: a matched intent
  // escrows the stake, so implementations gate it behind a user approval.
  openIntent(chainId: string, args: OpenIntentArgs): Promise<PokerTxResult>;

  // The remaining three release or defend escrow that is already at stake and
  // run inside the protocol's frame-timeout / dispute-deadline windows, so
  // they are signed without an interactive prompt by design.
  submitResult(chainId: string, args: SubmitResultArgs): Promise<PokerTxResult>;
  submitEvidence(
    chainId: string,
    args: SubmitEvidenceArgs
  ): Promise<PokerTxResult>;
  submitSecret(chainId: string, args: SubmitSecretArgs): Promise<PokerTxResult>;
}
