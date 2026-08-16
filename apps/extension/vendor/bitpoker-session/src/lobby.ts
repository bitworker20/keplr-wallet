// On-chain lobby data: open game intents + spendable balance, read straight
// from the pokerchain LCD as JSON (no protobuf involved). Pure functions so
// the filtering rules are unit-testable; the React side only renders.

export interface ChainGameIntent {
  intent_id: string;
  creator: string;
  opponent: string;
  // Proto3 JSON enum name, e.g. "GAME_TYPE_TH" | "GAME_TYPE_ZJH".
  game_type: string;
  // uchip, uint64-as-string.
  min_stake: string;
  max_stake: string;
  status: string;
  player_session_pubkey: string;
  matched_session_id: string;
  // Block height after which the chain refuses to match this offer. "0" (or
  // absent, on an older chain) means it never expires.
  expires_at_height?: string;
}

// "GAME_TYPE_TH" -> "TH" (local game name used by the controller/worker).
export function localGameName(chainGameType: string): "TH" | "ZJH" | undefined {
  if (chainGameType === "GAME_TYPE_TH" || chainGameType === "3") {
    return "TH";
  }
  if (chainGameType === "GAME_TYPE_ZJH" || chainGameType === "2") {
    return "ZJH";
  }
  return undefined;
}

// GameIntentStatus.GAME_INTENT_STATUS_PENDING. Sent as the NUMBER, not the
// name: pokerchaind's grpc-gateway parses enum query parameters with
// strconv.ParseInt, so `?status=GAME_INTENT_STATUS_PENDING` comes back 400
// ("invalid syntax") and the lobby stays empty with an error nobody reads as
// "wrong query parameter". Responses still spell the enum out, which is what
// isPending below re-checks.
const INTENT_STATUS_PENDING = 1;
const INTENT_STATUS_PENDING_NAME = "GAME_INTENT_STATUS_PENDING";

export async function fetchOpenIntents(
  lcdUrl: string
): Promise<ChainGameIntent[]> {
  const res = await fetch(
    `${lcdUrl}/pokerchain/pokerchain/v1/intents?status=${INTENT_STATUS_PENDING}`
  );
  if (!res.ok) {
    throw new Error(`LCD intents query: ${res.status}`);
  }
  const json = await res.json();
  return (json.intents ?? []) as ChainGameIntent[];
}

// Belt and braces on the query parameter above: an intent that is already
// matched must never be offered as joinable, whatever the gateway did with
// the filter.
export function isPendingIntent(intent: ChainGameIntent): boolean {
  return (
    intent.status === undefined ||
    intent.status === "" ||
    intent.status === INTENT_STATUS_PENDING_NAME ||
    intent.status === String(INTENT_STATUS_PENDING)
  );
}

// An offer the chain will no longer match. Expired intents stay PENDING in
// state — nothing sweeps them — so a lobby that shows every PENDING intent
// offers games that cannot happen, and joining one costs a transaction fee
// for a mirrored intent that can never be matched.
export function intentExpired(
  intent: ChainGameIntent,
  chainHeight: number
): boolean {
  const expiresAt = Number(intent.expires_at_height ?? "0");
  return expiresAt > 0 && chainHeight > 0 && chainHeight >= expiresAt;
}

// Which pending intents can `me` join? Mirrors the native lobby filter
// (ChainSessionRestClient::queryMatchableGameIntents): not my own intent,
// playable game, not expired, and either open to anyone or aimed at me.
//
// chainHeight of 0 means "unknown" — the height query failed — and skips the
// expiry check rather than emptying the lobby over it, the same choice the
// native client makes.
export function joinableIntents(
  all: ChainGameIntent[],
  me: string,
  chainHeight = 0
): ChainGameIntent[] {
  return all.filter((intent) => {
    if (!isPendingIntent(intent)) {
      return false;
    }
    if (intentExpired(intent, chainHeight)) {
      return false;
    }
    if (intent.creator === me) {
      return false;
    }
    if (localGameName(intent.game_type) === undefined) {
      return false;
    }
    if (
      intent.opponent &&
      intent.opponent !== "ANY" &&
      intent.opponent !== me
    ) {
      return false;
    }
    return true;
  });
}

// The chain's current height, or 0 when the node will not say. Used to hide
// expired offers; a lobby is not worth failing over.
export async function fetchChainHeight(lcdUrl: string): Promise<number> {
  try {
    const res = await fetch(
      `${lcdUrl}/cosmos/base/tendermint/v1beta1/blocks/latest`
    );
    if (!res.ok) {
      return 0;
    }
    const json = await res.json();
    return Number(json?.block?.header?.height ?? 0) || 0;
  } catch {
    return 0;
  }
}

// The wallet's spendable uchip balance as a uint64-as-string ("0" when the
// account is empty or unfunded).
export async function fetchUchipBalance(
  lcdUrl: string,
  address: string
): Promise<string> {
  const res = await fetch(`${lcdUrl}/cosmos/bank/v1beta1/balances/${address}`);
  if (!res.ok) {
    throw new Error(`LCD balance query: ${res.status}`);
  }
  const json = await res.json();
  const balances: { denom: string; amount: string }[] = json.balances ?? [];
  return balances.find((b) => b.denom === "uchip")?.amount ?? "0";
}
