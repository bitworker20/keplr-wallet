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

export async function fetchOpenIntents(
  lcdUrl: string
): Promise<ChainGameIntent[]> {
  const res = await fetch(
    `${lcdUrl}/pokerchain/pokerchain/v1/intents?status=GAME_INTENT_STATUS_PENDING`
  );
  if (!res.ok) {
    throw new Error(`LCD intents query: ${res.status}`);
  }
  const json = await res.json();
  return (json.intents ?? []) as ChainGameIntent[];
}

// Which pending intents can `me` join? Mirrors the native/Qt lobby filter:
// not my own intent, playable game, and either open to anyone or aimed at me.
export function joinableIntents(
  all: ChainGameIntent[],
  me: string
): ChainGameIntent[] {
  return all.filter((intent) => {
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
