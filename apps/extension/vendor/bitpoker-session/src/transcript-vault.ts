// The transcript of a hand this seat already filed a result for.
//
// Filing a result does not end a session: until the chain says SETTLED, the
// opponent can file a contradicting one, and the chain then decides the hand
// from whichever transcript reaches it (ADR-003). Nothing else counts — not the
// signed result already on chain, not who filed first.
//
// The burden therefore falls on the seat least likely to still be there.
// Session 40 on the private testnet is the shape: player B won the hand, filed
// a signed result, and left; twenty-five blocks later player A filed a
// split-pot abort over it and turned an empty dispute into a full refund of a
// hand it had lost. B's transcript would have settled it — and in a browser
// that transcript lives in the gamecore worker's heap, which dies with the tab.
//
// So it is written down at the moment the result is filed, signed while the
// wallet is still there to sign it, and kept until the session is terminal.
// This is the browser's half of client/transcript_vault.hpp; the drawer beside
// session-vault.ts, holding proof rather than a key.
//
// What is stored is not secret. It is the same bytes this client would have
// published on chain during a mid-hand dispute, and every message inside is
// already signed by whoever sent it.

const STORAGE_KEY = "bitpoker.session-transcript.v1";

// Records outlive their session by a wide margin — a dispute window is hours —
// but must not accumulate forever on a shared browser.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// localStorage is a few megabytes for the whole origin, and one transcript is
// tens of kilobytes of hex in the normal case. Both caps exist so a pathological
// hand cannot evict the wallet's own state: a payload past the per-record cap is
// not stored at all (and says so), and only the newest few records are kept.
const MAX_PAYLOAD_HEX_CHARS = 1_000_000; // ~500 KB of payload
const MAX_RECORDS = 3;

export interface KeptTranscript {
  sessionId: string;
  // The account that filed the result this transcript proves. Stored so a
  // browser shared by two accounts never offers one seat's proof to the other.
  submitter: string;
  payloadHex: string;
  evidenceHash: string;
  // The application-level attestation MsgSubmitSessionEvidence carries. Signed
  // when the transcript is stored, because that is when the wallet is
  // unquestionably available; a recovery card days later may be able to send
  // transactions without being able to produce this signature again.
  signature: string;
  reason: string;
  savedAt: number;
}

type Vault = Record<string, KeptTranscript>;

// Storage may be absent (SSR, a worker) or refuse to work (private mode, a page
// with storage disabled). None of that is worth an exception in the middle of
// settling a hand: the player loses the ability to defend this result later,
// not the ability to finish playing.
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

function write(vault: Vault): boolean {
  const store = storage();
  if (!store) {
    return false;
  }
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(vault));
    return true;
  } catch {
    return false;
  }
}

// Newest first, dropped by age and then by count. `protect` is never dropped:
// two transcripts written in the same millisecond tie on savedAt, and the one
// that must survive that tie is the one being written now — it belongs to the
// session that is still live, while the others have probably settled.
function pruned(vault: Vault, protect?: string): Vault {
  const cutoff = Date.now() - MAX_AGE_MS;
  const out: Vault = {};
  let room = MAX_RECORDS;
  if (protect && vault[protect]) {
    out[protect] = vault[protect];
    room -= 1;
  }
  const rest = Object.values(vault)
    .filter(
      (record) =>
        record &&
        record.sessionId &&
        record.sessionId !== protect &&
        record.savedAt >= cutoff
    )
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, Math.max(room, 0));
  for (const record of rest) {
    out[record.sessionId] = record;
  }
  return out;
}

// Store the transcript for a session. Returns false when it could not be kept —
// worth surfacing, because it is exactly the difference between defending a
// disputed result and watching it refunded.
export function rememberTranscript(
  transcript: Omit<KeptTranscript, "savedAt">
): boolean {
  if (
    !transcript.sessionId ||
    !transcript.payloadHex ||
    !transcript.evidenceHash
  ) {
    return false;
  }
  if (transcript.payloadHex.length > MAX_PAYLOAD_HEX_CHARS) {
    return false;
  }
  const record: KeptTranscript = { ...transcript, savedAt: Date.now() };
  const vault = read();
  vault[record.sessionId] = record;
  if (write(pruned(vault, record.sessionId))) {
    return true;
  }
  // Out of quota: give up everything older and try once with this record alone.
  // A transcript for the session that is live now is worth more than three for
  // sessions that have probably settled.
  return write({ [record.sessionId]: record });
}

// The transcript this account can use to defend a session, if there is one. The
// submitter check is what keeps a shared browser from offering one seat's proof
// under the other seat's address, which the chain would refuse anyway.
export function transcriptForSession(
  sessionId: string,
  submitter?: string
): KeptTranscript | undefined {
  const record = read()[sessionId];
  if (!record) {
    return undefined;
  }
  if (submitter && record.submitter && record.submitter !== submitter) {
    return undefined;
  }
  return record;
}

// Called once the session can no longer be disputed (SETTLED/CANCELLED), or
// once this transcript is on chain and does not need keeping twice.
export function forgetTranscript(sessionId: string): void {
  const vault = read();
  if (!(sessionId in vault)) {
    return;
  }
  delete vault[sessionId];
  write(pruned(vault));
}

export function pruneTranscripts(): void {
  write(pruned(read()));
}
