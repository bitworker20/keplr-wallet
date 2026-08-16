// The per-hand session identity, kept where a reload can still find it.
//
// Every intent commits a FiatShamir public key; the matching secret lives in
// the gamecore's heap and dies with the tab. That is fine right up to the
// moment the session ends up DISPUTED, because adjudication decrypts each
// player's cards with the secret they disclosed on chain — and scores a seat
// that never disclosed one as having forfeited the hand. A player who closed
// the tab (or whose browser crashed, which is why the session is disputed in
// the first place) would therefore lose a hand they had won.
//
// So the identity is written down at intent time and kept until it is spent.
// The native client does exactly this in the profile JSON
// (client/session_recovery.cpp reveals from profile.sessionSecretKey); this is
// the browser's version of the same drawer.
//
// What is stored is a per-hand game key, not the account key: it decrypts that
// hand's cards and nothing else, it is worthless once the hand is over, and
// the reveal publishes it on chain anyway. It is still deleted as soon as it
// is spent or stale — see forget() and prune() — and on this origin the
// account key is in page memory regardless (docs/webapp-threat-model.md).

const STORAGE_KEY = "bitpoker.session-identity.v1";

// Records outlive their session by a wide margin (a dispute deadline is hours,
// not days) but must not accumulate forever on a shared browser.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionIdentity {
  // The intent that committed this pubkey. The session is keyed by intent
  // because that is the link the chain records — GameSession carries
  // player_a_intent_id / player_b_intent_id, and MsgSubmitSessionSecret is
  // checked against the pubkey in the matching intent.
  intentId: string;
  secretKeyHex: string;
  pubkeyHex: string;
  savedAt: number;
}

type Vault = Record<string, SessionIdentity>;

// Storage may be absent (SSR, a worker) or refuse to work (private mode with a
// full quota, a page with storage disabled). None of that is worth an
// exception in the middle of opening a game: the player loses the ability to
// reveal later, not the ability to play now.
function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function read(): Vault {
  const store = storage();
  if (!store) {
    return {};
  }
  try {
    const raw = store.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Vault) : {};
  } catch {
    return {};
  }
}

function write(vault: Vault): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(vault));
  } catch {
    // Out of quota or blocked; nothing useful to do here.
  }
}

export function rememberSessionIdentity(
  identity: Omit<SessionIdentity, "savedAt">
): void {
  const vault = pruned(read());
  vault[identity.intentId] = { ...identity, savedAt: Date.now() };
  write(vault);
}

export function sessionIdentityForIntent(
  intentId: string
): SessionIdentity | undefined {
  return read()[intentId];
}

// Called once the secret is on chain (it is public now, and the next intent
// commits a fresh one) or once the session can no longer be disputed.
export function forgetSessionIdentity(intentId: string): void {
  const vault = read();
  if (!(intentId in vault)) {
    return;
  }
  delete vault[intentId];
  write(pruned(vault));
}

export function pruneSessionIdentities(): void {
  write(pruned(read()));
}

function pruned(vault: Vault): Vault {
  const cutoff = Date.now() - MAX_AGE_MS;
  const out: Vault = {};
  for (const [intentId, identity] of Object.entries(vault)) {
    if (identity && identity.savedAt >= cutoff) {
      out[intentId] = identity;
    }
  }
  return out;
}
